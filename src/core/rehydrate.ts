/**
 * Rehydrate path — give the model a way to pull an imaged region back byte-exact.
 *
 * pxpipe's imaging is a lossy gist tier: dense identifiers can mis-OCR silently. The
 * fact-sheet rescues *sparse* precision (a handful of ids per page). This module is the
 * answer for *dense* precision — a whole imaged code file or table the model needs
 * verbatim, which no fixed-size sidecar can hold.
 *
 * How the round-trip works (a stateful host that embeds the library, not the transparent
 * proxy — the proxy can't execute a tool the client's agent loop owns):
 *
 *   1. Host transforms each request with `rehydrate: true`. pxpipe images bulk as usual
 *      but stamps a tiny `[pxpipe:rehydrate id=rec_…]` marker beside every imaged region
 *      and returns the originals in `info.recoverable`.
 *   2. Host feeds `info.recoverable` into a {@link RecoverableStore} (accumulates across
 *      turns) and adds {@link rehydrateToolDef} to the request's `tools`.
 *   3. When the model needs a region exactly, it calls `pxpipe_rehydrate({ id })`. The
 *      host detects that tool_use ({@link isRehydrateToolUse}) and answers it with
 *      {@link rehydrateToolResult} — the original text, straight from the store, no image
 *      re-read. Everything else in the agent loop is untouched.
 *
 * The store is the host's; pxpipe keeps no global state. All functions are pure given the
 * store, deterministic, and free of Date/random.
 */

import type { ToolDef, ToolResultBlock, ToolUseBlock } from './types.js';

/** Name of the tool the host exposes so the model can request an exact region. */
export const REHYDRATE_TOOL_NAME = 'pxpipe_rehydrate';

/** Minimal shape the store ingests. `RecoverableBlock` (from transform.ts) is a superset,
 *  so `info.recoverable` is assignable without importing that type (avoids a cycle). */
export interface RecoverableLike {
  readonly id: string;
  readonly text: string;
  readonly kind?: string;
  readonly toolUseId?: string;
}

/**
 * The in-request marker pxpipe stamps beside an imaged region when `rehydrate` is on, so
 * the model can name the region when it calls the tool. Deterministic (id is a content
 * hash) → byte-stable → never busts the prompt cache.
 */
export function rehydrateMarker(id: string): string {
  return (
    `[pxpipe:rehydrate id=${id} — the region imaged above is a lossy rendering; ` +
    `call the ${REHYDRATE_TOOL_NAME} tool with this id to get its exact text back before ` +
    `quoting or editing anything byte-sensitive from it.]`
  );
}

/** Extract the `rec_…` id from a rehydrate marker, or `undefined` if the text isn't one. */
export function parseRehydrateMarker(text: string): string | undefined {
  const m = /^\[pxpipe:rehydrate id=(\S+)\b/.exec(text.trimStart());
  return m ? m[1] : undefined;
}

/** The tool definition the host adds to its `tools` array. Input: `{ id: "rec_…" }`. */
export function rehydrateToolDef(): ToolDef {
  return {
    name: REHYDRATE_TOOL_NAME,
    description:
      'Return the exact, byte-for-byte text of a region pxpipe rendered to an image. ' +
      'Call this with the id from a [pxpipe:rehydrate id=…] marker whenever you must quote, ' +
      'diff, or edit that region precisely (exact identifiers, hashes, numbers, code) — the ' +
      'image is a lossy rendering and may misread such details.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The rec_… id from the [pxpipe:rehydrate id=…] marker beside the imaged region.',
        },
      },
      required: ['id'],
    },
  };
}

/** Default upper bound on distinct recoverable regions held at once. Oldest evicted first.
 *  Sized well above a realistic live working set; caps memory on a long session. */
const DEFAULT_MAX_ENTRIES = 4096;

/**
 * Accumulates recoverable regions across turns and answers rehydrate lookups. Owned by the
 * host — pxpipe never holds global state. Insertion-ordered with oldest-first eviction once
 * `maxEntries` is exceeded; re-ingesting a live id refreshes its recency so an id the model
 * keeps referencing is never evicted out from under it.
 */
export class RecoverableStore {
  private readonly map = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  /** Record every region from a transform's `info.recoverable`. Idempotent per id. */
  ingest(recoverable: readonly RecoverableLike[] | undefined): this {
    if (!recoverable) return this;
    for (const r of recoverable) {
      if (!r || typeof r.id !== 'string' || typeof r.text !== 'string') continue;
      // Refresh recency: delete then re-set moves the id to the newest slot.
      if (this.map.has(r.id)) this.map.delete(r.id);
      this.map.set(r.id, r.text);
    }
    // Evict oldest until within bound.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return this;
  }

  /** Original text for `id`, or `undefined` if unknown/evicted. */
  get(id: string): string | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** True when `block` is a call to the rehydrate tool. */
export function isRehydrateToolUse(block: unknown): block is ToolUseBlock {
  return (
    !!block &&
    (block as ToolUseBlock).type === 'tool_use' &&
    (block as ToolUseBlock).name === REHYDRATE_TOOL_NAME
  );
}

/** Pull the requested `id` out of a rehydrate tool_use's input, or `undefined` if malformed. */
export function rehydrateRequestedId(toolUse: ToolUseBlock): string | undefined {
  const input = toolUse.input;
  if (input && typeof input === 'object' && typeof (input as { id?: unknown }).id === 'string') {
    return (input as { id: string }).id;
  }
  return undefined;
}

/**
 * Build the `tool_result` that answers a `pxpipe_rehydrate` call: the exact original text
 * from `store`, or an `is_error` result naming the unknown/expired id (so the model degrades
 * to re-reading rather than silently fabricating). The returned block is ready to append to
 * the next request's user message.
 */
export function rehydrateToolResult(store: RecoverableStore, toolUse: ToolUseBlock): ToolResultBlock {
  const id = rehydrateRequestedId(toolUse);
  if (id === undefined) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `${REHYDRATE_TOOL_NAME}: missing required "id" argument.`,
      is_error: true,
    };
  }
  const text = store.get(id);
  if (text === undefined) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `${REHYDRATE_TOOL_NAME}: unknown id "${id}" (never imaged, or evicted from the store). Re-read the source directly for exact text.`,
      is_error: true,
    };
  }
  return { type: 'tool_result', tool_use_id: toolUse.id, content: text };
}
