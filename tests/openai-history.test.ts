/**
 * Tests for GPT history-image compression (src/core/openai-history.ts):
 * turn lowering (Responses + Chat), closed-tool-call boundary detection,
 * chunk-snapped collapse boundary (cache byte-stability), and the profitability
 * / min-size gates.
 */
import { describe, expect, it } from 'vitest';
import {
  planGptCollapse,
  responsesItemsToTurns,
  chatMessagesToTurns,
  GPT_HISTORY_DEFAULTS,
  type HistoryTurn,
} from '../src/core/openai-history.js';

// Always-profitable predicate for tests that exercise the planner mechanics.
const yes = () => true;
const no = () => false;

/** Build N plain user/assistant turns, each `chars` long, no tool calls. */
function plainTurns(n: number, chars = 1000): HistoryTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `--- ${i % 2 === 0 ? 'user' : 'assistant'} ---\n${'x'.repeat(chars)}`,
    openIds: [],
    closeIds: [],
    opaque: false,
  }));
}

describe('responsesItemsToTurns', () => {
  it('lowers user/assistant message items with role headers', () => {
    const turns = responsesItemsToTurns([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ]);
    expect(turns[0]!.text).toBe('<user t="0">\nhello\n</user>');
    expect(turns[1]!.text).toBe('<assistant t="1">\nhi there\n</assistant>');
    expect(turns.every((t) => !t.opaque)).toBe(true);
  });

  it('tracks function_call open / function_call_output close ids', () => {
    const turns = responsesItemsToTurns([
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file body' },
    ]);
    expect(turns[0]!.openIds).toEqual(['c1']);
    expect(turns[0]!.text).toContain('[tool_use read]');
    expect(turns[1]!.closeIds).toEqual(['c1']);
    expect(turns[1]!.text).toContain('[tool_result]');
  });

  it('drops reasoning items (empty text, not opaque)', () => {
    const [t] = responsesItemsToTurns([{ type: 'reasoning', summary: [] }]);
    expect(t!.text).toBe('');
    expect(t!.opaque).toBe(false);
  });

  it('marks unknown item kinds opaque (collapse barrier)', () => {
    const [t] = responsesItemsToTurns([{ type: 'item_reference', id: 'x' }]);
    expect(t!.opaque).toBe(true);
  });
});

describe('chatMessagesToTurns', () => {
  it('lowers assistant tool_calls into open ids + [tool_use] text', () => {
    const turns = chatMessagesToTurns([
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ id: 'tc1', function: { name: 'grep', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'tc1', content: 'match' },
    ]);
    expect(turns[0]!.openIds).toEqual(['tc1']);
    expect(turns[0]!.text).toContain('[tool_use grep]');
    expect(turns[1]!.closeIds).toEqual(['tc1']);
  });
});

describe('planGptCollapse — gates', () => {
  it('refuses when the collapsible prefix is shorter than minCollapsePrefix', async () => {
    const turns = plainTurns(8); // keepTail 6 + need 10 prefix → too short
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.images).toHaveLength(0);
    expect(plan.reason).toBe('prefix_too_short');
  });

  it('refuses when collapsed text is below minCollapseTokens', async () => {
    // 20 tiny turns: prefix is long enough, but the o200k token count is below
    // the 2000-token floor (gate is measured in tokens, not chars).
    const turns = plainTurns(20, 5);
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.images).toHaveLength(0);
    expect(plan.reason).toBe('below_min_tokens');
  });

  it('refuses when the gate says not profitable', async () => {
    const turns = plainTurns(40, 1000);
    const plan = await planGptCollapse(turns, 0, no);
    expect(plan.images).toHaveLength(0);
    expect(plan.reason).toBe('not_profitable');
  });

  it('collapses a large plain prefix and keeps the tail', async () => {
    const turns = plainTurns(40, 1000);
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.images.length).toBeGreaterThan(0);
    expect(plan.start).toBe(0);
    // Tail of keepTail items stays out of the collapse.
    expect(plan.endExclusive).toBeLessThanOrEqual(40 - GPT_HISTORY_DEFAULTS.keepTail);
    expect(plan.collapsedTurns).toBe(plan.endExclusive - plan.start);
    expect(plan.text.length).toBe(plan.collapsedChars);
  });

  it('protects the leading prefix (slab-bearing first item)', async () => {
    const turns = plainTurns(40, 1000);
    const plan = await planGptCollapse(turns, 3, yes);
    expect(plan.start).toBe(3); // never collapses items [0..2]
  });
});

