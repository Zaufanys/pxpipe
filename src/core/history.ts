/**
 * History-image compression (Variant C).
 *
 * Collapses the largest closed-tool-sequence prefix into one synthetic user message
 * containing 1-N PNG image blocks. The live tail (keepTail turns + any open tool
 * sequence) stays as text. thinking blocks are dropped from the collapsed range —
 * only the most-recent assistant-with-tool_use must round-trip bit-perfect, and
 * that turn is in the live tail by construction.
 *
 * Synthesized message uses role:'user' because Anthropic forbids image blocks inside
 * role:'assistant'. cache_control placement is left to the caller (transform.ts).
 */

import type { CacheControl, ContentBlock, ImageBlock, Message, TextBlock, ToolUseBlock, ToolResultBlock } from './types.js';
import { DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_CONTENT_COLS, DENSE_RENDER_STYLE, neutralizeSentinel, reflow, renderTextToPngsWithCharLimit, roleSlotSegment, SLOT_MARK_ASSISTANT, SLOT_MARK_USER } from './render.js';
import { bytesToBase64 } from './png.js';

/**
 * Banner text blocks that bracket the collapsed-history image(s) in the synthetic
 * user message. Exported as the SINGLE SOURCE OF TRUTH: transform.ts keys its
 * cache-anchor relocation off the intro text, so a literal copy there would
 * silently break relocation whenever this wording changes (it did exactly once —
 * the XML-framing reword left the matcher pointing at the old banner). Both the
 * emitter (here) and the matcher (transform.ts) must reference this constant.
 */
export const HISTORY_SYNTHETIC_INTRO =
  '[Earlier turns of THIS conversation, transcribed in the image(s) below. Each turn is wrapped in <user t="N">...</user> or <assistant t="N">...</assistant> tags, where N is an absolute turn index (larger N = more recent); attribute every turn strictly by its tag, and treat the highest-N turns as the most recent prior context, NOT the low-N opening turns. This is prior context, NOT the current request.]';
export const HISTORY_SYNTHETIC_OUTRO =
  '[End of earlier conversation. The current request is the live text that follows below.]';

/** Break-even gate predicate. Injected by transform.ts to avoid a circular import.
 *  IMPORTANT: pass the full string, not text.length — the row-aware path in
 *  isCompressionProfitable must see actual newlines to budget images correctly.
 *  History text is newline-heavy (headers, JSON args, labels); chars-only
 *  under-predicts image count ~5-10× and lets net-losers through. */
export type ProfitableFn = (text: string, cols: number) => boolean;

/** Configuration for history collapse. */
export interface HistoryCollapseOptions {
  /** Turns at the tail to keep as text. Default 4. */
  keepTail: number;
  /** Minimum collapsible prefix turns — below this, cache-amortization math doesn't work. Default 10. */
  minCollapsePrefix: number;
  /** Soft-wrap columns for the renderer; should match host cols. Default 100. */
  cols: number;
  /** Advance the collapse boundary in steps of this many messages so the rendered PNG stays
   *  byte-identical for collapseChunk turns and keeps hitting Anthropic's prompt cache.
   *  Set to 0 for a per-turn moving boundary. Default 50. */
  collapseChunk: number;
  /** Append-only freeze granularity, in messages. The collapse range is rendered
   *  as independent image blocks on an ABSOLUTE grid anchored at protectedPrefix,
   *  in steps of this many messages. Each completed chunk's bytes are fixed by its
   *  message range alone, so old chunks stay byte-identical (cache_read forever) as
   *  the conversation grows — only the newest partial chunk re-renders. Caller
   *  cache_control marks force an extra split so a roaming breakpoint stays an
   *  aligned, independently-cacheable image boundary. Set to 0 to render the whole
   *  range as one paginated blob (legacy, non-append-only). Default 10. */
  freezeChunk: number;
  /** Leading messages to never collapse. Protects the slab-bearing first user message
   *  (system-prompt + tool-docs images) so its cache_control anchor stays at the front
   *  and isn't swept into the history image as [image] placeholders. Default 0. */
  protectedPrefix: number;
  /** Reflow the transcript before RENDERING: pack soft-wrapped lines and mark
   *  every hard newline with the ↵ sentinel — same treatment as the static slab.
   *  History text is newline-heavy (role headers, JSON args), so without this
   *  each short line wastes a full render row, inflating image count and shrinking
   *  the savings. Glyph size is unchanged (cols stays the same) so legibility is
   *  identical — it just removes the blank-row waste. `collapsedChars` still
   *  reports the ORIGINAL transcript length. Default true. */
  reflow: boolean;
}

