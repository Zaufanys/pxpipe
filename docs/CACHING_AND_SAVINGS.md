# Prompt-caching alignment & honest savings math

This doc answers two questions that keep coming up:

1. **How does pxpipe stay aligned with Anthropic's prompt cache** when it rewrites
   the bulky parts of a request into images? (Rewriting the prefix normally
   *destroys* a warm cache — why doesn't that sink the whole idea?)
2. **How do we compute "savings" without counting the prompt-caching discount as
   if pxpipe earned it?** Caching is a discount Anthropic gives *both* the
   pxpipe and the no-pxpipe path. If we let it land on only our side of the
   ledger we'd be inflating the number. This explains the accounting that
   prevents that.

Source of truth in code: `src/core/baseline.ts` (the math) and
`src/core/transform.ts` (the cache-aligned splice). This doc is the prose
version of the comments there — if they ever disagree, the code wins.

---

## Part 0 — Background: how Anthropic prompt caching actually works

Everything below follows from one invariant:

> **Prompt caching is a prefix match. Any byte change anywhere in the prefix
> invalidates the cache for everything after it.**

Concretely:

- The cache key is derived from the **exact bytes** of the rendered prompt up to
  each `cache_control` breakpoint.
- Render order is **`tools` → `system` → `messages`**. A breakpoint caches
  everything rendered before it.
- A breakpoint is a `"cache_control": {"type": "ephemeral"}` marker on a content
  block. **Max 4 per request.**
- The cached prefix has to clear a **minimum size** or it silently won't cache
  (no error, just `cache_creation_input_tokens: 0`). On **Fable 5 that floor is
  2048 tokens** (pxpipe is Fable-5-only, so that's our number).
- **Pricing**, relative to the base input rate:

  | bucket | what it is | rate |
  |---|---|---:|
  | `input_tokens` | uncached input, paid in full | **1.0×** |
  | `cache_creation_input_tokens` (`cc`) | tokens written to cache this turn (5-min TTL) | **1.25×** |
  | `cache_read_input_tokens` (`cr`) | tokens served from a warm cache | **0.1×** |
  | output | the model's reply (never cached, never compressed) | 5× input on Fable 5 |

- The response `usage` block reports `input_tokens`, `cache_creation_input_tokens`,
  and `cache_read_input_tokens`. **Total prompt size = the sum of all three.**

The economics that make caching matter: a warm read is **~10×** cheaper than
paying full freight, but the *first* turn that establishes a cache entry pays a
**1.25× write premium**. So a stable prefix that's reused across turns is very
cheap after turn 1; a prefix that changes every turn is *more* expensive than
not caching at all (you pay the 1.25× write every time and never read).

That last sentence is the whole problem pxpipe has to solve.

---

## Part 1 — Cache alignment: why rewriting the prefix doesn't break caching

### 1.1 The hazard

Claude Code's request is mostly a big, **stable prefix** — system prompt, tool
docs, `<system-reminder>` blocks, older history — followed by a small,
**per-turn tail** (your new message). Claude Code marks the end of that stable
prefix with a `cache_control` breakpoint, so from turn 2 on the prefix is served
from cache at 0.1×.

pxpipe rewrites parts of that stable prefix into PNGs. The naive way to do that
would **change the cache key**: a prefix that used to be 25k text tokens is now
~2.7k image tokens with different bytes. Anthropic sees a brand-new prefix,
can't match the old cache entry, and charges `cache_create` (1.25×) on the new
content. If pxpipe re-decided every turn — text one turn, image the next — it
would pay that write premium *repeatedly* and never settle into a warm read.
That's "gate flapping," and it's a money-loser.

### 1.2 The rule: relocate the marker, never add one

pxpipe's invariant (the code calls it **Task #21**, in `transform.ts`):

> **pxpipe NEVER adds its own `cache_control` marker. It only *relocates* a
> marker the caller already set, moving it onto the LAST image block produced
> from that content.**

Why this matters:

- It **doesn't spend any of the 4-breakpoint budget.** The number and rough
  position of breakpoints is whatever Claude Code chose; pxpipe just follows the
  text→image flip with the marker so the breakpoint still sits at the *end of
  the same logical content*.
- The cache **anchors at the end of the rewritten static block**, so the
  per-turn *user* content that follows it stays *outside* the cached region and
  doesn't pollute the key. (The per-turn *system* blocks — `<env>` etc. — are
  handled separately, by keeping them out of the image entirely; see 1.3.)

### 1.3 Split static from dynamic *before* imaging

The first move is the one that makes the whole thing cache-safe. Claude Code
mixes a large **static** slab (the system prompt, agent defs, tool docs) with a
handful of **per-turn dynamic** blocks injected into the system text —
`<env>`, `<context>`, `<git_status>`, `<directoryStructure>`,
`<system-reminder>` (the `DYNAMIC_BLOCK_TAGS` list in `transform.ts`). Those
dynamic blocks carry cwd, git branch, today's date, etc., so **their bytes drift
turn-to-turn.**

`splitStaticDynamic` pulls them apart:

- the **static slab** → rendered into the image (this is the cache anchor);
- the **dynamic slab** → forwarded as cheap **text** in the `system` field, never
  imaged.

The reason is exactly the prefix invariant: if a drifting `<env>` block were
baked *into* the image, the image's bytes would change every turn and its cache
entry would die every turn. Keeping the volatile blocks out of the image is what
lets the imaged slab stay byte-identical across turns. There's even a canary —
any *unrecognized* tag-shaped block left in the static slab is surfaced as
telemetry (`unknownTags`), so a future Claude Code release that ships a new
per-turn tag can't silently get baked into the cache.

### 1.4 The cache-friendly splice

After the split, the request is laid out like this (verified against the splice
at the end of `transformRequest` in `transform.ts`):

```
system:  [ billing line ]            ┐ cheap text, NO cache_control
         [ dynamic blocks: <env>… ]  │ (the drifting per-turn slab)
         [ sysRemainder ]            ┘

messages[0] (user):
         [ image block ]            ┐ static, rendered slab
         [ image block ]            │
         [ image block ] ← cache_control   (caller's relocated marker = breakpoint)
         [End of rendered context.] ┐ static text closer for the image
         [ processed existing content ]  ← per-turn user content (incl. reminder
                                            images), NO cache_control
```

Two mechanical constraints drive this shape:

- **Images can only live in a `user` message.** Anthropic's `system` field
  accepts text blocks only — an image there returns
  `400 system.N.type: Input should be 'text'`. So pxpipe moves the imaged slab
  into the first user message; the `system` field is left holding only cheap
  text (billing line + the dynamic slab + any non-text `sysRemainder`).
- **The marker rides the last image.** Whatever block the caller had marked
  (the last static system block, a `<system-reminder>`, etc.), its `cache_control`
  is re-attached to the final image produced from that content, so the breakpoint
  lands right where the static content ends. The per-turn user content that
  follows the closer sits *after* that breakpoint, so it never pollutes the image
  cache key.

The net effect: the imaged slab is *itself* a stable, cacheable prefix. Once it's
written once, every later turn reads it back at 0.1× — exactly like the text
prefix did, but over ~9× fewer tokens.

### 1.5 The one-time "burn" and the anti-flapping gate

There's no free lunch on the **turn pxpipe first flips text→image** (or flips
back). The new image prefix has a different cache key from whatever was warm
before, so that turn pays `cache_create` (1.25×) on the image prefix instead of
`cache_read` (0.1×) on the old text prefix. The profitability gate accounts for
this with a **symmetric burn term** (`isCompressionProfitable` in
`transform.ts`):

