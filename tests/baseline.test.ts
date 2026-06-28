import { describe, it, expect } from 'vitest';
import {
  computeBaselineInputEff,
  computeActualInputEff,
  deriveBaselineWarmth,
  CACHE_CREATE_RATE,
  CACHE_READ_RATE,
  CACHE_TTL_SEC,
} from '../src/core/baseline.js';

/**
 * The text counterfactual must be warmth-aware. The old warmth-free version
 * always priced the cacheable prefix at the cheap read rate, which fabricated a
 * "free read" on cold/TTL-expiry turns — text would actually re-create the
 * prefix there, same as the imaged path. That phantom read showed up as a
 * dashboard loss on growth/cold turns even when imaging genuinely won.
 */
describe('computeBaselineInputEff (warmth-aware)', () => {
  const inp = 1000;
  const cc = 0;
  const cr = 0;

  it('credits nothing (returns actual) when the probe could not split the prefix', () => {
    const actual = computeActualInputEff(inp, cc, cr);
    expect(computeBaselineInputEff(5000, 0, inp, cc, cr, true, 0)).toBe(actual);
    expect(computeBaselineInputEff(5000, -1, inp, cc, cr, false, 0)).toBe(actual);
  });

  it('returns 0 for a non-positive baseline', () => {
    expect(computeBaselineInputEff(0, 100, inp, cc, cr)).toBe(0);
    expect(computeBaselineInputEff(-10, 100, inp, cc, cr)).toBe(0);
  });

  it('cold turn re-creates the whole cacheable prefix at the create rate', () => {
    // baseline=5000, cacheable=4000, coldTail=1000. No warm cache for text.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, false, 0);
    expect(got).toBe(4000 * CACHE_CREATE_RATE + 1000 * 1.0);
  });

  it('defaults to the cold (warmth-free) path when warm is omitted', () => {
    const explicit = computeBaselineInputEff(5000, 4000, inp, cc, cr, false, 0);
    const defaulted = computeBaselineInputEff(5000, 4000, inp, cc, cr);
    expect(defaulted).toBe(explicit);
  });

  it('warm turn reads the prefix it already had cached at the read rate', () => {
    // Same prefix size as last turn: fully reused, nothing grown.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 4000);
    expect(got).toBe(4000 * CACHE_READ_RATE + 1000 * 1.0);
  });

  it('warm growth turn reads the reused prefix and creates only the growth', () => {
    // prev cached 3000, prefix grew to 4000: reused=3000, grown=1000.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 3000);
    expect(got).toBe(3000 * CACHE_READ_RATE + 1000 * CACHE_CREATE_RATE + 1000 * 1.0);
  });

  it('caps reused at the current cacheable when the prefix shrank', () => {
    // prev cached 9000 but prefix is now 4000: reused=4000, grown=0.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 9000);
    expect(got).toBe(4000 * CACHE_READ_RATE + 1000 * 1.0);
  });

  it('never prices a cold turn cheaper than a warm turn for the same prefix', () => {
    // The regression guard: cold must cost MORE than warm (no phantom free read).
    const cold = computeBaselineInputEff(5000, 4000, inp, cc, cr, false, 0);
    const warm = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 4000);
    expect(cold).toBeGreaterThan(warm);
  });
});

/**
 * deriveBaselineWarmth decides WHEN the text counterfactual was warm — the
 * honest UNION of two independent witnesses that the text prefix was cached:
 *   1. a fresh same-session prior within the TTL (wall clock), and
 *   2. an observed read (cr>0).
 * cr === 0 does NOT force cold — the wall-clock leg carries a cache-busted
 * re-render — and the cr leg rescues the post-restart turn that has no in-memory
 * prior yet. The old rule used cr ALONE (cr necessary), which mispriced both.
 */
describe('deriveBaselineWarmth (honest union: fresh prior in TTL OR cr>0)', () => {
  const prev = (ts: number, cacheable: number) => ({ ts, cacheable });

  it('cold when there is no prior and no observed read', () => {
    expect(deriveBaselineWarmth(undefined, 1000, 5000, 0)).toEqual({ warm: false, prevCacheable: 0 });
  });

  it('warm via cr>0 even with no prior (session warmed before this process booted)', () => {
    // The first TRACKED turn of an already-warm session: no in-memory prior, but
    // cr>0 proves the cache was warm (post-restart / SESSION_CAP-eviction rescue).
    // Assume full reuse (prevCacheable=cacheable) — cr proves a read, not its split.
    expect(deriveBaselineWarmth(undefined, 1000, 5000, 100)).toEqual({ warm: true, prevCacheable: 5000 });
  });

  it('THE FIX: warm via a fresh prior even when cr===0 (pxpipe busted its own image cache)', () => {
    // 60s since the last turn, image cache missed (cr=0) — text prefix is still
    // cached. The old cr-alone rule returned cold here and fabricated savings.
    expect(deriveBaselineWarmth(prev(1000, 8000), 1060, 5000, 0)).toEqual({
      warm: true,
      prevCacheable: 8000,
    });
  });

  it('cold once the prior is older than the TTL (genuine expiry) and no observed read', () => {
    expect(deriveBaselineWarmth(prev(1000, 8000), 1000 + CACHE_TTL_SEC + 1, 5000, 0)).toEqual({
      warm: false,
      prevCacheable: 0,
    });
  });

  it('a fresh prior gives the real prior prefix size; cr-only warmth assumes full reuse', () => {
    // fresh prior → prevCacheable = prev.cacheable (real reused/grown split)
    expect(deriveBaselineWarmth(prev(1000, 3000), 1100, 5000, 0).prevCacheable).toBe(3000);
    // warm via cr but stale prior → full-reuse assumption (prevCacheable = cacheable)
    expect(deriveBaselineWarmth(prev(0, 3000), 1_000_000, 5000, 50).prevCacheable).toBe(5000);
  });

  it('ignores a prior with a future/negative age (clock skew) — needs cr to be warm', () => {
    expect(deriveBaselineWarmth(prev(2000, 8000), 1000, 5000, 0).warm).toBe(false);
    expect(deriveBaselineWarmth(prev(2000, 8000), 1000, 5000, 9).warm).toBe(true);
  });

  it('warm is the conservative direction: it never raises the baseline vs cold', () => {
    // Whichever way warmth resolves, pricing warm must not claim MORE savings
    // than cold for the same prefix (warm lowers, or holds, the baseline).
    const cacheable = 4000;
    const { warm, prevCacheable } = deriveBaselineWarmth(prev(1000, 4000), 1100, cacheable, 0);
    // inp/cc/cr only feed the probe-miss branch (cacheable>0 here ⇒ unused).
    const warmEff = computeBaselineInputEff(5000, cacheable, 0, 0, 0, warm, prevCacheable);
    const coldEff = computeBaselineInputEff(5000, cacheable, 0, 0, 0, false, 0);
    expect(warmEff).toBeLessThanOrEqual(coldEff);
  });
});