export const HISTORY_DEFAULTS: HistoryCollapseOptions = {
  keepTail: 4,
  minCollapsePrefix: 10,
  cols: 100,
  collapseChunk: 50,
  freezeChunk: 10,
  protectedPrefix: 0,
  reflow: true,
};

/** Per-request telemetry surfaced back to TransformInfo. */
export interface HistoryCollapseInfo {
  /** Number of turns collapsed into the history image. */
  collapsedTurns: number;
  /** Total chars of text that went into the history image. */
  collapsedChars: number;
  /** Number of PNG image blocks emitted for the history (≥1 if collapsed). */
  collapsedImages: number;
  /** Total PNG bytes emitted. */
  collapsedImageBytes: number;
  /** Total pixel area (Σ width×height) — pairs with cache_create tokens for px/token regression. */
  collapsedImagePixels: number;
  /** Raw PNG bytes of each emitted history image, in order. Lets the caller register
   *  them into the dashboard image ring (info.imagePngs) so colored history frames are
   *  visible, not merely counted — every other image path already feeds the ring. */
  collapsedPngs: Uint8Array[];
  /** Per-image pixel dims, parallel to collapsedPngs. The dashboard ring reads
   *  info.imageDims in lockstep with info.imagePngs, so these must be pushed together. */
  collapsedImageDims: { width: number; height: number }[];
  /** Why we didn't collapse — populated only when no collapse happened. */
  reason?:
    | 'no_history'
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'not_profitable'
    | 'render_empty';
  /** Dropped codepoints from the history render, merged into the
   *  transform-wide map by the caller. */
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}


/**
 * Return the last index ≤ cutoffExclusive at which all tool_use_ids are matched
 * by tool_results in [0..i]. Returns -1 if no closed boundary exists.
 * Robust to interleaved/parallel tool calls via openSet tracking.
 */
export function findClosedPrefixBoundary(
  messages: Message[],
  cutoffExclusive: number,
): number {
  if (cutoffExclusive <= 0) return -1;
  const openSet = new Set<string>();
  let lastClosed = -1;
  const limit = Math.min(cutoffExclusive, messages.length);
  for (let i = 0; i < limit; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.content)) {
      if (openSet.size === 0) lastClosed = i; // plain string — no tool blocks
      continue;
    }
    if (msg.role === 'assistant') {
      for (const blk of msg.content) {
        if (blk && (blk as ToolUseBlock).type === 'tool_use') {
          const id = (blk as ToolUseBlock).id;
          if (typeof id === 'string') openSet.add(id);
        }
      }
    } else if (msg.role === 'user') {
      for (const blk of msg.content) {
        if (blk && (blk as ToolResultBlock).type === 'tool_result') {
          const id = (blk as ToolResultBlock).tool_use_id;
          if (typeof id === 'string') openSet.delete(id);
        }
      }
    }
    if (openSet.size === 0) lastClosed = i;
  }
  return lastClosed;
}

/**
 * Linearise content blocks to a single string. Drops thinking blocks (only the
 * most-recent assistant turn needs bit-perfect thinking, and it's in the live tail).
 * Inline images collapse to [image] to avoid double-encoding.
 */
