/**
 * GPT history-image compression.
 *
 * The static system+tool slab is small (~30k chars); the bulk of a GPT agent
 * request is the conversation transcript, which OpenCode resends in full every
 * turn — the Responses API is driven statelessly here (no `previous_response_id`),
 * so turns 1..N-1 are re-sent as plain text on turn N. pxpipe collapses the OLD
 * closed-tool-call prefix of that transcript into 1-N PNG images and keeps the
 * recent tail as text.
 *
 * OpenAI prompt-caching is automatic and prefix-based: no `cache_control`
 * breakpoints, no 1.25× write premium, cached reads at ~0.1×. The collapse
 * boundary is snapped to a chunk grid so the history image stays byte-identical
 * across turns and keeps hitting that automatic cache (the same flap-avoidance
 * trick src/core/history.ts uses for Anthropic).
 *
 * This mirrors src/core/history.ts but operates on Responses `input` items and
 * Chat `messages` rather than Anthropic Message blocks. The two formats differ
 * enough (function_call/function_call_output vs tool_calls/tool role) that a
 * shared block type isn't worth it; instead each format is lowered to a common
 * HistoryTurn list and the planner/renderer are shared.
 */

import { renderTextToPngs, reflow, neutralizeSentinel, MAX_HEIGHT_PX, type RenderedImage } from './render.js';
import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** Portrait-strip width for GPT history images. Mirrors GPT_STRIP_COLS in
 *  openai.ts (kept local to avoid a circular import): ≤768px wide so OpenAI
 *  doesn't downscale dense text below its OCR-legibility floor. The 384-col
 *  Anthropic dense profile would be scaled to fit OpenAI's 768px box and become
 *  illegible — that profile is Anthropic-only. */
const GPT_HISTORY_COLS = 152;

/** Break-even gate predicate, injected to avoid a circular import with openai.ts.
 *  Receives the full string (not length) so the renderer's row-aware image-count
 *  estimate sees real newlines — history text is newline-heavy. */
export type GptProfitableFn = (text: string, cols: number) => boolean;

export interface GptHistoryOptions {
  /** Trailing items kept as live text (never collapsed). */
  keepTail: number;
  /** Minimum collapsible items in [protectedPrefix..boundary]; below this the
   *  cache-amortization math doesn't pay (imaging a tiny prefix is net cost). */
  minCollapsePrefix: number;
  /** Minimum collapsed-text size in o200k TOKENS (not chars). OpenAI caches the
   *  text transcript at ~0.1× already and bills images by vision tokens, so the
   *  break-even is a token comparison — 8000 chars of dense JSON tokenizes very
   *  differently from 8000 chars of prose. Below this, imaging a tiny prefix is
   *  net cost. */
  minCollapseTokens: number;
  /** Soft-wrap columns for the dense renderer. */
  cols: number;
  /** Advance the collapse boundary in steps of this many items so the rendered
   *  PNG stays byte-identical across turns and keeps hitting the prompt cache.
   *  0 = per-item moving boundary (cache-hostile; tests only). */
  collapseChunk: number;
  /** Render the collapse range as independent image chunks of this many turns on
   *  an ABSOLUTE grid anchored at protectedPrefix. A completed chunk's bytes are
   *  fixed by its turn range alone, so old chunks stay byte-identical (cache_read
   *  forever) as the conversation grows — only the newest partial chunk
   *  re-renders. 0 = render the whole range as one blob (legacy, non-append-only). */
  freezeChunk: number;
  /** Target size of one frozen image SECTION, in o200k tokens. The collapse range
   *  is cut into sections by walking turns from protectedPrefix and sealing a
   *  section each time its cumulative token count crosses this target. A sealed
   *  section's bytes are a pure function of its turn range (independent of where
   *  the conversation currently ends), so it stays byte-identical — and OpenAI
   *  prefix-cache-hits — as the conversation grows. Leftover tail turns that don't
   *  fill a whole section are left UNCOLLAPSED (live text) until they do. Chosen so
   *  each section renders to roughly one ≤6000px image, well under gpt-5.x's
   *  10,000-patch `detail:original` budget. Turn size, not turn count, drives this. */
  sectionTokens: number;
  /** Max rendered image height in px (per-model; from the GPT profile). Threaded
   *  into renderTextToPngs so history pages split at the same height the gate prices. */
  maxHeightPx: number;
  /** Reflow the transcript before rendering: pack soft-wrapped lines and mark
   *  every hard newline with the ↵ sentinel — same treatment as the static
   *  slab. History text is newline-heavy (role headers, JSON args), so without
   *  this each short line wastes a full render row and no ↵ marker appears.
   *  The returned `text` (o200k baseline + cache byte-stability) stays the
   *  ORIGINAL, un-reflowed transcript. */
  reflow: boolean;
}

