/**
 * Tests for the new /api/* dashboard endpoints. We instantiate a
 * DashboardState directly against a tmpdir SessionsPaths and call its
 * serve* methods, then assert on the JSON body. No real HTTP server — the
 * route dispatch lives in node.ts and would just be a thin re-export of the
 * same calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DashboardState, dashboardPath } from '../src/dashboard.js';
import { getAllowedModelBases, setAllowedModelBases } from '../src/core/applicability.js';
import type { SessionsPaths } from '../src/sessions.js';
import type { TrackEvent } from '../src/core/tracker.js';
import type { StatsPayload, RecentPayload } from '../src/dashboard/types.js';

function makeTmp(): SessionsPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-dashapi-'));
  return {
    eventsFile: path.join(dir, 'events.jsonl'),
    sidecarDir: path.join(dir, '4xx-bodies'),
  };
}

function ev(p: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-05-19T00:00:00Z',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration_ms: 100,
    ...p,
  };
}

function writeEvents(paths: SessionsPaths, events: TrackEvent[]): void {
  fs.mkdirSync(path.dirname(paths.eventsFile), { recursive: true });
  fs.writeFileSync(
    paths.eventsFile,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

let tmp: SessionsPaths;
let dash: DashboardState;
beforeEach(() => {
  tmp = makeTmp();
  // Inject an empty Claude Code map so tests don't scan the developer's real
  // ~/.claude/projects/ directory (slow + flaky depending on which machine
  // the suite runs on). Tests that need a populated map can re-construct.
  dash = new DashboardState(tmp, async () => new Map());
});
afterEach(() => {
  try {
    fs.rmSync(path.dirname(tmp.eventsFile), { recursive: true, force: true });
  } catch {
    /* leak the tmpdir; OS will reap */
  }
});

// ---- dashboardPath route table -------------------------------------------

describe('dashboardPath()', () => {
  it('matches the main HTML routes', () => {
    expect(dashboardPath('/')?.kind).toBe('html');
    expect(dashboardPath('/dashboard')?.kind).toBe('html');
  });

  it('matches the legacy live-poll routes', () => {
    expect(dashboardPath('/proxy-stats')?.kind).toBe('stats');
    expect(dashboardPath('/proxy-recent')?.kind).toBe('recent');
    expect(dashboardPath('/proxy-latest-png')?.kind).toBe('png');
  });

  it('matches the new /api/* routes', () => {
    expect(dashboardPath('/api/sessions.json')?.kind).toBe('api-sessions');
    expect(dashboardPath('/api/stats.json')?.kind).toBe('api-stats');
  });

  it('returns null for unknown paths', () => {
    expect(dashboardPath('/v1/messages')).toBeNull();
    expect(dashboardPath('/api/whatever.json')).toBeNull();
    // The per-session detail routes were cut — these no longer match.
    expect(dashboardPath('/api/sessions/abc12345.json')).toBeNull();
    expect(dashboardPath('/sessions/abc12345')).toBeNull();
  });
});

// ---- /api/sessions.json --------------------------------------------------

describe('serveSessionsJson', () => {
  it('returns a list of grouped sessions with claudeCode null when no ~/.claude/projects/ match', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/x', ts: '2026-05-19T00:00:00Z' }),
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/x', ts: '2026-05-19T00:01:00Z' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/y', ts: '2026-05-19T00:02:00Z' }),
    ]);
    const res = await dash.serveSessionsJson();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.sessions).toHaveLength(2);
    // Most-recent-first
    expect(body.sessions[0].id).toBe('bbbbbbbb');
    expect(body.sessions[1].id).toBe('aaaaaaaa');
    expect(body.sessions[0].claudeCode).toBeNull();
  });

  it('respects ?project filtering', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/Users/me/code/pxpipe' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/Users/me/code/other' }),
    ]);
    const res = await dash.serveSessionsJson({ project: 'pxpipe' });
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.sessions[0].id).toBe('aaaaaaaa');
  });

  it('returns 503 when DashboardState was built without paths', async () => {
    const bare = new DashboardState();
    const res = await bare.serveSessionsJson();
    expect(res.status).toBe(503);
  });
});

// ---- /api/stats.json ------------------------------------

describe('serveApiStats', () => {
  it('aggregates the events file into a Summary-shaped JSON', async () => {
    writeEvents(tmp, [
      ev({ status: 200, compressed: true, orig_chars: 1000, image_bytes: 200 }),
      ev({ status: 200, compressed: true, orig_chars: 2000, image_bytes: 300 }),
      ev({ status: 400, compressed: false }),
    ]);
    const res = await dash.serveApiStats();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed).toBe(3);
    expect(body.summary.total).toBe(3);
    expect(body.summary.ok2xx).toBe(2);
    expect(body.summary.err4xx).toBe(1);
    expect(body.summary.compressed).toBe(2);
    expect(body.summary.passthrough).toBe(1);
    expect(body.summary.origCharsTotal).toBe(3000);
    expect(body.summary.imageBytesTotal).toBe(500);
  });

  it('404s when no events file exists', async () => {
    const res = await dash.serveApiStats();
    expect(res.status).toBe(404);
  });
});