export function blocksToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const blk of content) {
    if (!blk || typeof blk !== 'object') continue;
    const t = (blk as { type?: string }).type;
    switch (t) {
      case 'text':
        parts.push((blk as TextBlock).text);
        break;
      case 'tool_use': {
        const tu = blk as ToolUseBlock;
        // Compact JSON (no indent) — pretty-printing bloats text ~5× and the renderer is row-aware.
        let argsStr: string;
        try {
          argsStr = JSON.stringify(tu.input);
        } catch {
          argsStr = String(tu.input);
        }
        parts.push(`[tool_use ${tu.name}]\n${argsStr}`);
        break;
      }
      case 'tool_result': {
        const tr = blk as ToolResultBlock;
        const inner = tr.content;
        let innerText: string;
        if (typeof inner === 'string') {
          innerText = inner;
        } else if (Array.isArray(inner)) {
          const subParts: string[] = [];
          for (const sub of inner) {
            if (!sub || typeof sub !== 'object') continue;
            if ((sub as TextBlock).type === 'text') {
              subParts.push((sub as TextBlock).text);
            } else if ((sub as ImageBlock).type === 'image') {
              subParts.push('[image]');
            }
          }
          innerText = subParts.join('\n');
        } else {
          innerText = '';
        }
        const errMark = tr.is_error === true ? ' (error)' : '';
        parts.push(`[tool_result${errMark}]\n${innerText}`);
        break;
      }
      case 'image':
        parts.push('[image]');
        break;
      // 'thinking' and any other block type → drop silently.
      default:
        break;
    }
  }
  return parts.join('\n\n');
}

/** Return the caller's cache_control marker on a message, if any block carries one.
 *  Used to align freeze-chunk boundaries to roaming breakpoints so a marked segment
 *  stays independently cacheable instead of being silently flattened into the image. */
export function messageCacheControl(m: Message): CacheControl | undefined {
  if (!Array.isArray(m.content)) return undefined;
  for (let i = m.content.length - 1; i >= 0; i--) {
    const b = m.content[i] as { cache_control?: CacheControl } | undefined;
    if (b && b.cache_control !== undefined) return b.cache_control;
  }
  return undefined;
}

/** Serialize messages [fromInclusive..upToExclusive) to a text blob with
 *  `<role>…</role>` XML wrappers. Open+close tags bracket each turn so a misread
 *  boundary self-corrects and the model attributes speakers reliably even off a
 *  lossy image — bare `--- role ---` start-dividers let one role bleed into the
 *  next when a divider is missed. */
export function messagesToHistoryText(
  messages: Message[],
  upToExclusive: number,
  fromInclusive = 0,
): string {
  return messagesToHistorySegments(messages, upToExclusive, fromInclusive).text;
}

/** Like {@link messagesToHistoryText} but also returns the parallel slot string for
 *  colorByRole: a width-identical copy where each `<role>` tag is replaced by its
 *  role marker and the body is copied verbatim (slot 0). Role attribution is decided
 *  HERE, where the message role is known — never re-parsed out of flattened text.
 *  A tool_result block sits inside its user message and a tool_use block inside its
 *  assistant message, so each is owned by the turn that carries it. */
export function messagesToHistorySegments(
  messages: Message[],
  upToExclusive: number,
  fromInclusive = 0,
): { text: string; slotText: string } {
  const textOut: string[] = [];
  const slotOut: string[] = [];
  for (let i = fromInclusive; i < upToExclusive; i++) {
    const m = messages[i]!;
    const body = blocksToText(m.content);
    if (!body.trim()) continue;
    const isAssistant = m.role === 'assistant';
    const tag = isAssistant ? 'assistant' : 'user';
    const mark = isAssistant ? SLOT_MARK_ASSISTANT : SLOT_MARK_USER;
    // Absolute turn index = message position from conversation start. Gives the model an
    // explicit recency anchor so it can tell turn 1 from turn 60, instead of pattern-matching
    // the most salient turn — primacy was resurrecting the OPENING turn as if it were the live
    // request. MUST stay absolute (never "N ago" or "i/total"): a per-turn value that's stable
    // once the turn closes keeps each frozen chunk byte-identical, so cache_read survives.
    const attr = ` t="${i}"`;
    textOut.push(`<${tag}${attr}>\n${body}\n</${tag}>`);
    slotOut.push(roleSlotSegment(tag, body, mark, attr));
  }
  return { text: textOut.join('\n\n'), slotText: slotOut.join('\n\n') };
}

/**
 * Collapse the closed-prefix run into one synthetic user message with 1+ history images.
 * Returns original messages unchanged on any no-collapse path (reason set in info).
 * Image blocks are returned with NO cache_control — caller decides placement.
 */
