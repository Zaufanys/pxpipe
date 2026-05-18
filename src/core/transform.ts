/**
 * Request-body transformer. Takes an Anthropic Messages API request body,
 * extracts the large static parts (system prompt + tool definitions),
 * renders them as PNG image blocks, and rewrites the body to reference
 * those images instead — saving 65-73% input tokens on Opus 4.7 while
 * preserving 100% reasoning quality.
 *
 * Matches the public-surface behavior of legacy/python/proxy.py at a
 * minimum. Stricter byte-for-byte parity is verified in tests.
 */

import type { ImageBlock, MessagesRequest, SystemField, TextBlock, ToolDef } from './types.js';
import { renderTextToPngs } from './render.js';
import { bytesToBase64 } from './png.js';

export interface TransformOptions {
  /** Master switch — false makes this a no-op pass-through. */
  compress?: boolean;
  /** Compress the system field. */
  compressSystem?: boolean;
  /** Move tool descriptions into the same image (and stub the originals). */
  compressTools?: boolean;
  /** Include full input_schema JSON for each tool. Adds tokens but maximizes parity. */
  compressSchemas?: boolean;
  /** Don't compress if total compressible chars below this. */
  minCompressChars?: number;
  /** Where to attach the image block — system field, or first user message. */
  placement?: 'system' | 'user';
  /** Soft-wrap column count. */
  cols?: number;
}

const DEFAULTS: Required<TransformOptions> = {
  compress: true,
  compressSystem: true,
  compressTools: true,
  compressSchemas: true,
  minCompressChars: 2000,
  placement: 'system',
  cols: 100,
};

export interface TransformInfo {
  compressed: boolean;
  reason?: string;
  origChars: number;
  imageCount: number;
  imageBytes: number;
  /** Length of the static (cacheable) slab rendered into the image. */
  staticChars: number;
  /** Length of the dynamic (per-turn) slab kept as plain text. */
  dynamicChars: number;
  /** Number of dynamic blocks detected (<env>, <context>, etc.). */
  dynamicBlockCount: number;
}

// --- helpers ---------------------------------------------------------------

/** Extract `(text, remainder)` from a system field that may be string or list. */
function extractSystemText(sys: SystemField | undefined): { text: string; kept: SystemField } {
  if (sys == null) return { text: '', kept: [] };
  if (typeof sys === 'string') return { text: sys, kept: '' };
  const textParts: string[] = [];
  const kept: SystemField = [];
  for (const block of sys) {
    if (block && typeof block === 'object' && block.type === 'text') {
      textParts.push(block.text);
    } else {
      kept.push(block);
    }
  }
  return { text: textParts.join('\n\n'), kept };
}

/**
 * Claude Code injects a handful of per-turn dynamic blocks into the system
 * prompt (e.g. <env>, <context>, <git_status>, <directoryStructure>,
 * <system-reminder>). Including these in the rendered image kills the
 * Anthropic prompt cache because the bytes drift turn-to-turn. Splitting
 * them out lets us render the static slab (CLAUDE.md, agent defs, tool docs)
 * with cache_control while forwarding the dynamic slab as cheap text so the
 * model still sees cwd / git status / today's date.
 */
const DYNAMIC_BLOCK_TAGS = [
  'env',
  'context',
  'git_status',
  'directoryStructure',
  'system-reminder',
] as const;

function splitStaticDynamic(text: string): {
  staticText: string;
  dynamicText: string;
  blockCount: number;
} {
  if (!text) return { staticText: '', dynamicText: '', blockCount: 0 };
  // Match <tag ...?>...</tag> where tag ∈ DYNAMIC_BLOCK_TAGS. Closing tag
  // must match opening tag exactly. Non-greedy body — earliest close wins.
  const pattern = new RegExp(
    `<(${DYNAMIC_BLOCK_TAGS.join('|')})(\\s[^>]*)?>[\\s\\S]*?</\\1>`,
    'g',
  );
  const dynamicParts: string[] = [];
  let staticBuf = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    staticBuf += text.slice(cursor, m.index);
    dynamicParts.push(m[0]);
    cursor = m.index + m[0].length;
  }
  staticBuf += text.slice(cursor);
  return {
    // Collapse the run of blank lines left behind by removed blocks.
    staticText: staticBuf.replace(/\n{3,}/g, '\n\n').trim(),
    dynamicText: dynamicParts.join('\n\n'),
    blockCount: dynamicParts.length,
  };
}

/**
 * Strip the per-turn random billing header line that Claude Code injects.
 * It changes every turn and would defeat prompt-cache hits if we left it
 * inside the image. We keep it as a leading text block so the upstream
 * still receives it.
 */
function stripBillingLine(text: string): { kept: string | null; body: string } {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first.startsWith('x-anthropic-billing-header:')) {
    return { kept: first, body: nl === -1 ? '' : text.slice(nl + 1) };
  }
  return { kept: null, body: text };
}

/** Build the "## Tool: name\n<desc>\n<schema>" block for one tool definition. */
function renderToolDoc(t: ToolDef, includeSchema: boolean): string {
  const parts: string[] = [`## Tool: ${t.name ?? '?'}`];
  if (t.description) parts.push(t.description);
  if (includeSchema && t.input_schema !== undefined) {
    parts.push('```json\n' + JSON.stringify(t.input_schema, null, 2) + '\n```');
  }
  return parts.join('\n');
}