describe('planGptCollapse — closed-tool-call boundary', () => {
  it('never ends the collapse inside an open tool call', async () => {
    // 30 turns; make the turn at the would-be boundary an OPEN tool call with no
    // close until much later, forcing the boundary to retreat.
    const turns = plainTurns(30, 1000);
    // Open a tool call at index 18, close it at 25 (inside the tail-adjacent zone).
    turns[18] = { text: '[tool_use x]\n{}', openIds: ['open1'], closeIds: [], opaque: false };
    turns[25] = { text: '[tool_result]\nok', openIds: [], closeIds: ['open1'], opaque: false };
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0 });
    // Boundary must be < 18 (before the unclosed call) — the open id never closes
    // within the cutoff window.
    expect(plan.endExclusive).toBeLessThanOrEqual(18);
  });

  it('stops at an opaque barrier', async () => {
    const turns = plainTurns(40, 1000);
    turns[15] = { text: '', openIds: [], closeIds: [], opaque: true };
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0 });
    expect(plan.endExclusive).toBeLessThanOrEqual(15);
  });

  it('never ends the collapse between a function_call and its output (orphan 400)', async () => {
    // Regression for OpenAI 400 "No tool call found for function call output":
    // the token-based section seal must not cut between a function_call (imaged)
    // and its function_call_output (left live). Place tool-call pairs at many
    // offsets so a token-only seal would land mid-pair somewhere, then assert the
    // collapsed range [start, endExclusive) is itself tool-closed.
    // 22 turns (~424 o200k tokens each); keepTail trims the cutoff. A function_call
    // sits at 14 with its output at 15. With sectionTokens 1700 the token seal lands
    // ON the function_call: pre-fix the collapse ended at 15 (call imaged, output 16
    // left live) → the orphan 400. The closure gate must push the seal to a closed
    // point so the pair never straddles the live boundary.
    const turns: HistoryTurn[] = Array.from({ length: 22 }, (_, i) => ({
      text: `--- ${i % 2 ? 'assistant' : 'user'} ---\n` + `alpha beta gamma delta epsilon ${i} `.repeat(60),
      openIds: [],
      closeIds: [],
      opaque: false,
    }));
    turns[14] = { text: '[tool_use t]\n{}', openIds: ['call_X'], closeIds: [], opaque: false };
    turns[15] = { text: '[tool_result]\nok', openIds: [], closeIds: ['call_X'], opaque: false };
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0, sectionTokens: 1700 });
    expect(plan.images.length).toBeGreaterThan(0);
    // Simulate OpenAI: every opened call id in the collapsed range must close in it.
    const open = new Set<string>();
    for (let i = plan.start; i < plan.endExclusive; i++) {
      for (const id of turns[i]!.openIds) open.add(id);
      for (const id of turns[i]!.closeIds) open.delete(id);
    }
    expect(open.size).toBe(0); // no orphan function_call imaged with its output left live
  });
});

describe('planGptCollapse — reflow (↵ packing)', () => {
  // Newline-heavy turns: many SHORT lines. Without reflow each short line burns
  // a full render row and no ↵ marker appears; reflow packs them into full rows
  // and marks the hard breaks with ↵ (same treatment as the static slab).
  function shortLineTurns(n: number, linesPerTurn = 50): HistoryTurn[] {
    const body = Array.from({ length: linesPerTurn }, (_, i) => `line number ${i} here`).join('\n');
    return Array.from({ length: n }, (_, i) => ({
      text: `--- ${i % 2 === 0 ? 'user' : 'assistant'} ---\n${body}`,
      openIds: [],
      closeIds: [],
      opaque: false,
    }));
  }

  const pixels = (p: { images: { width: number; height: number }[] }) =>
    p.images.reduce((s, im) => s + im.width * im.height, 0);

  it('defaults reflow on', () => {
    expect(GPT_HISTORY_DEFAULTS.reflow).toBe(true);
  });

  it('packs newline-heavy history denser with reflow on', async () => {
    const turns = shortLineTurns(40);
    const on = await planGptCollapse(turns, 0, yes, { reflow: true });
    const off = await planGptCollapse(turns, 0, yes, { reflow: false });
    expect(on.images.length).toBeGreaterThan(0);
    expect(off.images.length).toBeGreaterThan(0);
    // Reflow only changes RENDERING — boundary and source text are identical.
    expect(on.text).toBe(off.text);
    // Short lines packed into full rows → strictly fewer rendered pixels.
    expect(pixels(on)).toBeLessThan(pixels(off));
  });

  it('keeps plan.text as the original transcript (real \\n, no ↵ sentinel)', async () => {
    const turns = shortLineTurns(40);
    const plan = await planGptCollapse(turns, 0, yes, { reflow: true });
    expect(plan.text).toContain('\n');
    expect(plan.text).not.toContain('↵');
    // The o200k baseline + cache byte-stability ride on this exact byte count.
    expect(plan.text.length).toBe(plan.collapsedChars);
  });
});

describe('planGptCollapse — chunk-snapped boundary (cache byte-stability)', () => {
  it('seals the same token sections as turns are appended (byte-stable window)', async () => {
    // 128 o200k tokens/turn, sectionTokens 2000 → a section seals every ~16 turns.
    // 34 and 35 turns seal the SAME single section [0..16) (the rest is leftover
    // live text), so the collapsed range — and the rendered image — is byte-identical
    // across those turns and keeps hitting OpenAI's automatic prefix cache.
    const base = plainTurns(60, 1000);
    const a = await planGptCollapse(base.slice(0, 34), 0, yes, { collapseChunk: 10 });
    const b = await planGptCollapse(base.slice(0, 35), 0, yes, { collapseChunk: 10 });
    expect(a.endExclusive).toBe(b.endExclusive);
    expect(a.text).toBe(b.text);
    // Accumulating enough turns to fill a SECOND ~2000-token section advances the
    // boundary by one whole section (not by turn count).
    const c = await planGptCollapse(base.slice(0, 52), 0, yes, { collapseChunk: 10 });
    expect(c.endExclusive).toBeGreaterThan(a.endExclusive);
  });

  it('per-item boundary (collapseChunk 0) moves with every new turn', async () => {
    const base = plainTurns(60, 1000);
    const a = await planGptCollapse(base.slice(0, 34), 0, yes, { collapseChunk: 0 });
    const b = await planGptCollapse(base.slice(0, 38), 0, yes, { collapseChunk: 0 });
    expect(b.endExclusive).toBeGreaterThan(a.endExclusive);
  });
});
