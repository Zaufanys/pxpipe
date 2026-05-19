import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  aggregateSessions,
  collectSessionEvents,
  diskUsage,
  filterSessions,
  prune,
  redactEvent,
  selectSessionsToRemove,
  type SessionsPaths,
} from '../src/sessions.js';
import type { TrackEvent } from '../src/core/tracker.js';

// ---- Test scaffolding ------------------------------------------------------

/** Build a tmpdir with a fresh events.jsonl and 4xx-bodies/ for each test. We
 *  intentionally keep this synchronous and verbose — the prune surface is
 *  small enough that test setup doubles as documentation. */
function makeTmp(): SessionsPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpipe-sessions-'));
  const eventsFile = path.join(dir, 'events.jsonl');
  const sidecarDir = path.join(dir, '4xx-bodies');
  return { eventsFile, sidecarDir };
}

function ev(partial: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-05-18T00:00:00Z',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration_ms: 100,
    ...partial,
  };
}

function writeEvents(paths: SessionsPaths, events: TrackEvent[]): void {
  fs.mkdirSync(path.dirname(paths.eventsFile), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(paths.eventsFile, lines);
}

function writeSidecar(
  paths: SessionsPaths,
  name: string,
  bytes = 256,
): string {
  fs.mkdirSync(paths.sidecarDir, { recursive: true });
  const full = path.join(paths.sidecarDir, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, 'x'));
  return full;
}

