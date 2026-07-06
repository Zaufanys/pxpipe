/**
 * Tests for the rehydrate path (src/core/rehydrate.ts + its wiring in transform.ts).
 *
 * Rehydrate is the escape hatch for DENSE byte-exact recall: pxpipe images bulk as usual
 * but, when `rehydrate: true`, stamps a `[pxpipe:rehydrate id=rec_…]` marker beside each
 * imaged region and returns the originals in `info.recoverable`. A stateful host feeds those
 * into a RecoverableStore, adds the tool, and serves the exact text back when the model calls
 * `pxpipe_rehydrate({ id })`.
 *
 * Contract verified:
 *   - Store: ingest/get/has/size/clear, oldest-first eviction, recency refresh.
 *   - Tool plumbing: def shape, isRehydrateToolUse, rehydrateRequestedId, rehydrateToolResult
 *     (hit → exact text; unknown id / missing arg → is_error).
 *   - Marker: build + parse round-trip.
 *   - Transform wiring: default off (no marker, no recoverable); on → marker beside the image
 *     whose id matches info.recoverable, and a full transform→store→tool round-trip returns the
 *     original bytes.
 */

import { describe, expect, it } from 'vitest';
import {
  REHYDRATE_TOOL_NAME,
  RecoverableStore,
  rehydrateToolDef,
  rehydrateToolResult,
  rehydrateMarker,
  parseRehydrateMarker,
  isRehydrateToolUse,
  rehydrateRequestedId,
} from '../src/core/rehydrate.js';
import { transformRequest } from '../src/core/transform.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- RecoverableStore -----------------------------------------------------

describe('RecoverableStore', () => {
  it('ingests recoverable entries and serves them by id', () => {
    const store = new RecoverableStore();
    store.ingest([
      { id: 'rec_aaaa1111', text: 'exact one' },
      { id: 'rec_bbbb2222', text: 'exact two' },
    ]);
    expect(store.size).toBe(2);
    expect(store.get('rec_aaaa1111')).toBe('exact one');
    expect(store.has('rec_bbbb2222')).toBe(true);
    expect(store.get('rec_missing')).toBeUndefined();
  });

  it('is idempotent per id and tolerates undefined / malformed input', () => {
    const store = new RecoverableStore();
    store.ingest(undefined);
    store.ingest([{ id: 'rec_x', text: 'v1' }]);
    store.ingest([{ id: 'rec_x', text: 'v2' }]); // same id refreshes value
    // @ts-expect-error — malformed entries are skipped, not thrown on
    store.ingest([{ id: 5 }, null, { text: 'no id' }]);
    expect(store.size).toBe(1);
    expect(store.get('rec_x')).toBe('v2');
  });

  it('evicts oldest first past the bound, but refreshes recency on re-ingest', () => {
    const store = new RecoverableStore(2);
    store.ingest([{ id: 'a', text: 'A' }]);
    store.ingest([{ id: 'b', text: 'B' }]);
    store.ingest([{ id: 'a', text: 'A' }]); // touch 'a' → 'b' is now oldest
    store.ingest([{ id: 'c', text: 'C' }]); // evicts 'b'
    expect(store.size).toBe(2);
    expect(store.has('a')).toBe(true);
    expect(store.has('c')).toBe(true);
    expect(store.has('b')).toBe(false);
  });

  it('clear() empties the store', () => {
    const store = new RecoverableStore();
    store.ingest([{ id: 'a', text: 'A' }]);
    store.clear();
    expect(store.size).toBe(0);
  });
});

// ---- tool plumbing --------------------------------------------------------