// ---- /fragments/* (htmx server-rendered HTML) ------------------------

describe('serveFragment', () => {
  const url = new URL('http://localhost/fragments/x');

  it('routes /fragments/<name> via dashboardPath', () => {
    expect(dashboardPath('/fragments/header')).toEqual({ kind: 'fragment', name: 'header' });
    expect(dashboardPath('/fragments/latest')).toEqual({ kind: 'fragment', name: 'latest' });
  });

  it('renders the toggle fragment reflecting compression state', async () => {
    const on = await dash.serveFragment('toggle', url, 1234);
    expect(on.headers.get('content-type')).toContain('text/html');
    expect(await on.text()).toContain('Disable compression');
    dash.handleCompressionToggle({ enabled: false });
    const off = await dash.serveFragment('toggle', url, 1234);
    const offHtml = await off.text();
    expect(offHtml).toContain('PASSTHROUGH MODE');
    expect(offHtml).toContain('Enable compression');
    dash.handleCompressionToggle({ enabled: true });
  });

  it('renders and mutates GPT 5.5/5.6 chips via the single model scope', async () => {
    const prev = process.env.PXPIPE_MODELS;
    try {
      delete process.env.PXPIPE_MODELS;
      setAllowedModelBases(null); // reset to built-in default (Fable 5 + GPT 5.6)
      const on = await (await dash.serveFragment('models', url, 1234)).text();
      expect(on).toContain('Image GPT models');
      // GPT 5.6 is on by default; GPT 5.5 is opt-in (off until toggled).
      expect(on).toContain('GPT 5.6 ✓');
      expect(on).toContain('GPT 5.5</button>');
      // GPT 5.6 renders to the left of GPT 5.5.
      expect(on.indexOf('GPT 5.6')).toBeLessThan(on.indexOf('GPT 5.5'));
      expect(getAllowedModelBases()).toContain('gpt-5.6');
      expect(getAllowedModelBases()).not.toContain('gpt-5.5');

      dash.handleModelsToggle('gpt-5.5', true);
      const onBoth = await (await dash.serveFragment('models', url, 1234)).text();
      expect(onBoth).toContain('GPT 5.5 ✓');
      expect(onBoth).toContain('GPT 5.6 ✓');
      expect(getAllowedModelBases()).toContain('gpt-5.5');
      expect(getAllowedModelBases()).toContain('gpt-5.6');
    } finally {
      setAllowedModelBases(null);
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('renders header + recent + stats fragments from the same payloads as JSON', async () => {
    writeEvents(tmp, [
      ev({ status: 200, model: 'gpt-5.5', compressed: true, orig_chars: 1000, image_bytes: 200 }),
    ]);
    const header = await (await dash.serveFragment('header', url, 4711)).text();
    expect(header).toContain('4711');
    await dash.replay(tmp.eventsFile);
    const recent = await (await dash.serveFragment('recent', url, 4711)).text();
    expect(recent).toContain('<table');
    expect(recent).toContain('gpt-5.5');
    const stats = await (await dash.serveFragment('stats', url, 4711)).text();
    expect(stats).toContain('requests');
  });

  it('escapes HTML in latest source text', async () => {
    dash.captureImage({
      imagePngs: [new Uint8Array([137, 80, 78, 71])],
      imageDims: [{ width: 100, height: 80 }],
      imageSourceText: '<script>alert(1)</script>',
    } as never);
    const srcUrl = new URL('http://localhost/fragments/latest?source=1');
    const html = await (await dash.serveFragment('latest', srcUrl, 1)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('404s unknown fragments', async () => {
    const res = await dash.serveFragment('nope', url, 1);
    expect(res.status).toBe(404);
  });
});

// ---- GPT (OpenAI) savings split ------------------------------------------
// The dashboard math was built entirely around the Anthropic cache-aware
// baseline, so GPT rows used to surface all-zero columns. These lock the
// GPT branch in update()/replay(): vision-token actual vs o200k text-token
// baseline, 0.1× automatic prefix cache, no count_tokens probe.
describe('GPT savings split', () => {
  // Imaged 50k o200k text tokens down to 8k vision tokens, with a 2k cached
  // prefix served at 0.1×:
  //   actual   = (10000 - 2000) + 2000×0.1               = 8200
  //   baseline = actual + (50000 - 8000)×0.1             = 12400
  //   saved    = baseline - actual                       = 4200
  const gptUpdate = {
    method: 'POST',
    path: '/openai/responses',
    model: 'gpt-5.5',
    status: 200,
    durationMs: 100,
    usage: { input_tokens: 10000, output_tokens: 200, cached_tokens: 2000 },
    info: {
      compressed: true,
      imageTokens: 8000,
      baselineImagedTokens: 50000,
      imageCount: 1,
      firstUserSha8: 'gptsess1',
    },
  };

  it('credits GPT savings on a compressed Responses request (live update + stats)', async () => {
    dash.update(structuredClone(gptUpdate) as never);
    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.requests).toBe(1);
    expect(stats.actual_input_weighted).toBe(8200);
    expect(stats.baseline_input_weighted).toBe(12400);
    expect(stats.saved_input_tokens).toBe(4200);
    expect(stats.saved_pct_input_only).toBeGreaterThan(0);
  });

  it('populates As-text / Sent / Cache-hits / Saved recent columns for GPT', async () => {
    dash.update(structuredClone(gptUpdate) as never);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.path).toContain('responses');
    expect(row.cc_added).toBe(1); // "Sent as" → imaged
    expect(row.cache_read).toBe(2000); // cached_tokens, NOT Anthropic cache_read
    expect(row.baseline_input).toBe(12400); // "As text"
    expect(row.actual_input).toBe(8200); // "Sent"
    expect(row.session_saved_so_far_delta).toBe(4200); // "Saved"
  });

  it('prices a GPT cold turn (cached_tokens=0) at the FULL text delta, not the 0.1× warm rate', async () => {
    // Parity with the Anthropic cold-miss test: when OpenAI reports no cached
    // tokens, the text counterfactual was cold too, so the whole text↔image
    // delta is credited at 1.0× (not 0.1×). Under-pricing it here would HIDE a
    // real win; over-pricing it on a warm turn would FABRICATE one — both wrong.
    //   actual   = 10000 (no cache discount)
    //   baseline = 10000 + (50000 - 8000)×1.0 = 52000
    //   saved    = 42000
    dash.update({
      ...structuredClone(gptUpdate),
      usage: { input_tokens: 10000, output_tokens: 200, cached_tokens: 0 },
      info: { ...structuredClone(gptUpdate.info), firstUserSha8: 'gptcold' },
    } as never);
    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.actual_input_weighted).toBe(10000);
    expect(stats.baseline_input_weighted).toBe(52000);
    expect(stats.saved_input_tokens).toBe(42000);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.cache_read).toBe(0);
    expect(row.baseline_input).toBe(52000);
    expect(row.actual_input).toBe(10000);
  });

  it('does not credit savings on an uncompressed GPT passthrough row', async () => {
    dash.update({
      ...structuredClone(gptUpdate),
      info: {
        compressed: false,
        imageTokens: 0,
        baselineImagedTokens: 0,
        firstUserSha8: 'gptsess2',
      },
    } as never);
    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.saved_input_tokens).toBe(0);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    expect(recent.recent.at(-1)!.session_saved_so_far_delta ?? 0).toBe(0);
  });

  it('replay() reconstructs GPT recent rows byte-identically to the live path', async () => {
    writeEvents(tmp, [
      ev({
        path: '/openai/responses',
        model: 'gpt-5.5',
        compressed: true,
        input_tokens: 10000,
        output_tokens: 200,
        cached_tokens: 2000,
        image_tokens: 8000,
        baseline_imaged_tokens: 50000,
        image_count: 1,
        first_user_sha8: 'gptsess1',
      }),
    ]);
    await dash.replay(tmp.eventsFile);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.cache_read).toBe(2000);
    expect(row.baseline_input).toBe(12400);
    expect(row.actual_input).toBe(8200);
    expect(row.session_saved_so_far_delta).toBe(4200);
  });
});