```
burnImageSide = priorWarmTokens      × (CACHE_CREATE_RATE − CACHE_READ_RATE)   // = ×1.15
burnTextSide  = priorWarmImageTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)

compress iff   imageTokens + burnImageSide  <  textTokens + burnTextSide
```

> ⚠️ **Implementation note:** the burn term is applied **undivided** — it is *not*
> divided by the horizon. (A JSDoc line on `PxpipeOptions.priorWarmTokens` writes
> `… / N`, but every call site — `evalCompressionProfitability`,
> `isCompressionProfitable`, `isCompressionProfitableAmortized` — computes
> `priorWarmTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)` with no division. The
> code, not that comment, is authoritative.)

The two knobs are what keep the gate from flapping:

- `priorWarmTokens` — tokens the *un-rewritten* (text) prefix would have read
  warm. Charged to the **image** side (flipping to image burns the warm text
  cache, so it discourages compressing while text is warm).
- `priorWarmImageTokens` — tokens the *image* prefix is holding warm. Charged to
  the **text** side (flipping back to text burns the warm image cache).

Without the symmetric term the gate ping-pongs: per-turn cost favors flipping,
the flip forces a fresh `cache_create`, and the next turn flips back — paying the
write premium twice. The burn pins the session in its current mode unless the
per-turn delta genuinely exceeds the flip cost. Cold-start safe: both default to
0, which disables the burn entirely (correct for turn 1 of a fresh conversation).