describe('rehydrate tool plumbing', () => {
  it('exposes a well-formed tool definition', () => {
    const def = rehydrateToolDef();
    expect(def.name).toBe(REHYDRATE_TOOL_NAME);
    expect(def.description).toBeTruthy();
    const schema = def.input_schema as any;
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('id');
    expect(schema.properties.id.type).toBe('string');
  });

  it('recognizes a rehydrate tool_use and pulls the requested id', () => {
    const call = { type: 'tool_use', id: 'toolu_1', name: REHYDRATE_TOOL_NAME, input: { id: 'rec_z' } };
    expect(isRehydrateToolUse(call)).toBe(true);
    expect(isRehydrateToolUse({ type: 'tool_use', id: 't', name: 'Read', input: {} })).toBe(false);
    expect(isRehydrateToolUse(null)).toBe(false);
    expect(rehydrateRequestedId(call as any)).toBe('rec_z');
  });

  it('answers a call with the exact stored text', () => {
    const store = new RecoverableStore().ingest([{ id: 'rec_hit', text: 'byte-exact payload' }]);
    const res = rehydrateToolResult(store, {
      type: 'tool_use', id: 'toolu_9', name: REHYDRATE_TOOL_NAME, input: { id: 'rec_hit' },
    } as any);
    expect(res.type).toBe('tool_result');
    expect(res.tool_use_id).toBe('toolu_9');
    expect(res.content).toBe('byte-exact payload');
    expect(res.is_error).toBeUndefined();
  });

  it('returns an is_error result for an unknown id (model degrades to re-read, not fabricate)', () => {
    const store = new RecoverableStore();
    const res = rehydrateToolResult(store, {
      type: 'tool_use', id: 'toolu_9', name: REHYDRATE_TOOL_NAME, input: { id: 'rec_gone' },
    } as any);
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toContain('rec_gone');
  });

  it('returns an is_error result when the id argument is missing', () => {
    const store = new RecoverableStore();
    const res = rehydrateToolResult(store, {
      type: 'tool_use', id: 'toolu_9', name: REHYDRATE_TOOL_NAME, input: {},
    } as any);
    expect(res.is_error).toBe(true);
  });
});

describe('rehydrate marker', () => {
  it('builds and parses back the id', () => {
    const marker = rehydrateMarker('rec_abcd1234');
    expect(marker).toContain(REHYDRATE_TOOL_NAME);
    expect(parseRehydrateMarker(marker)).toBe('rec_abcd1234');
  });
  it('parses undefined for non-marker text', () => {
    expect(parseRehydrateMarker('just some prose')).toBeUndefined();
  });
});

// ---- transform wiring -----------------------------------------------------

function makeReq(content: unknown[], model = 'claude-3-5-sonnet') {
  return enc.encode(
    JSON.stringify({
      model,
      system: 'x'.repeat(80_000),
      messages: [{ role: 'user', content }],
    }),
  );
}

function userBlocks(body: Uint8Array): any[] {
  const req = JSON.parse(dec.decode(body));
  const user = (req.messages ?? []).find((m: any) => m.role === 'user');
  return Array.isArray(user?.content) ? user.content : [];
}

// A block big + dense enough that the profitability gate images it (same shape the
// keep-sharp/paging tests use). Content is opaque to rehydrate — the store returns whatever
// raw bytes were imaged — so a plain filler exercises the round-trip fine.
const DENSE = 'x'.repeat(50_000);

describe('transform rehydrate wiring', () => {
  it('adds no marker and no recoverable by default', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: DENSE }]),
      { multiCol: 1, charsPerToken: 2 },
    );
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(info.recoverable).toBeUndefined();
    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    const hasMarker = (tr?.content ?? []).some(
      (b: any) => b.type === 'text' && parseRehydrateMarker(b.text) !== undefined,
    );
    expect(hasMarker).toBe(false);
  });

  it('stamps a marker whose id matches info.recoverable, and round-trips the exact bytes', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: DENSE }]),
      { multiCol: 1, charsPerToken: 2, rehydrate: true },
    );

    // Recoverable populated even though emitRecoverable was not set explicitly.
    expect(info.recoverable && info.recoverable.length).toBeGreaterThan(0);
    const rec = info.recoverable!.find((r) => r.kind === 'tool_result')!;
    expect(rec.text).toBe(DENSE);

    // The imaged tool_result carries an image + a marker text block naming that id.
    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    expect(tr.content.some((b: any) => b.type === 'image')).toBe(true);
    const markerBlock = tr.content.find(
      (b: any) => b.type === 'text' && parseRehydrateMarker(b.text) !== undefined,
    );
    expect(markerBlock).toBeTruthy();
    const markerId = parseRehydrateMarker(markerBlock.text);
    expect(markerId).toBe(rec.id);

    // Host round-trip: ingest → model calls the tool with the marker id → exact text back.
    const store = new RecoverableStore().ingest(info.recoverable);
    const result = rehydrateToolResult(store, {
      type: 'tool_use', id: 'toolu_call', name: REHYDRATE_TOOL_NAME, input: { id: markerId },
    } as any);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe(DENSE);
  });
});