let tmp: SessionsPaths;
beforeEach(() => {
  tmp = makeTmp();
});
afterEach(() => {
  // Best-effort cleanup; on failure the tmpdir leaks but the OS handles it.
  try {
    fs.rmSync(path.dirname(tmp.eventsFile), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---- Aggregation -----------------------------------------------------------

describe('aggregateSessions', () => {
  it('groups events by first_user_sha8', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-05-18T00:00:00Z', first_user_sha8: 'aaaaaaaa', cwd: '/a' }),
      ev({ ts: '2026-05-18T00:00:01Z', first_user_sha8: 'aaaaaaaa', cwd: '/a' }),
      ev({ ts: '2026-05-18T00:00:02Z', first_user_sha8: 'bbbbbbbb', cwd: '/b' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    expect(sessions.size).toBe(2);
    expect(sessions.get('aaaaaaaa')?.requestCount).toBe(2);
    expect(sessions.get('bbbbbbbb')?.requestCount).toBe(1);
  });

  it('uses earliest ts for firstSeen and latest for lastSeen even when input is unordered', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-05-18T00:00:05Z', first_user_sha8: 'aaaaaaaa' }),
      ev({ ts: '2026-05-18T00:00:01Z', first_user_sha8: 'aaaaaaaa' }),
      ev({ ts: '2026-05-18T00:00:09Z', first_user_sha8: 'aaaaaaaa' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const s = sessions.get('aaaaaaaa')!;
    expect(s.firstSeen).toBe('2026-05-18T00:00:01Z');
    expect(s.lastSeen).toBe('2026-05-18T00:00:09Z');
  });

  it('puts events with no first_user_sha8 into <unknown>', async () => {
    writeEvents(tmp, [ev({ first_user_sha8: undefined })]);
    const { sessions } = await aggregateSessions(tmp);
    expect(sessions.has('<unknown>')).toBe(true);
  });

  it('credits sidecar bytes to the right session', async () => {
    const sidecar = writeSidecar(tmp, 'sample.json.gz', 1024);
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', req_body_sample_path: sidecar }),
      ev({ first_user_sha8: 'bbbbbbbb' }),
    ]);
    const { sessions, sidecarsBySession } = await aggregateSessions(tmp);
    expect(sessions.get('aaaaaaaa')?.sidecarBytes).toBe(1024);
    expect(sessions.get('bbbbbbbb')?.sidecarBytes).toBe(0);
    expect(sidecarsBySession.get('aaaaaaaa')?.has(sidecar)).toBe(true);
  });

  it('returns empty when events.jsonl is missing', async () => {
    const missing: SessionsPaths = {
      eventsFile: path.join(path.dirname(tmp.eventsFile), 'nope.jsonl'),
      sidecarDir: tmp.sidecarDir,
    };
    const { sessions } = await aggregateSessions(missing);
    expect(sessions.size).toBe(0);
  });

  it('drops malformed JSONL lines silently', async () => {
    fs.mkdirSync(path.dirname(tmp.eventsFile), { recursive: true });
    fs.writeFileSync(
      tmp.eventsFile,
      [
        JSON.stringify(ev({ first_user_sha8: 'aaaaaaaa' })),
        'this is not json',
        JSON.stringify(ev({ first_user_sha8: 'aaaaaaaa' })),
      ].join('\n') + '\n',
    );
    const { sessions } = await aggregateSessions(tmp);
    expect(sessions.get('aaaaaaaa')?.requestCount).toBe(2);
  });

  it('accumulates tokens saved using honest formula (allows negative)', async () => {
    writeEvents(tmp, [
      // 100,000 chars compressed to 2 images.
      //   textTokens  = 100000/4 = 25000
      //   imageTokens = 2 × 2500 = 5000
      //   tokensSaved = +20000  → win
      ev({
        first_user_sha8: 'aaaaaaaa',
        compressed: true,
        orig_chars: 100_000,
        compressed_chars: 100_000,
        image_count: 2,
      }),
      // 5,000 chars compressed to 1 image — NET LOSS.
      //   textTokens  = 5000/4 = 1250
      //   imageTokens = 1 × 2500 = 2500
      //   tokensSaved = -1250  → loss; must NOT be clamped
      ev({
        first_user_sha8: 'aaaaaaaa',
        compressed: true,
        orig_chars: 5_000,
        compressed_chars: 5_000,
        image_count: 1,
      }),
      // Not compressed at all — skipped.
      ev({
        first_user_sha8: 'aaaaaaaa',
        compressed: false,
        orig_chars: 1000,
        image_count: 0,
      }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const s = sessions.get('aaaaaaaa')!;
    // 20000 + (-1250) = 18750 tokens net.
    expect(s.tokensSavedEst).toBe(18_750);
    expect(s.charsSaved).toBe(18_750 * 4);
  });

  it('reports negative tokensSavedEst when all compressions net-lose', async () => {
    writeEvents(tmp, [
      // 3 small blocks each net-lose ~1250 tokens.
      ev({ first_user_sha8: 'bbbbbbbb', compressed: true, orig_chars: 5000, compressed_chars: 5000, image_count: 1 }),
      ev({ first_user_sha8: 'bbbbbbbb', compressed: true, orig_chars: 5000, compressed_chars: 5000, image_count: 1 }),
      ev({ first_user_sha8: 'bbbbbbbb', compressed: true, orig_chars: 5000, compressed_chars: 5000, image_count: 1 }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const s = sessions.get('bbbbbbbb')!;
    // 3 × (1250 - 2500) = -3750 tokens.
    expect(s.tokensSavedEst).toBe(-3750);
    expect(s.charsSaved).toBe(-15_000);
  });
});

// ---- filter + list ---------------------------------------------------------

describe('filterSessions', () => {
  it('filters by project (substring match)', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/Users/me/code/pixelpipe' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/Users/me/code/other' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    expect(filterSessions(sessions, { project: 'pixelpipe' }).map((s) => s.id)).toEqual([
      'aaaaaaaa',
    ]);
    expect(filterSessions(sessions, { project: 'other' }).map((s) => s.id)).toEqual([
      'bbbbbbbb',
    ]);
  });

  it('filters by since (ISO date)', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-05-01T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const filtered = filterSessions(sessions, { since: '2026-04-15T00:00:00Z' });
    expect(filtered.map((s) => s.id)).toEqual(['new1']);
  });

  it('sorts results most-recent-first', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-05-01T00:00:00Z', first_user_sha8: 'mid1' }),
      ev({ ts: '2026-06-01T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const ids = filterSessions(sessions, {}).map((s) => s.id);
    expect(ids).toEqual(['new1', 'mid1', 'old1']);
  });
});

// ---- selectSessionsToRemove ------------------------------------------------

describe('selectSessionsToRemove', () => {
  it('selects by --older-than days', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-05-10T00:00:00Z', first_user_sha8: 'mid1' }),
      ev({ ts: '2026-05-15T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const now = new Date('2026-05-18T00:00:00Z');
    // older than 7 days at now -> cutoff = 2026-05-11
    const removed = selectSessionsToRemove(sessions, { olderThanDays: 7, force: false }, now);
    expect([...removed].sort()).toEqual(['mid1', 'old1']);
  });

  it('selects by --keep-last N', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'a' }),
      ev({ ts: '2026-04-02T00:00:00Z', first_user_sha8: 'b' }),
      ev({ ts: '2026-04-03T00:00:00Z', first_user_sha8: 'c' }),
      ev({ ts: '2026-04-04T00:00:00Z', first_user_sha8: 'd' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const removed = selectSessionsToRemove(sessions, { keepLast: 2, force: false });
    // keep d, c — remove a, b
    expect([...removed].sort()).toEqual(['a', 'b']);
  });

  it('selects by --session', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa' }),
      ev({ first_user_sha8: 'bbbbbbbb' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const removed = selectSessionsToRemove(
      sessions,
      { sessionId: 'aaaaaaaa', force: false },
    );
    expect([...removed]).toEqual(['aaaaaaaa']);
  });

  it('returns empty set when --session does not match', async () => {
    writeEvents(tmp, [ev({ first_user_sha8: 'aaaaaaaa' })]);
    const { sessions } = await aggregateSessions(tmp);
    const removed = selectSessionsToRemove(sessions, {
      sessionId: 'nonexistent',
      force: false,
    });
    expect(removed.size).toBe(0);
  });

  it('selects multiple via sessionIds[] (bulk-delete UI)', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa' }),
      ev({ first_user_sha8: 'bbbbbbbb' }),
      ev({ first_user_sha8: 'cccccccc' }),
      ev({ first_user_sha8: 'dddddddd' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const removed = selectSessionsToRemove(sessions, {
      sessionIds: ['aaaaaaaa', 'cccccccc'],
      force: false,
    });
    expect([...removed].sort()).toEqual(['aaaaaaaa', 'cccccccc']);
  });

  it('sessionIds[] silently skips unknown ids (race-safe)', async () => {
    writeEvents(tmp, [ev({ first_user_sha8: 'aaaaaaaa' })]);
    const { sessions } = await aggregateSessions(tmp);
    const removed = selectSessionsToRemove(sessions, {
      sessionIds: ['aaaaaaaa', 'doesnotexist', 'alsogone'],
      force: false,
    });
    expect([...removed]).toEqual(['aaaaaaaa']);
  });

  it('sessionIds[] and sessionId compose (single + bulk in one call)', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa' }),
      ev({ first_user_sha8: 'bbbbbbbb' }),
      ev({ first_user_sha8: 'cccccccc' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const removed = selectSessionsToRemove(sessions, {
      sessionId: 'aaaaaaaa',
      sessionIds: ['bbbbbbbb'],
      force: false,
    });
    expect([...removed].sort()).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });
});

// ---- prune (dry-run + apply) ----------------------------------------------

describe('prune', () => {
  it('dry-run by default — does not modify events.jsonl', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-05-15T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    const before = fs.readFileSync(tmp.eventsFile, 'utf8');
    const report = await prune(
      tmp,
      { olderThanDays: 7, force: false },
      new Date('2026-05-18T00:00:00Z'),
    );
    const after = fs.readFileSync(tmp.eventsFile, 'utf8');
    expect(after).toBe(before);
    expect(report.applied).toBe(false);
    expect(report.sessionsRemoved).toEqual(['old1']);
    expect(report.eventsRemoved).toBe(1);
    expect(report.eventsKept).toBe(1);
  });

  it('removes only matching events when --force is set', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-04-02T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-05-15T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    const report = await prune(
      tmp,
      { olderThanDays: 7, force: true },
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(report.applied).toBe(true);
    const remaining = fs
      .readFileSync(tmp.eventsFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TrackEvent);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.first_user_sha8).toBe('new1');
  });

  it('removes only the targeted session when --session is set', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa' }),
      ev({ first_user_sha8: 'bbbbbbbb' }),
      ev({ first_user_sha8: 'aaaaaaaa' }),
      ev({ first_user_sha8: 'cccccccc' }),
    ]);
    await prune(tmp, { sessionId: 'aaaaaaaa', force: true });
    const remaining = fs
      .readFileSync(tmp.eventsFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TrackEvent);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.first_user_sha8).sort()).toEqual([
      'bbbbbbbb',
      'cccccccc',
    ]);
  });

  it('deletes sidecar files referenced by removed sessions', async () => {
    const sidecar = writeSidecar(tmp, 'doomed.json.gz', 512);
    writeEvents(tmp, [
      ev({
        ts: '2026-04-01T00:00:00Z',
        first_user_sha8: 'old1',
        req_body_sample_path: sidecar,
      }),
      ev({ ts: '2026-05-15T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    expect(fs.existsSync(sidecar)).toBe(true);
    const report = await prune(
      tmp,
      { olderThanDays: 7, force: true },
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(fs.existsSync(sidecar)).toBe(false);
    expect(report.sidecarsRemoved).toBe(1);
    expect(report.sidecarBytesFreed).toBe(512);
  });

  it('preserves sidecars belonging to surviving sessions', async () => {
    const doomed = writeSidecar(tmp, 'doomed.json.gz', 100);
    const kept = writeSidecar(tmp, 'kept.json.gz', 100);
    writeEvents(tmp, [
      ev({
        ts: '2026-04-01T00:00:00Z',
        first_user_sha8: 'old1',
        req_body_sample_path: doomed,
      }),
      ev({
        ts: '2026-05-15T00:00:00Z',
        first_user_sha8: 'new1',
        req_body_sample_path: kept,
      }),
    ]);
    await prune(
      tmp,
      { olderThanDays: 7, force: true },
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(fs.existsSync(doomed)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('rewrite is atomic — leaves no .tmp behind on success', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'old1', ts: '2026-04-01T00:00:00Z' }),
      ev({ first_user_sha8: 'new1', ts: '2026-05-15T00:00:00Z' }),
    ]);
    await prune(
      tmp,
      { olderThanDays: 7, force: true },
      new Date('2026-05-18T00:00:00Z'),
    );
    const dir = path.dirname(tmp.eventsFile);
    const entries = fs.readdirSync(dir);
    expect(entries).not.toContain('events.jsonl.tmp');
  });

  it('is a no-op when no sessions match (force=true, empty selection)', async () => {
    writeEvents(tmp, [ev({ first_user_sha8: 'new1', ts: '2026-05-15T00:00:00Z' })]);
    const before = fs.readFileSync(tmp.eventsFile, 'utf8');
    const report = await prune(
      tmp,
      { olderThanDays: 365, force: true },
      new Date('2026-05-18T00:00:00Z'),
    );
    const after = fs.readFileSync(tmp.eventsFile, 'utf8');
    expect(after).toBe(before);
    expect(report.applied).toBe(true);
    expect(report.sessionsRemoved).toEqual([]);
  });
});

// ---- diskUsage -------------------------------------------------------------

describe('diskUsage', () => {
  it('reports 0 when nothing exists', () => {
    const d = diskUsage(tmp);
    expect(d.eventsJsonlBytes).toBe(0);
    expect(d.sidecarsBytes).toBe(0);
    expect(d.sidecarCount).toBe(0);
    expect(d.totalBytes).toBe(0);
  });

  it('matches actual file sizes', () => {
    writeEvents(tmp, [ev({ first_user_sha8: 'a' }), ev({ first_user_sha8: 'b' })]);
    writeSidecar(tmp, 'one.json.gz', 100);
    writeSidecar(tmp, 'two.json.gz', 200);
    const d = diskUsage(tmp);
    const actualEvents = fs.statSync(tmp.eventsFile).size;
    expect(d.eventsJsonlBytes).toBe(actualEvents);
    expect(d.sidecarsBytes).toBe(300);
    expect(d.sidecarCount).toBe(2);
    expect(d.totalBytes).toBe(actualEvents + 300);
  });
});

// ---- redactEvent + collectSessionEvents ------------------------------------

describe('show / redactEvent', () => {
  it('strips body fields by default', () => {
    const e = ev({
      first_user_sha8: 'aaaaaaaa',
      req_body_sample_b64: 'ZmFrZQ==',
      req_body_sample_path: '/tmp/x.json.gz',
      error_body: '{"error":"bad"}',
    });
    const r = redactEvent(e, false);
    expect((r as TrackEvent).req_body_sample_b64).toBeUndefined();
    expect((r as TrackEvent).req_body_sample_path).toBeUndefined();
    expect((r as TrackEvent).error_body).toBeUndefined();
    // Non-sensitive fields survive.
    expect(r.first_user_sha8).toBe('aaaaaaaa');
  });

  it('keeps body fields when includeBodies=true', () => {
    const e = ev({
      first_user_sha8: 'aaaaaaaa',
      error_body: '{"error":"bad"}',
    });
    const r = redactEvent(e, true);
    expect((r as TrackEvent).error_body).toBe('{"error":"bad"}');
  });

  it('collectSessionEvents returns only matching session events', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', ts: '2026-05-18T00:00:00Z' }),
      ev({ first_user_sha8: 'bbbbbbbb', ts: '2026-05-18T00:00:01Z' }),
      ev({ first_user_sha8: 'aaaaaaaa', ts: '2026-05-18T00:00:02Z' }),
    ]);
    const got = await collectSessionEvents(tmp, 'aaaaaaaa');
    expect(got).toHaveLength(2);
    expect(got.every((e) => e.first_user_sha8 === 'aaaaaaaa')).toBe(true);
  });
});


// ---- Claude Code session fingerprint map ----------------------------------

import {
  claudeCodeMap,
  decodeClaudeProjectDir,
  fingerprintFirstUser,
  readFirstUserFromClaudeSession,
} from '../src/sessions.js';

describe('Claude Code session map', () => {
  /** Build a synthetic `~/.claude/projects/<proj>/<session>.jsonl` tree under
   *  a tmpdir and return the root path. */
  function makeCCRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpipe-ccmap-'));
  }

  it('returns an empty map when the directory does not exist', async () => {
    const m = await claudeCodeMap(path.join(os.tmpdir(), 'definitely-missing-xyz'));
    expect(m.size).toBe(0);
  });

  it('fingerprints the first user message and maps to the session id', async () => {
    const root = makeCCRoot();
    const proj = path.join(root, '-Users-me-code-pixelpipe');
    fs.mkdirSync(proj, { recursive: true });
    const firstUser = 'hello, this is the start of a conversation';
    const sessionFile = path.join(proj, 'abc-123.jsonl');
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: 'permission-mode' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: firstUser } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }),
      ].join('\n') + '\n',
    );

    const m = await claudeCodeMap(root);
    const expectedSha = fingerprintFirstUser(firstUser);
    const ref = m.get(expectedSha);
    expect(ref).toBeDefined();
    expect(ref!.sessionId).toBe('abc-123');
    expect(ref!.projectPath).toBe('/Users/me/code/pixelpipe');
    expect(ref!.firstUserPreview).toContain('hello');
  });

  it('parses content-array blocks (the modern Claude Code shape)', async () => {
    const root = makeCCRoot();
    const proj = path.join(root, '-Users-me-foo');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
      path.join(proj, 'sess.jsonl'),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'first user prompt with text block shape' },
          ],
        },
      }) + '\n',
    );
    const m = await claudeCodeMap(root);
    expect(m.size).toBe(1);
    const ref = [...m.values()][0]!;
    expect(ref.firstUserPreview).toContain('first user prompt');
  });

  it('decodes project directory names back to a slash-path', () => {
    expect(decodeClaudeProjectDir('-Users-me-code-foo')).toBe('/Users/me/code/foo');
    expect(decodeClaudeProjectDir('foo-bar')).toBe('foo/bar');
  });

  it('matches the proxy fingerprint: 4 KiB cap and 8-hex prefix', () => {
    // Two strings that differ only past the 4 KiB cap must produce the same
    // sha8 — otherwise the mapping silently misses every cross-pass-the-cap
    // conversation.
    const base = 'x'.repeat(4096);
    expect(fingerprintFirstUser(base + 'A')).toBe(fingerprintFirstUser(base + 'B'));
    expect(fingerprintFirstUser('hello')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('skips sessions whose first user row is unreadable', async () => {
    const root = makeCCRoot();
    const proj = path.join(root, '-tmp-x');
    fs.mkdirSync(proj, { recursive: true });
    // First user row has neither string content nor an array of text blocks
    // → readFirstUserFromClaudeSession returns undefined and we don't add a
    //   bogus mapping by hashing some later assistant turn.
    fs.writeFileSync(
      path.join(proj, 'sess.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: { weird: true } } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'later user message' } }),
      ].join('\n') + '\n',
    );
    const m = await claudeCodeMap(root);
    expect(m.size).toBe(0);
  });

  it('readFirstUserFromClaudeSession handles missing file gracefully', async () => {
    const got = await readFirstUserFromClaudeSession('/nope/does/not/exist.jsonl');
    expect(got).toBeUndefined();
  });
});