export const GPT_HISTORY_DEFAULTS: GptHistoryOptions = {
  keepTail: 6,
  minCollapsePrefix: 10,
  minCollapseTokens: 2000,
  cols: GPT_HISTORY_COLS,
  collapseChunk: 10,
  freezeChunk: 10,
  sectionTokens: 2000,
  maxHeightPx: MAX_HEIGHT_PX,
  reflow: true,
};

/** One conversation item lowered to a renderable unit. */
export interface HistoryTurn {
  /** Serialized text (with role header / tool markers). Empty = skip (e.g. reasoning). */
  text: string;
  /** Tool-call ids this item opens (function_call / assistant tool_calls). */
  openIds: string[];
  /** Tool-call ids this item closes (function_call_output / tool message). */
  closeIds: string[];
  /** Item we can't safely serialize (unknown kind, item_reference) — a hard
   *  barrier: never collapse across it, since dropping it could lose state. */
  opaque: boolean;
}

export interface GptCollapsePlan {
  /** Rendered history images. Empty when no collapse happened. */
  images: RenderedImage[];
  /** The collapsed transcript text that was rendered (for o200k token counting). */
  text: string;
  /** Inclusive start index into the original item array. */
  start: number;
  /** Exclusive end index. Caller splices [start, endExclusive) → one synthetic item. */
  endExclusive: number;
  collapsedTurns: number;
  collapsedChars: number;
  reason?:
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'below_min_tokens'
    | 'not_profitable'
    | 'render_empty';
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}

function safeJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v ?? '');
  }
}

/** Last index i in [from, cutoffExclusive) where every opened tool-call id has a
 *  matching close. Returns from-1 (no collapse) if none. Stops at the first
 *  opaque barrier so unknown items are never swept into the image. */
function findClosedBoundary(
  turns: HistoryTurn[],
  cutoffExclusive: number,
  from: number,
): number {
  const open = new Set<string>();
  let lastClosed = from - 1;
  const limit = Math.min(cutoffExclusive, turns.length);
  for (let i = from; i < limit; i++) {
    const t = turns[i]!;
    if (t.opaque) break;
    for (const id of t.openIds) open.add(id);
    for (const id of t.closeIds) open.delete(id);
    if (open.size === 0) lastClosed = i;
  }
  return lastClosed;
}

/**
 * Plan + render a history collapse over pre-lowered turns. Pure w.r.t. the input
 * (caller does the splice and builds the format-specific synthetic item).
 */