### 1.6 Where the horizon *does* divide: the history-collapse gate

Separately, the **history-collapse** call site uses
`isCompressionProfitableAmortized`, which is where `historyAmortizationHorizon`
(`N`) earns its keep. It compares *expected lifetime cost* over `N` turns —
worst-case-warm for the image (one `cache_create`, then `cache_read` for turns
2..N) against best-case-warm for the text (`cache_read` every turn):

```
accept the collapse iff   I × (CC + CR×(N−1))  <  T × CR × N
                          where CC = 1.25, CR = 0.10
```

So `N` scales the *main* image-vs-text comparison (e.g. `N=1` ⇒ collapse almost
never wins, `N=10` ⇒ collapse wins when `I < 0.47·T`), while the burn term above
is added on top, undivided. The framing is "assume this prefix gets reused `N`
more times; decide once; eat the loss if the session ends early" — the same logic
as JIT tiered compilation deciding whether to optimize a hot path. Falls back to
the cold per-turn gate when `N ≤ 1`.

> **Takeaway for Part 1:** pxpipe doesn't fight the cache — it rebuilds an
> *equivalent, smaller* cacheable prefix and moves the existing breakpoint to the
> end of it. The cache keeps working; it just covers fewer tokens.

---

## Part 2 — Savings math: how the cache discount is kept *out* of "savings"

### 2.1 The trap we're avoiding

The cache discount is something Anthropic would give **either path**. If you had
*not* run pxpipe, your text prefix would still cache and still read at 0.1× from
turn 2 on. So if we measured pxpipe's savings as "full-price text vs.
cache-discounted image," we'd be crediting pxpipe with a discount the no-pxpipe
path also gets. That double-counts caching as if pxpipe earned it.

The fix is to **apply identical cache pricing to both sides of the same
request**, so the discount cancels in the subtraction and only the *token
reduction* survives as savings.

### 2.2 The measurement (both sides, same request, same moment)

For every `/v1/messages` POST, the proxy does three things in parallel
(`proxy.ts`):

1. **Forward the real (compressed) request** and read its actual `usage` block:
   `input_tokens`, `cc`, `cr`. This is what pxpipe *actually cost*.
2. **`count_tokens` probe on the ORIGINAL, pre-compression body** → `baseline`.
   This is the counterfactual: "what would the request have been if pxpipe were
   off?" `count_tokens` is free and runs concurrently, so it adds no billed cost
   and ~no latency.
3. **`count_tokens` probe on the original body truncated at the last
   `cache_control` marker** → `baselineCacheable`. This is the size of the prefix
   that *would have cached* on the unproxied path.

All three land in the same row of `~/.pxpipe/events.jsonl`, so there's **no
turn-count or run-to-run confound** — both arms are the same request at the same
instant.

### 2.3 The proxied (actual) side — `computeActualInputEff`

```ts
actual_eff = input_tokens
           + cc × 1.25      // CACHE_CREATE_RATE
           + cr × 0.10      // CACHE_READ_RATE
```

Straight from the billed usage block. No modeling — these are the numbers
Anthropic actually charged.

### 2.4 The counterfactual side — `computeBaselineInputEff`

This is the subtle part. We reconstruct what the **unproxied** (text) request
would have been billed *against a text cache built up turn-by-turn the same way*.
The realization that drives the whole function: **a text prefix is only a cheap
cache-read when a warm cache actually existed this turn.** Pricing the cacheable
prefix at the read rate unconditionally fabricates a "free read" on genuinely
cold turns — turns where the text path would in fact pay the 1.25× *create*,
exactly as the imaged path does. That phantom read lands as a fake pxpipe *loss*
on cold/growth turns.