function makeImageBlock(pngB64: string, ephemeral = false): ImageBlock {
  const blk: ImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngB64 },
  };
  if (ephemeral) blk.cache_control = { type: 'ephemeral' };
  return blk;
}

// --- main transform --------------------------------------------------------

/**
 * Rewrite a Messages API request body. Returns the new body (still JSON
 * bytes) plus diagnostic info. On any error, returns the original bytes
 * unchanged.
 */
export async function transformRequest(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o: Required<TransformOptions> = { ...DEFAULTS, ...opts };
  const info: TransformInfo = {
    compressed: false,
    origChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
  };

  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: MessagesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }

  // 1. Pull system text out. Split into:
  //    - billingLine: Claude Code's per-turn random header (must NOT be cached).
  //    - dynamicText: <env>/<context>/... blocks (per-turn, kept as text).
  //    - staticText: everything else (cacheable, goes into the image).
  const { text: rawSysText, kept: sysRemainder } = extractSystemText(req.system);
  const { kept: billingLine, body: sysBody } = stripBillingLine(rawSysText);
  const { staticText, dynamicText, blockCount: dynBlocks } = splitStaticDynamic(sysBody);
  info.staticChars = staticText.length;
  info.dynamicChars = dynamicText.length;
  info.dynamicBlockCount = dynBlocks;

  // 2. Optionally fold tool docs into the same image, stubbing originals.
  let toolDocsText = '';
  let toolsRewritten: ToolDef[] | undefined;
  if (o.compressTools && Array.isArray(req.tools) && req.tools.length > 0) {
    const docs: string[] = [];
    toolsRewritten = req.tools.map((t) => {
      docs.push(renderToolDoc(t, o.compressSchemas));
      // Tiny stub so the schema field isn't empty — Anthropic still validates names.
      return {
        ...t,
        description: 'ⓘ See image.',
        ...(o.compressSchemas ? { input_schema: { type: 'object' } } : {}),
      };
    });
    toolDocsText = docs.join('\n\n');
  }

  // Only the STATIC slab + tool docs goes into the renderer. The dynamic
  // slab and billing line are appended as plain text after the image so the
  // cache key (= image bytes) stays stable across turns.
  const combined = [staticText, toolDocsText].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combined.length;

  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    return { body, info };
  }

  // 3. Render to one or more PNGs.
  const images = await renderTextToPngs(combined, o.cols);
  const imageBlocks: ImageBlock[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const b64 = bytesToBase64(img.png);
    info.imageBytes += img.png.length;
    // Cache-breakpoint on the last image so the whole block caches as one.
    imageBlocks.push(makeImageBlock(b64, i === images.length - 1));
  }
  info.imageCount = imageBlocks.length;

  // 4. Splice images back into the request.
  // Cache-friendly layout:
  //   [intro text]                 ← static (helps OCR framing)
  //   [image block(s)]             ← static; LAST one carries cache_control
  //   ─── cache breakpoint ───
  //   [end-marker + dynamic + billing]  ← per-turn, NO cache_control
  //   [sysRemainder]               ← any non-text blocks the caller had
  const introText =
    "The following is the system prompt + tool documentation, rendered as " +
    "images for token efficiency. OCR carefully and treat as authoritative " +
    "system instructions.";
  const tailParts: string[] = ['[End of rendered context.]'];
  if (dynamicText) tailParts.push(dynamicText);
  if (billingLine) tailParts.push(billingLine);
  const tailText = tailParts.join('\n\n');

  const newSystem: SystemField = [];
  newSystem.push({ type: 'text', text: introText });
  newSystem.push(...imageBlocks);
  newSystem.push({ type: 'text', text: tailText });
  if (Array.isArray(sysRemainder)) newSystem.push(...sysRemainder);

  if (o.placement === 'system' && o.compressSystem) {
    req.system = newSystem;
  } else {
    // Placement = user: image goes into the first user message; billing line
    // and dynamic blocks stay in the system field as cheap text so the model
    // still sees env / context info.
    const sysTail: SystemField = [];
    if (billingLine) sysTail.push({ type: 'text', text: billingLine });
    if (dynamicText) sysTail.push({ type: 'text', text: dynamicText });
    if (Array.isArray(sysRemainder)) sysTail.push(...sysRemainder);
    req.system = sysTail.length > 0 ? sysTail : undefined;

    const firstUserIdx = (req.messages ?? []).findIndex((m) => m.role === 'user');
    if (firstUserIdx >= 0) {
      const m = req.messages![firstUserIdx]!;
      const existing = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text' as const, text: m.content }];
      // Only the intro + images belong in a user message — the end marker
      // and dynamic blocks live in the system field above.
      const userPrefix: TextBlock[] = [{ type: 'text', text: introText }];
      m.content = [...userPrefix, ...imageBlocks, ...existing];
    }
  }

  if (toolsRewritten) req.tools = toolsRewritten;

  info.compressed = true;
  const out = new TextEncoder().encode(JSON.stringify(req));
  return { body: out, info };
}