export async function planGptCollapse(
  turns: HistoryTurn[],
  protectedPrefix: number,
  isProfitable: GptProfitableFn,
  opts: Partial<GptHistoryOptions> = {},
): Promise<GptCollapsePlan> {
  const o: GptHistoryOptions = { ...GPT_HISTORY_DEFAULTS, ...opts };
  const base: GptCollapsePlan = {
    images: [],
    text: '',
    start: 0,
    endExclusive: 0,
    collapsedTurns: 0,
    collapsedChars: 0,
    droppedChars: 0,
    droppedCodepoints: new Map(),
  };
  const pp = Math.max(0, Math.min(protectedPrefix, turns.length));
  const rawCutoff = turns.length - o.keepTail;
  if (rawCutoff - pp < o.minCollapsePrefix) {
    return { ...base, reason: 'prefix_too_short' };
  }
  // Snap the cutoff down to a collapseChunk grid (relative to pp) so the image
  // stays byte-stable across turns. Floor at pp + minCollapsePrefix.
  const cutoff =
    o.collapseChunk > 0
      ? Math.min(
          rawCutoff,
          Math.max(
            pp + o.minCollapsePrefix,
            pp + Math.floor((rawCutoff - pp) / o.collapseChunk) * o.collapseChunk,
          ),
        )
      : rawCutoff;
  const boundary = findClosedBoundary(turns, cutoff, pp);
  if (boundary < pp) {
    return { ...base, reason: 'no_closed_prefix' };
  }
  if (boundary + 1 - pp < o.minCollapsePrefix) {
    return { ...base, reason: 'prefix_too_short' };
  }
  const text = turns
    .slice(pp, boundary + 1)
    .map((t) => t.text)
    .filter((s) => s && s.length > 0)
    .join('\n\n');
  // Floor gate in o200k TOKENS, not chars: imaging bills vision tokens and the
  // text baseline is o200k tokens, so the break-even is a token comparison.
  if (!text || gptCountTokens(text) < o.minCollapseTokens) {
    return { ...base, reason: 'below_min_tokens', collapsedChars: text?.length ?? 0 };
  }
  // Reflow for RENDERING ONLY: pack soft-wrapped lines and mark hard newlines
  // with the ↵ sentinel so the history image is as dense as the static slab
  // (newline-heavy transcripts otherwise burn a full row per short line and
  // show no ↵). `text` itself stays original — it backs the o200k baseline and
  // the chunk-snapped cache byte-stability, so it must not change shape here.
  const safeText = neutralizeSentinel(text);
  const renderText = o.reflow ? reflow(safeText) ?? safeText : text;
  if (!isProfitable(renderText, o.cols)) {
    return { ...base, reason: 'not_profitable', collapsedChars: text.length };
  }
  // APPEND-ONLY, TOKEN-LENGTH sectioning. Cut the closed prefix [pp..rawEnd) into
  // sections of ~sectionTokens o200k tokens by walking turns from pp and sealing a
  // section each time its cumulative token count crosses the target. A sealed
  // section's bytes are a pure function of its turn range — independent of where
  // the conversation currently ends — so old sections stay byte-identical (OpenAI
  // prefix-cache hit) as turns are appended; only freshly-sealed sections are new.
  // Leftover tail turns that don't fill a whole section are NOT collapsed: collapse
  // ends at the last SEALED boundary so every emitted image is a frozen section.
  // (freezeChunk 0 = legacy whole-blob: one section spanning the whole range.)
  const rawEnd = boundary + 1;
  const sections: Array<[number, number]> = [];
  if (o.freezeChunk <= 0) {
    sections.push([pp, rawEnd]); // legacy: whole range as one section
  } else {
    let secStart = pp;
    let acc = 0;
    // Track open tool-call ids so a section is only sealed at a TOOL-CLOSED point.
    // The token threshold can otherwise land between a function_call and its
    // function_call_output: the call gets imaged while the output stays a live
    // item, and OpenAI rejects the orphan with "No tool call found for function
    // call output" (400). The overall [pp, rawEnd) boundary being closed does NOT
    // protect the intermediate section cut — collapseEnd is the live boundary, so
    // it (and every seal) must itself be tool-closed. Anthropic doesn't hit this
    // because it collapses the whole closed prefix with no live leftover.
    const open = new Set<string>();
    for (let i = pp; i < rawEnd; i++) {
      acc += gptCountTokens(turns[i]!.text);
      for (const id of turns[i]!.openIds) open.add(id);
      for (const id of turns[i]!.closeIds) open.delete(id);
      if (acc >= o.sectionTokens && open.size === 0) {
        sections.push([secStart, i + 1]);
        secStart = i + 1;
        acc = 0;
      }
    }
    // Trailing turns [secStart, rawEnd) didn't fill a section → leave as live text.
  }
  if (sections.length === 0) {
    // Closed prefix cleared the floor but no single section sealed (only when
    // sectionTokens > the whole prefix). Treat as below-min rather than emit a
    // cache-unstable partial blob.
    return { ...base, reason: 'below_min_tokens', collapsedChars: text.length };
  }
  const collapseEnd = sections[sections.length - 1]![1];
  // The collapsed transcript / o200k baseline reflects ONLY what we imaged.
  const collapsedText = turns
    .slice(pp, collapseEnd)
    .map((t) => t.text)
    .filter((s) => s && s.length > 0)
    .join('\n\n');
  const imgs: RenderedImage[] = [];
  for (const [s, e] of sections) {
    const sectionText = turns
      .slice(s, e)
      .map((t) => t.text)
      .filter((str) => str && str.length > 0)
      .join('\n\n');
    if (!sectionText || sectionText.length === 0) continue;
    const safeSection = neutralizeSentinel(sectionText);
    const sectionRender = o.reflow ? reflow(safeSection) ?? safeSection : sectionText;
    // Readable portrait strips (≤768px wide) — legible to OpenAI vision, same as
    // the static slab. renderTextToPngs caps each PNG at MAX_HEIGHT_PX so a tall
    // section pages into N images, all still well under the 10,000-patch budget.
    const sectionImgs = await renderTextToPngs(sectionRender, o.cols, {}, o.maxHeightPx);
    for (const img of sectionImgs) imgs.push(img);
  }
  if (imgs.length === 0) {
    return { ...base, reason: 'render_empty', collapsedChars: collapsedText.length };
  }
  const droppedCodepoints = new Map<number, number>();
  let droppedChars = 0;
  for (const img of imgs) {
    droppedChars += img.droppedChars;
    for (const [cp, n] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
    }
  }
  return {
    images: imgs,
    text: collapsedText,
    start: pp,
    endExclusive: collapseEnd,
    collapsedTurns: collapseEnd - pp,
    collapsedChars: collapsedText.length,
    droppedChars,
    droppedCodepoints,
  };
}