export async function collapseHistory(
  messages: Message[],
  isProfitable: ProfitableFn,
  opts: Partial<HistoryCollapseOptions> = {},
): Promise<{ messages: Message[]; info: HistoryCollapseInfo }> {
  const o: HistoryCollapseOptions = { ...HISTORY_DEFAULTS, ...opts };
  const info: HistoryCollapseInfo = {
    collapsedTurns: 0,
    collapsedChars: 0,
    collapsedImages: 0,
    collapsedImageBytes: 0,
    collapsedImagePixels: 0,
    collapsedPngs: [],
    collapsedImageDims: [],
    droppedChars: 0,
    droppedCodepoints: new Map(),
  };
  if (!messages || messages.length === 0) {
    info.reason = 'no_history';
    return { messages: messages ?? [], info };
  }
  // Protected leading messages (slab) pass through untouched; collapse starts after them.
  const protectedPrefix = Math.max(
    0,
    Math.min(o.protectedPrefix ?? 0, messages.length),
  );
  // Snap the cutoff to a collapseChunk grid so the rendered PNG stays byte-identical
  // across turns and keeps hitting Anthropic's prompt cache. See docs/HISTORY_CACHE_MODEL.md.
  // Floor at minCollapsePrefix + protectedPrefix so short histories still collapse.
  const rawCutoff = messages.length - o.keepTail;
  const cutoff =
    o.collapseChunk > 0
      ? Math.min(
          rawCutoff,
          Math.max(
            o.minCollapsePrefix + protectedPrefix,
            Math.floor(rawCutoff / o.collapseChunk) * o.collapseChunk,
          ),
        )
      : rawCutoff;
  const boundary = findClosedPrefixBoundary(messages, cutoff);
  if (boundary < 0) {
    info.reason = 'no_closed_prefix';
    return { messages, info };
  }
  // Need at least minCollapsePrefix turns in [protectedPrefix..boundary] — collapsing
  // 2-3 turns is net cost (cache-amortization math doesn't work at small scale).
  const collapseLen = boundary + 1;
  if (collapseLen - protectedPrefix < o.minCollapsePrefix) {
    info.reason = 'prefix_too_short';
    return { messages, info };
  }
  // Exclude slab messages (protectedPrefix) from serialization.
  const text = messagesToHistoryText(messages, collapseLen, protectedPrefix);
  if (!text || text.length === 0) {
    info.reason = 'render_empty';
    return { messages, info };
  }
  // Reflow for RENDERING ONLY: pack short lines + mark hard breaks with ↵ so the
  // newline-heavy transcript fills full rows instead of one line per row. Same
  // glyph size (cols unchanged) → identical legibility, fewer images, more saved.
  // `text` stays original — it backs `collapsedChars` and the cache byte-stability.
  const safeText = neutralizeSentinel(text);
  const renderText = o.reflow ? reflow(safeText) ?? safeText : text;
  if (!isProfitable(renderText, o.cols)) { // pass string, not length — see ProfitableFn
    info.reason = 'not_profitable';
    info.collapsedChars = text.length; // surface what we DIDN'T compress
    return { messages, info };
  }
  // APPEND-ONLY rendering. Render the collapse range [protectedPrefix..collapseLen)
  // as independent image blocks on an ABSOLUTE message grid anchored at
  // protectedPrefix (step = freezeChunk). A completed chunk's bytes are fixed by
  // its message range alone, so old chunks stay byte-identical as the conversation
  // grows (cache_read forever); only the newest partial chunk re-renders.
  //
  // Chunk-end positions = the absolute grid ∪ caller cache_control marks: a marked
  // message forces a split right after it, and that chunk's LAST image carries the
  // caller's marker — so a roaming breakpoint survives as an aligned, independently
  // cacheable image boundary instead of being silently flattened (count conserved,
  // never added). Each chunk is reflowed and rendered on its own, which is what
  // makes the bytes a pure function of the chunk's messages.
  const step = o.freezeChunk > 0 ? o.freezeChunk : collapseLen - protectedPrefix;
  const ends = new Set<number>();
  for (let e = protectedPrefix + step; e < collapseLen; e += step) ends.add(e);
  const markerByEnd = new Map<number, CacheControl>();
  for (let i = protectedPrefix; i < collapseLen; i++) {
    const cc = messageCacheControl(messages[i]!);
    if (cc !== undefined) {
      ends.add(i + 1);
      markerByEnd.set(i + 1, cc);
    }
  }
  ends.add(collapseLen);
  const sortedEnds = [...ends].filter((e) => e > protectedPrefix && e <= collapseLen).sort((a, b) => a - b);

  const imageBlocks: Array<ImageBlock & { cache_control?: CacheControl }> = [];
  let chunkStart = protectedPrefix;
  for (const chunkEnd of sortedEnds) {
    const seg = messagesToHistorySegments(messages, chunkEnd, chunkStart);
    chunkStart = chunkEnd;
    if (!seg.text || seg.text.length === 0) continue;
    // Reflow the text and its parallel slot string in lockstep so role attribution
    // stays codepoint-aligned with the rendered text. The two have identical newline
    // structure (slot bodies are verbatim copies), so minify/reflow mutate them the
    // same way; reflow() only bails on a ↵ collision, which hits both identically.
    let chunkRender = seg.text;
    let chunkSlot = seg.slotText;
    if (o.reflow) {
      // Neutralize pre-existing ↵ first (1:1 swap at identical positions in text+slot, so
      // they stay codepoint-aligned) — otherwise reflow bails and the chunk renders raw,
      // unpacked. This conversation's transcript literally contains ↵, which would defeat
      // packing on exactly the long sessions where collapse matters most.
      const safeText = neutralizeSentinel(seg.text);
      const safeSlot = neutralizeSentinel(seg.slotText);
      const rt = reflow(safeText);
      const rs = reflow(safeSlot);
      if (rt !== null && rs !== null) {
        chunkRender = rt;
        chunkSlot = rs;
      } else {
        chunkRender = safeText;
        chunkSlot = safeSlot;
      }
    }
    // Use the dense readable profile (not full-canvas) to keep code/config legible.
    // colorByRole tints the structural <role> tags so turn boundaries are scannable
    // in the history image; it's token-free (vision cost is by pixel dims, not PNG
    // byte depth) and carries the serialize-time slot string instead of re-parsing.
    const imgs = await renderTextToPngsWithCharLimit(
      chunkRender,
      DENSE_CONTENT_COLS,
      DENSE_CONTENT_CHARS_PER_IMAGE,
      { ...DENSE_RENDER_STYLE, colorByRole: true },
      undefined,
      chunkSlot,
    );
    const markerCC = markerByEnd.get(chunkEnd);
    for (let k = 0; k < imgs.length; k++) {
      const img = imgs[k]!;
      const block: ImageBlock & { cache_control?: CacheControl } = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: bytesToBase64(img.png),
        },
      };
      // Mark the LAST image of a marked segment — the caller's breakpoint anchor.
      if (markerCC !== undefined && k === imgs.length - 1) block.cache_control = markerCC;
      imageBlocks.push(block);
      info.collapsedImageBytes += img.png.length;
      info.collapsedImagePixels += img.width * img.height;
      info.collapsedPngs.push(img.png);
      info.collapsedImageDims.push({ width: img.width, height: img.height });
      info.droppedChars += img.droppedChars;
      for (const [cp, n] of img.droppedCodepoints) {
        info.droppedCodepoints.set(cp, (info.droppedCodepoints.get(cp) ?? 0) + n);
      }
    }
  }
  if (imageBlocks.length === 0) {
    info.reason = 'render_empty';
    return { messages, info };
  }
  const syntheticContent: ContentBlock[] = [
    { type: 'text', text: HISTORY_SYNTHETIC_INTRO },
    ...imageBlocks,
    { type: 'text', text: HISTORY_SYNTHETIC_OUTRO },
  ];
  const syntheticUser: Message = {
    role: 'user',
    content: syntheticContent,
  };
  const head = messages.slice(0, protectedPrefix);
  const tail = messages.slice(collapseLen);
  info.collapsedTurns = collapseLen - protectedPrefix;
  info.collapsedChars = text.length;
  info.collapsedImages = imageBlocks.length;
  // [slab, history image, live tail] — slab cache_control anchor stays at the front.
  return { messages: [...head, syntheticUser, ...tail], info };
}