describe('union warmth: fresh wall-clock prior OR cr>0 (no phantom savings, no hidden losses)', () => {
  // The text counterfactual's warmth is the honest UNION of two independent
  // witnesses that the TEXT prefix was cached this turn: a fresh same-session
  // prior within the TTL (wall clock), OR an observed read (cr>0). The text
  // prefix is append-only, so a recent prior keeps it warm even when pxpipe
  // busts its OWN image cache (cr=0) by re-rendering the prefix in place. On
  // such a turn pxpipe really did pay the 1.25× create, so pricing the text
  // baseline warm correctly SURFACES that re-imaging loss instead of hiding it
  // behind a matching cold baseline — gating warmth on cr alone fabricated a
  // win out of a real loss. (The cr>0 leg separately rescues the post-restart
  // turn that has no in-memory prior yet but is provably cached on Anthropic's
  // side.)

  // A warm-priming turn followed by a cache-busted re-render (cr=0) in the SAME
  // session within the TTL. The fresh prior makes the text baseline warm, so
  // the row reads the still-cached text prefix cheaply and honestly shows the
  // re-imaging loss rather than a phantom saving.
  function antEvt(
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    },
    cacheable: number,
    sid = 'warmsess',
  ): unknown {
    return {
      ts: '2026-05-19T00:00:00Z',
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-opus-4',
      status: 200,
      duration_ms: 100,
      usage,
      info: {
        compressed: true,
        firstUserSha8: sid,
        baselineProbeStatus: 'ok',
        baselineTokens: 30000, // text counterfactual: full prefix + tail
        baselineCacheableTokens: cacheable, // prefix up to the cache_control marker
      },
    };
  }

  it('surfaces the re-imaging loss on a cache-busted re-render within the TTL', async () => {
    // Turn 1: genuine warm read — primes the per-session warmth map.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20000, // warm read
        },
        20000,
      ) as never,
    );

    // Turn 2: pxpipe busted its OWN image cache and re-rendered the prefix in
    // place — cache_read === 0, full re-create. But the TEXT prefix is
    // append-only and still cached (fresh same-session prior within the TTL),
    // so the text counterfactual is warm.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20000, // re-created the whole prefix
          cache_read_input_tokens: 0, // ← the image-cache miss
        },
        20000,
      ) as never,
    );

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const miss = recent.recent.at(-1)!;

    // pxpipe's image really did miss — it paid the cold create this turn.
    expect(miss.cache_read).toBe(0);

    // actual = 100 + 20000×1.25 = 25100 (what pxpipe actually paid this turn).
    expect(miss.actual_input).toBe(25100);

    // WARM text baseline: a text-only client would have READ its still-cached
    // append-only prefix at 0.1× (20000×0.1) + 10000 cold tail = 12000 — NOT
    // the cold 20000×1.25 + 10000 = 35000 the old cr-alone rule produced.
    expect(miss.baseline_input).toBe(12000);

    // So this turn is an HONEST LOSS: pxpipe's re-imaging cost 13100 tokens more
    // than a text-only client would have paid (12000 − 25100). The dashboard
    // surfaces it — not floored, not hidden behind a matching cold baseline.
    expect(miss.session_saved_so_far_delta).toBe(-13100);
    expect(miss.session_saved_so_far_delta!).toBeLessThan(0);
  });

  it('still prices a genuine warm turn warm (cr>0 reads the prefix cheaply)', async () => {
    // Prime, then a real warm turn: cache_read > 0, small growth.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20000,
          cache_read_input_tokens: 0,
        },
        20000,
      ) as never,
    );
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 2000, // grew the prefix by 2000
          cache_read_input_tokens: 20000, // warm read of the rest
        },
        22000,
      ) as never,
    );

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const warm = recent.recent.at(-1)!;
    expect(warm.cache_read).toBe(20000);
    // actual = 100 + 2000×1.25 + 20000×0.1 = 4600.
    expect(warm.actual_input).toBe(4600);
    // warm baseline: 20000×0.1 (reused) + 2000×1.25 (grown) + 8000 tail = 12500.
    expect(warm.baseline_input).toBe(12500);
    expect(warm.session_saved_so_far_delta).toBe(7900);
  });

  it('prices a warm read warm even with NO prior warmth state (post-restart)', async () => {
    // The cache is already warm on Anthropic's side (cr>0), but this process has
    // never seen the session — exactly the first turn after a pxpipe restart, a
    // >5min idle (TTL eviction), or a SESSION_CAP eviction. The OLD code required
    // an in-memory warmthPrev entry, so it fell through to the COLD branch and
    // billed the known-cached prefix the 1.25× CREATE rate — fabricating the
    // inflated "99% saved" row the operator reported. cr>0 is direct proof the
    // prefix was cached, so it must be priced as a warm READ.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20000, // warm read on the FIRST turn we see
        },
        20000,
        'restartsess', // never primed in this process
      ) as never,
    );

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.cache_read).toBe(20000);

    // actual = 100 + 20000×0.1 = 2100 (we paid the warm read rate).
    expect(row.actual_input).toBe(2100);

    // Warm baseline with full prefix reuse (no prior ⇒ prevCacheable = cacheable):
    // 20000×0.1 (reused) + 0 (grown) + 10000 tail = 12000. NOT the cold
    // 20000×1.25 + 10000 = 35000 the old code produced (which would have shown a
    // 32900-token / ~94% "saved" against a 2100-token actual — the inflated row).
    expect(row.baseline_input).toBe(12000);
    expect(row.baseline_input).not.toBe(35000); // the inflated cold-priced bug value
    expect(row.session_saved_so_far_delta).toBe(9900);
  });
});