/** o200k_base token count — gpt-5 / gpt-4o / o-series share this encoding.
 *  Used for the history collapse floor (token-, not char-based). */
function gptCountTokens(text: string): number {
  if (!text) return 0;
  try {
    return o200kCountTokens(text);
  } catch {
    return 0;
  }
}

// ---- Responses API lowering -------------------------------------------------

function responsesContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const t = (p as { type?: string }).type;
    if (t === 'input_text' || t === 'output_text' || t === 'text' || t === 'summary_text') {
      const txt = (p as { text?: unknown }).text;
      if (typeof txt === 'string') parts.push(txt);
    } else if (t === 'input_image' || t === 'image' || t === 'output_image') {
      parts.push('[image]');
    } else if (t === 'refusal') {
      const r = (p as { refusal?: unknown }).refusal;
      if (typeof r === 'string') parts.push(r);
    }
  }
  return parts.join('\n');
}

function responsesItemToTurn(item: unknown, idx: number): HistoryTurn {
  const o = (item ?? {}) as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : undefined;
  if (type === 'reasoning') {
    return { text: '', openIds: [], closeIds: [], opaque: false };
  }
  if (type === 'function_call') {
    const callId =
      typeof o.call_id === 'string' ? o.call_id : typeof o.id === 'string' ? o.id : '';
    const name = typeof o.name === 'string' ? o.name : 'tool';
    const args = typeof o.arguments === 'string' ? o.arguments : safeJson(o.arguments);
    return {
      text: `[tool_use ${name}]\n${args}`,
      openIds: callId ? [callId] : [],
      closeIds: [],
      opaque: false,
    };
  }
  if (type === 'function_call_output') {
    const callId = typeof o.call_id === 'string' ? o.call_id : '';
    const out = typeof o.output === 'string' ? o.output : safeJson(o.output);
    return {
      text: `[tool_result]\n${out}`,
      openIds: [],
      closeIds: callId ? [callId] : [],
      opaque: false,
    };
  }
  const role = typeof o.role === 'string' ? o.role : undefined;
  if (role) {
    const body = responsesContentToText(o.content);
    if (!body.trim()) return { text: '', openIds: [], closeIds: [], opaque: false };
    const tag = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : role;
    // Absolute turn index (item position) — recency anchor so the model can tell turn 1
    // from turn 60 instead of resurfacing the salient opening turn. Stable per item →
    // cache-safe (mirrors src/core/history.ts). Tool turns stay unindexed (not mistakable
    // for a live request); the index rides the conversational role tags.
    return { text: `<${tag} t="${idx}">\n${body}\n</${tag}>`, openIds: [], closeIds: [], opaque: false };
  }
  // Unknown item kind (e.g. item_reference) we can't safely serialize → barrier.
  return { text: '', openIds: [], closeIds: [], opaque: true };
}

