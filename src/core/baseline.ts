/**
 * Cache-aware baseline math for the unproxied counterfactual.
 * Workers-safe: no node:, no Buffer, no process.*. Pure number math.
 * See docs/CACHING_AND_SAVINGS.md for the full derivation and audit history.
 */

/** Documented Anthropic price ratios: cc_5m = 1.25×, cr = 0.1× base input. One-line change if rates change. */
export const CACHE_CREATE_RATE = 1.25;
export const CACHE_READ_RATE = 0.1;

/** Anthropic prompt-cache TTL (seconds). A turn within this window of the same
 *  session's previous turn still finds its append-only text prefix cached. */
export const CACHE_TTL_SEC = 300;

/** This session's previous usage-bearing turn, for wall-clock warmth. */
export interface BaselineWarmthPrev {
  /** Wall-clock seconds of that turn. */
  ts: number;
  /** Cacheable-prefix tokens measured that turn (0 if the probe missed). */
  cacheable: number;
}

/**
 * Decide whether the TEXT counterfactual's prefix was warm this turn, and what
 * prior prefix size to credit as reused.
 *
 * Warmth is the honest UNION of two independent witnesses that the text prefix
 * was cached this turn — warm iff EITHER fires:
 *
 *   1. WALL CLOCK — a fresh same-session prior within `ttlSec`. The text prefix
 *      is append-only and shares the session's prompt-cache TTL, so a recent
 *      prior turn proves it is still cached even when pxpipe busted its OWN image
 *      cache (cr === 0) by re-rendering the prefix in place this turn. This leg
 *      is decoupled from the image's cache state; the old `cr > 0`-only rule
 *      lacked it and mispriced cache-busted re-renders COLD, turning a real
 *      re-imaging LOSS into a fabricated "saving".
 *
 *   2. OBSERVED READ — cr > 0 directly witnesses Anthropic serving a cached
 *      prefix this turn. This rescues the first turn after a pxpipe restart /
 *      SESSION_CAP eviction while the cache is still warm (no in-memory prior,
 *      yet cr proves warmth). Without it that turn is priced COLD and fabricates
 *      an inflated "saved" row — the operator's original reported bug.
 *
 * Crucially, cr === 0 does NOT force cold (leg 1 carries those turns); cr is only
 * an ADDITIONAL sufficient witness, never a necessary one. That is the whole
 * difference from the old rule. See docs/CACHING_AND_SAVINGS.md.
 *
 * @param prev       this session's previous usage-bearing turn, or undefined.
 * @param nowSec     wall-clock seconds of the current turn (replay passes the
 *                   persisted ts so it reproduces the live decision exactly).
 * @param cacheable  this turn's cacheable-prefix tokens (the full-reuse credit
 *                   when warm only via cr, since cr proves a read but not the split).
 * @param cr         observed cache-read tokens this turn (the leg-2 witness).
 * @param ttlSec     cache TTL window (defaults to CACHE_TTL_SEC).
 */
export function deriveBaselineWarmth(
  prev: BaselineWarmthPrev | undefined,
  nowSec: number,
  cacheable: number,
  cr: number,
  ttlSec: number = CACHE_TTL_SEC,
): { warm: boolean; prevCacheable: number } {
  const age = prev !== undefined ? nowSec - prev.ts : Number.POSITIVE_INFINITY;
  // Leg 1: a fresh same-session prior within the TTL (wall-clock warmth).
  const freshPrior = prev !== undefined && age >= 0 && age < ttlSec;
  // Leg 2: an observed read directly witnesses a warm cache. Union of the two.
  const warm = freshPrior || cr > 0;
  // Fresh prior → credit its real measured prefix as reused (the reused/grown
  // split). Warm only via cr (no usable prior) → cr proves a read happened but
  // not the split, so assume full reuse of this turn's cacheable prefix.
  const prevCacheable = freshPrior ? prev!.cacheable : warm ? cacheable : 0;
  return { warm, prevCacheable };
}

/**
 * Weighted input cost for the unproxied TEXT counterfactual (see docs/CACHING_AND_SAVINGS.md).
 *
 * Warmth matters: a TEXT prefix is only a cheap cache-read when a warm cache
 * actually existed this turn. The previous warmth-FREE version always priced
 * the cacheable prefix at CACHE_READ_RATE, which fabricated a "free read" on
 * cold/TTL-expiry turns where text would in fact have paid a 1.25× create —
 * that produced a phantom loss vs the imaged path (which DOES pay the create).
 *
 *   cold turn (first turn / >5min since this session's last turn):
 *     text has no warm cache either ⇒ cacheable×CACHE_CREATE_RATE + coldTail×1.0
 *   warm turn (a prior turn cached the prefix within TTL):
 *     text append-caches ⇒ reused×CACHE_READ_RATE + grown×CACHE_CREATE_RATE + coldTail×1.0
 *     where reused = min(prevCacheable, cacheable), grown = cacheable − reused.
 *     This is what TEXT pays regardless of whether pxpipe's image busted its
 *     own cache on a growth turn — so the real growth loss is preserved.
 *
 * Saving = baseline_eff − actual_eff; can be negative (honestly reported, not floored).
 *
 * @param baselineCacheable  tokens up to the last cache_control marker. ≤0 ⇒ credit nothing.
 * @param warm               was a warm cache available for this session this turn?
 * @param prevCacheable      cacheable prefix size on this session's previous turn (warm only).
 */
export function computeBaselineInputEff(
  baseline: number,
  baselineCacheable: number,
  inputTokens: number,
  cc: number,
  cr: number,
  warm = false,
  prevCacheable = 0,
): number {
  if (baseline <= 0) return 0;
  // Probe miss: can't split prefix from tail, so credit nothing (same as actual).
  if (baselineCacheable <= 0) return computeActualInputEff(inputTokens, cc, cr);
  const cacheable = Math.min(baselineCacheable, baseline);
  const coldTail = baseline - cacheable;
  if (warm) {
    // Text reads the prefix it already had cached (0.10×) and creates only the
    // growth since last turn (1.25×). Independent of the image path's cache.
    const reused = Math.min(Math.max(prevCacheable, 0), cacheable);
    const grown = cacheable - reused;
    return reused * CACHE_READ_RATE + grown * CACHE_CREATE_RATE + coldTail * 1.0;
  }
  // Cold (first turn / TTL expiry): no warm cache for text either, so it
  // re-creates the whole cacheable prefix at the create rate — same event the
  // imaged path pays. Removes the phantom "free read" that fabricated a loss.
  return cacheable * CACHE_CREATE_RATE + coldTail * 1.0;
}

/** Weighted input cost pxpipe actually paid this turn. */
export function computeActualInputEff(
  inputTokens: number,
  cc: number,
  cr: number,
): number {
  return inputTokens + cc * CACHE_CREATE_RATE + cr * CACHE_READ_RATE;
}