So the baseline is **warmth-aware**, and warmth is the honest **union of two
independent witnesses** that the *text* prefix was cached this turn — warm iff
EITHER fires:

1. **Wall clock** — the same session had a usage-bearing turn **less than
   `CACHE_TTL_SEC` (300s) ago**. The text counterfactual is a *separate*
   hypothetical client whose prefix is **append-only**, so a recent prior turn
   proves that prefix is still cached on Anthropic's side **even when pxpipe
   busted its OWN image cache** (`cr = 0`) by re-rendering the prefix in place
   this turn. The text's cache fate is **not** tied to the image's: pricing it
   warm here correctly *surfaces* the re-imaging loss (cheap warm text < the
   imaged actual) instead of hiding it behind a matching cold baseline.
2. **Observed read** — `cache_read > 0` directly witnesses Anthropic serving a
   cached prefix this turn. This rescues the **first turn after a restart / TTL /
   `SESSION_CAP` eviction**, where this process has no in-memory prior yet but the
   cache is provably warm.

`cr = 0` does **not** force cold — leg 1 carries cache-busted re-renders within
the window. `cr` is only an *additional* sufficient witness, never a necessary
one. That is the entire difference from the old `cr > 0`-only rule, which treated
image and text as one shared cache slot and so mispriced cache-busted re-renders
**cold**, hiding a real loss (see the audit history below).

```
cacheable = min(baselineCacheable, baseline)   // the would-have-cached prefix
coldTail  = baseline − cacheable               // always-cold tail (both paths)
```

Then price `cacheable` by warmth:

| case | condition | how the text path is billed |
|---|---|---|
| **cold turn** | no fresh prior **and** `cr = 0` (first turn, or a >300s gap that let the entry expire with no observed read) | `cacheable × 1.25  +  coldTail × 1.0` |
| **warm turn** | fresh same-session prior <300s ago **OR** `cr > 0` (the union) | `reused × 0.10  +  grown × 1.25  +  coldTail × 1.0` |

where, on a warm turn:

```
reused = min(prevCacheable, cacheable)   // prefix carried from last turn → read at 0.10×
grown  = cacheable − reused              // net-new cacheable bytes this turn → created at 1.25×
```

`prevCacheable` is the cacheable-prefix size on the **same session's previous
turn** when leg 1 fired (a fresh prior). A growth turn (the conversation got
longer) reads the part it already had and creates only the delta; a shrink turn
caps `reused` at the current `cacheable` so `grown = 0`. When the turn is warm
**only** via leg 2 (`cr > 0` but no usable prior — e.g. just after a restart),
there is no measured prior size, so `prevCacheable = cacheable`: `cr` proves a
read happened but not the split, so we credit full reuse. Either way this is what
the **text** path pays *regardless of what pxpipe's image cache did* — if the
image prefix grew and busted its own entry this turn, that real loss stays on the
actual side; the baseline doesn't hide it by also charging the text path a create
it never would have paid.

> **Signature note.**
> `computeBaselineInputEff(baseline, baselineCacheable, inputTokens, cc, cr, warm, prevCacheable)`.
> The `warm` flag and `prevCacheable` are produced by **`deriveBaselineWarmth`**
> (the union: `warm = freshPrior(<300s) || cr > 0`) at every call site — including
> the dashboard/sessions replay path, which passes the **persisted** timestamp so
> it reproduces the live decision exactly. Once warm, the magnitude of the read is
> driven by `prevCacheable` (how much prefix carried over), not by the raw `cr`
> count.

Two guard rails short-circuit before the warmth split:

- `baseline ≤ 0` → return `0` (nothing to compare).
- `baselineCacheable ≤ 0` (no markers in the body, or the cacheable probe failed)
  → we can't split prefix from tail, so we **credit nothing**: return
  `computeActualInputEff(...)`, making savings for that turn exactly `0` rather
  than a guess.