export function responsesItemsToTurns(items: unknown[]): HistoryTurn[] {
  return items.map((item, i) => responsesItemToTurn(item, i));
}

// ---- Chat Completions lowering ----------------------------------------------

function chatContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const t = (p as { type?: string }).type;
    if (t === 'text') {
      const txt = (p as { text?: unknown }).text;
      if (typeof txt === 'string') parts.push(txt);
    } else if (t === 'image_url' || t === 'input_image' || t === 'image') {
      parts.push('[image]');
    }
  }
  return parts.join('\n');
}

function chatMessageToTurn(msg: unknown, idx: number): HistoryTurn {
  const o = (msg ?? {}) as Record<string, unknown>;
  const role = typeof o.role === 'string' ? o.role : '';
  const body = chatContentToText(o.content);
  if (role === 'tool') {
    const id = typeof o.tool_call_id === 'string' ? o.tool_call_id : '';
    return {
      text: `[tool_result]\n${body}`,
      openIds: [],
      closeIds: id ? [id] : [],
      opaque: false,
    };
  }
  if (role === 'assistant') {
    const openIds: string[] = [];
    const parts: string[] = [];
    if (body.trim()) parts.push(body);
    const tc = o.tool_calls;
    if (Array.isArray(tc)) {
      for (const call of tc) {
        const c = (call ?? {}) as Record<string, unknown>;
        const id = typeof c.id === 'string' ? c.id : '';
        if (id) openIds.push(id);
        const fn = c.function as Record<string, unknown> | undefined;
        const name = fn && typeof fn.name === 'string' ? fn.name : 'tool';
        const args =
          fn && typeof fn.arguments === 'string' ? fn.arguments : safeJson(fn?.arguments);
        parts.push(`[tool_use ${name}]\n${args}`);
      }
    }
    const text = parts.join('\n');
    return {
      text: text.trim() ? `<assistant t="${idx}">\n${text}\n</assistant>` : '',
      openIds,
      closeIds: [],
      opaque: false,
    };
  }
  if (!body.trim()) return { text: '', openIds: [], closeIds: [], opaque: false };
  const tag = role === 'user' ? 'user' : role || 'user';
  return { text: `<${tag} t="${idx}">\n${body}\n</${tag}>`, openIds: [], closeIds: [], opaque: false };
}

export function chatMessagesToTurns(messages: unknown[]): HistoryTurn[] {
  return messages.map((msg, i) => chatMessageToTurn(msg, i));
}