> **Audit history — this has been wrong three times; don't make it four.**
> 1. The *first* baseline collapsed the whole counterfactual into one cache
>    weight (`cr>0 ? 0.1 : cc>0 ? 1.25 : 1.0`). On a warm turn with mixed
>    `cc`/`cr` it priced 100% of the unproxied prefix at `0.1×`, making the
>    unproxied path look 12.5× too cheap and pxpipe look like it *lost money*
>    (a 7-event May-2026 sample swung from −9,786 "saved" to +19,452 once the
>    prefix was split from the tail).
> 2. The split version was still **warmth-free** — it always read the cacheable
>    prefix at `0.1×`. That fabricated the "free read" above, resurfacing a
>    phantom loss on cold/TTL-expiry turns where text really pays the create.
> 3. The warmth fix in (2) gated `warm` too narrowly, in two ways that both
>    priced a **genuinely warm** text prefix COLD — each producing the opposite
>    lie:
>    - **Requiring an in-memory prior** missed the first turn after a restart /
>      TTL / `SESSION_CAP` eviction (cache warm on Anthropic's side, `cr > 0`, but
>      no prior in this process). Priced cold, its baseline was billed the 1.25×
>      create against a cheap warm actual — **fabricating an inflated "99% saved"
>      row** (the operator's originally reported bug).
>    - **Requiring an observed read (`cr > 0`)** missed the **cache-busted
>      re-render within the TTL**: pxpipe re-imaged the append-only prefix in
>      place, so the image missed (`cr = 0`) and paid the create, but the text
>      prefix was still cached. Pricing it cold gave the baseline a matching cold
>      create, so the row showed ≈0 — **hiding a real re-imaging loss** (the
>      inverse of the (2) phantom-saving bug).
> 4. Both of (3) are fixed by the **union**: `warm = freshPrior(<300s) || cr > 0`.
>    Leg 1 (wall clock) prices cache-busted re-renders warm so the loss surfaces;
>    leg 2 (`cr`) rescues the no-prior post-restart turn. The text counterfactual
>    is a *separate* append-only client — its cache fate is decoupled from whether
>    pxpipe busted its own image cache.
>
> The current model does all of it: split the prefix, gate the read rate on real
> warmth, and take the **union** of the wall-clock prior and the observed read so
> neither a phantom saving (2) nor a hidden loss (3) can return.
> `tests/baseline.test.ts` locks `cold(prefix) > warm(prefix)` and the union truth
> table; `tests/dashboard-api.test.ts` and the sessions replay tests lock both the
> cache-busted-re-render-within-TTL case (warm text, cold image, **loss surfaced**)
> and the post-restart `cr`-only case, so none of these regressions can creep back.

### 2.5 Savings = the difference (caching already cancelled)

```
savings_eff (input) = baseline_eff − actual_eff
```

Output tokens are **excluded from both sides** — they're identical on the two
paths (pxpipe never touches the response) and accumulate in their own dashboard
bucket. For the **dollar** headline, both sides are converted with the same
Fable 5 list ratios — `input ×1.0, cache_write ×1.25, cache_read ×0.1,
output ×5` — and since those weights are applied identically on both arms, the
caching discount and the output cost both cancel out of the *difference*. What's
left is purely the text→image token reduction.

### 2.6 Worked example — same body, warm vs cold

Take one body two ways. **30,000 tokens**, of which **28,000** are the cacheable
prefix (`baseline = 30000`, `baselineCacheable = 28000`), so `coldTail = 2000`.
pxpipe images that prefix down to ~3,000 image tokens.

**(a) Mid-session warm turn.** The previous turn cached a 27,000-token prefix
(`prevCacheable = 27000`), so the prefix grew 1,000 this turn. The real response
bills `input_tokens = 2000`, `cc = 1000`, `cr = 3000`.

```
Counterfactual (text, warm):
  reused = min(27000, 28000) = 27000
  grown  = 28000 − 27000     = 1000
  baseline_eff = 27000×0.10 + 1000×1.25 + 2000×1.0
               = 2700 + 1250 + 2000 = 5,950

Proxied (actual):
  actual_eff = 2000 + 1000×1.25 + 3000×0.10
             = 2000 + 1250 + 300 = 3,550

Savings = 5950 − 3550 = 2,400 token-equivalents (~40%)
```

The `grown × 1.25` term (1,250) is the same net-new content both paths must
create — it cancels against the actual `cc` term. The win is that the proxied arm
reads **3,000 image tokens** at 0.1× where the text arm reads **27,000** — 9×
fewer tokens sitting under the same discount. That reduction, not the cache
discount, is what pxpipe is credited with.

**(b) Cold turn (first turn or a >5-min idle).** Same body, but *genuinely* no
warm cache for either path — no fresh same-session prior **and** `cr = 0`. The
imaged request creates its ~3,000-token image prefix cold: `input_tokens = 2000`,
`cc = 3000`, `cr = 0`. Both legs of the union fail, so the text counterfactual is
priced cold too: it would equally have re-created its prefix. (`cr = 0` *alone*
is not the tell — a `cr = 0` turn that sits <300s after a prior is warm via leg 1;
that's case (c).)

```
Counterfactual (text, cold):
  baseline_eff = 28000×1.25 + 2000×1.0
               = 35000 + 2000 = 37,000

Proxied (actual):
  actual_eff = 2000 + 3000×1.25 + 0
             = 2000 + 3750 = 5,750

Savings = 37000 − 5750 = 31,250 token-equivalents
```

The cold turn is pxpipe's biggest win: the text path eats a full `28000×1.25`
create; the image path eats only `3000×1.25`.

> This genuinely-cold turn is what the **warmth-free** version got wrong: it
> always read the prefix at `28000×0.10 = 2,800` → `baseline_eff = 4,800`, then
> subtracted the real `actual_eff = 5,750` for a **−950 "loss"** on a turn that
> actually saved 31,250. The union prices it cold the *honest* way — both legs
> fail (no fresh prior **and** `cr = 0`), so the text path re-creates its prefix
> at 1.25× exactly as the imaged path does, and the phantom loss is gone. A
> `cr = 0` turn that *does* sit <300s after a prior is the opposite animal: leg 1
> fires, the text is warm, and pricing it cold would hide a loss — that's (c).

**(c) Cache-busted re-render inside the window (warm text, cold image).** The
*identical* actual request to (b) — `input_tokens = 2000`, `cc = 3000`, `cr = 0`
(pxpipe re-rendered the image prefix in place, so its own image cache missed) —
but this turn lands <300s after a prior that cached a 27,000-token prefix
(`prevCacheable = 27000`, grown 1,000). Leg 1 fires, so the text counterfactual is
**warm** even though `cr = 0`:

```
Counterfactual (text, warm — leg 1, prefix was cached regardless of the image):
  reused = min(27000, 28000) = 27000
  grown  = 28000 − 27000     = 1000
  baseline_eff = 27000×0.10 + 1000×1.25 + 2000×1.0
               = 2700 + 1250 + 2000 = 5,950

Proxied (actual, image re-created cold):
  actual_eff = 2000 + 3000×1.25 + 0
             = 2000 + 3750 = 5,750

Savings = 5950 − 5750 = 200 token-equivalents (≈ break-even)
```

The text prefix was cached no matter what pxpipe did to its image, so it is priced
warm and the re-render's full `3000×1.25` create lands on the **actual** side
where it belongs — here a near wash.

> **Why the union, not `cr`, decides this.** (b) and (c) send the byte-identical
> actual request (`cr = 0`); only the wall-clock prior differs. The old
> `cr > 0`-only rule can't tell them apart — it prices the text **cold** in both
> and reports (b)'s `37000 − 5750 = +31,250` for (c) too, a **+31,050 phantom
> saving** on a turn pxpipe barely won. Push the re-imaged prefix up relative to
> the stable text and (c)'s real number turns **negative** — a genuine re-imaging
> loss the cr-only rule buries under that same fake cold create. Leg 1 is what
> keeps (c) honest. `tests/dashboard-api.test.ts` locks exactly this contrast.

---

## Part 3 — Reproduce it yourself

Every row in `~/.pxpipe/events.jsonl` carries both arms of the same request.
**The JSONL uses shortened key names** (mapped from the Anthropic usage block in
`tracker.ts` → `toTrackEvent`):

- `baseline_tokens` — `count_tokens` on the original body (full counterfactual)
- `baseline_cacheable_tokens` — `count_tokens` truncated at the last
  `cache_control` marker (omitted/`0` if the body had no markers)
- `first_user_sha8` — the **session key**. Rows sharing this value are the same
  conversation; warmth comes from `deriveBaselineWarmth` over consecutive rows
  that share it — a fresh prior within the 300s TTL **or** an observed `cr > 0`.
- the billed `input_tokens`, `cache_create_tokens` (← Anthropic's
  `cache_creation_input_tokens`), and `cache_read_tokens` (← Anthropic's
  `cache_read_input_tokens`) from the real response. (A 1-hour cache tier, if
  ever used, splits out as `cache_create_5m_tokens` / `cache_create_1h_tokens`.)

Because warmth is a **cross-turn** property, replay isn't purely per-row: group
rows by `first_user_sha8`, sort each group by `ts`, then walk each session in
time order. For each row call
`deriveBaselineWarmth(prev, ts, baseline_cacheable_tokens, cache_read_tokens)` —
the exact function the live path uses — where `prev` is the previous in-session
row (or `undefined` for the first). It returns `{ warm, prevCacheable }` via the
**union**: warm iff a fresh same-session prior exists within the 300s TTL **or**
`cache_read_tokens > 0`. So a post-restart row with no in-session prior but
`cr > 0` still prices warm, and a `cr = 0` re-render <300s after a prior still
prices warm — neither falls through to cold. (`prevCacheable` follows: the prior
row's `baseline_cacheable_tokens` when the fresh-prior leg fired, else this row's
own `cacheable` when warm via `cr` alone, else `0`.) Feed `(baseline_tokens,
baseline_cacheable_tokens, input_tokens, cache_create_tokens, cache_read_tokens,
warm, prevCacheable)` through `computeBaselineInputEff` and the billed triple
through `computeActualInputEff` (both exported from `src/core/baseline.ts`), sum
the per-row differences, convert with the list ratios above, and you've re-derived
the headline. The live dashboard (`DashboardState`) and the JSONL replay both call
these **same functions** with the persisted `ts`, so the views can't drift.

### Edge cases worth knowing

- **No `cache_control` markers in the body** (or the cacheable probe failed) →
  `baselineCacheable ≤ 0`, so `computeBaselineInputEff` returns
  `computeActualInputEff(...)` and the row contributes **exactly 0 savings** — we
  refuse to invent a prefix we couldn't measure. The `partial`/`unmeasured`
  status flags in `transform.ts` record a failed probe so it reads as a visible
  zero rather than silently biasing the rollup.
- **Uncompressed turns are credited 0.** A row pxpipe didn't compress (e.g. a
  body below the min-chars gate) carries the cost-side gate `creditSaving =
  haveBaseline && haveUsage && compressed`; when `compressed` is false the
  baseline is forced to equal the actual, so passthrough turns can't manufacture
  phantom savings.
- **Cold turns cost more on the text side, by design.** The cold branch prices
  the cacheable prefix at the 1.25× create rate, never the read rate — this is
  the warmth fix, not a bug. `tests/baseline.test.ts` asserts
  `cold(prefix) > warm(prefix)` for the same prefix.
- **Output is never in this math.** It's identical on both arms and lives in its
  own accumulator.

---

## One-paragraph summary

pxpipe stays cache-aligned by rebuilding an *equivalent but smaller* cacheable
prefix out of images and **relocating** the caller's existing `cache_control`
marker onto the last image — it never adds a marker of its own, so the cache
breakpoint still sits at the end of the same logical content and the per-turn
tail stays outside the cached region. The one-time `cache_create` "burn" on the
flip turn is charged to whichever side would force it, which pins the gate
against mode-flapping; the history-collapse gate separately weighs image-vs-text
cost over an expected reuse horizon. Savings are then measured by pricing
**both** the real request and a `count_tokens` counterfactual of the original
body with the **same** cache rates (create 1.25×, read 0.1×) and the **same
warmth** — the text counterfactual only reads its prefix cheaply on a turn where
the cache genuinely existed for it (a fresh same-session prior within the 300s
TTL, **or** an observed read `cr > 0`), and pays the create otherwise, exactly as
the imaged path does. Because both arms face the
same discount under the same warmth, it cancels in the difference and what
remains as "savings" is only the token reduction from turning dense text into
images, never the prompt-caching discount itself.
