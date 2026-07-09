/**
 * Tests for the built-in verbatim-risk guard (verbatim-guard.ts + its wiring in
 * transform.ts).
 *
 * The guard is the shipped, automatic counterpart to the caller `keepSharp` hint: it
 * pins a live-region block (reminder / tool_result / tool_result_part) as TEXT — never
 * imaging it — when the block carries a credential/secret or a wall of distinct
 * identifiers the fact-sheet can't carry. It runs by default and only ever keeps MORE
 * as text, so it can never cause additional imaging.
 *
 * Contract verified here:
 *   Detector (pure):
 *     - Fires on real secret shapes (AWS, GitHub, GitLab, Google, Slack, Stripe,
 *       OpenAI/Anthropic sk-, JWT, PEM private key, keyword=value assignments).
 *     - Stays silent on ordinary prose / code / a lone path or version / a single sha,
 *       AND on identifier-dense bulk (lockfiles / logs) that pxpipe profits from imaging.
 *     - Is ReDoS-safe on adversarial base64/minified input (completes fast).
 *   Wiring (through transformRequest):
 *     - A large secret-bearing tool_result stays text and increments
 *       `info.verbatimGuardPins.secret`.
 *     - `verbatimGuard: false` disables it → the same block images.
 *     - A caller `keepSharp` still wins (counted as keptSharp, not a guard pin).
 */

import { describe, expect, it } from 'vitest';
import { verbatimRiskVerdict, isVerbatimRisk } from '../src/core/verbatim-guard.js';
import { transformRequest } from '../src/core/transform.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- pure detector --------------------------------------------------------

// Fixtures are assembled from fragments at runtime (`cat(...)`) so no contiguous
// credential literal ever appears in the source file — that keeps GitHub push
// protection / secret scanning from flagging test data. The guard sees the fully
// joined string, so detection is exercised exactly as in production.
const cat = (...parts: string[]) => parts.join('');

describe('verbatimRiskVerdict — secrets', () => {
  const secrets: Array<[string, string]> = [
    ['AWS access key id', cat('AKIA', 'IOSFODNN7EXAMPLE')],
    ['GitHub PAT', cat('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0'.repeat(2))],
    ['GitHub fine-grained PAT', cat('github', '_pat_', '1'.repeat(30))],
    ['GitLab PAT', cat('glpat', '-', 'aB3dE6gH9jK2mN5pQ8rS')],
    ['Google API key', cat('AIza', 'aB3dE6gH9jK2mN5pQ8rSaB3dE6gH9jK2mN5')],
    ['Slack token', cat('xoxb', '-123456789012-abcdefABCDEF1234567890')],
    ['Stripe live key', cat('sk', '_live_', 'aB3dE6gH9jK2mN5pQ8rS')],
    ['OpenAI/Anthropic key', cat('sk', '-ant-api03-', 'aB3dE6gH9jK2mN5pQ8rStU')],
    ['JWT', cat('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N')],
  ];
  for (const [label, token] of secrets) {
    it(`pins a ${label}`, () => {
      const v = verbatimRiskVerdict(`here is the value ${token} in a config line`);
      expect(v.pin).toBe(true);
      expect(v.reason).toBe('secret');
    });
  }

  it('pins a PEM private key header', () => {
    const pem = cat('-----BEGIN ', 'RSA PRIVATE KEY', '-----\nMIIEow...\n-----END RSA PRIVATE KEY-----');
    expect(verbatimRiskVerdict(pem)).toEqual({ pin: true, reason: 'secret' });
  });

  it('pins an OPENSSH private key header', () => {
    const k = cat('-----BEGIN ', 'OPENSSH PRIVATE KEY', '-----\nb3BlbnNzaC1rZXk...\n-----END OPENSSH PRIVATE KEY-----');
    expect(verbatimRiskVerdict(k)).toEqual({ pin: true, reason: 'secret' });
  });

  it('pins a keyword=value assignment with a high-entropy value', () => {
    expect(isVerbatimRisk(cat('password = "', 'hunter2Correct9Horse', '"'))).toBe(true);
    expect(isVerbatimRisk(cat('API_KEY: ', '9f8e7d6c5b4a3f2e1d0c9b8a'))).toBe(true);
    expect(isVerbatimRisk(cat('Authorization: Bearer ', 'abc123DEF456ghi789JKL'))).toBe(true);
  });

  it('pins a pure-alphabetic or pure-numeric assigned value ≥16 chars (regression)', () => {
    // A prior version's entropy gate required BOTH a letter and a digit (or ≥24 chars),
    // so a pure-alpha or pure-numeric secret in the 16-23 char range slipped through
    // undetected even sitting right after a strong credential keyword.
    expect(isVerbatimRisk(cat('client_secret: "', 'abcdefghijklmnopqrst', '"'))).toBe(true);
    expect(isVerbatimRisk(cat('api_key: ', '12345678901234567890'))).toBe(true);
  });

  it('pins a token embedded in a long whitespace-free run (regression)', () => {
    // A prior version skipped any whitespace-free chunk over 512 chars entirely before
    // running the opaque-token patterns, so a real key embedded in a longer unbroken
    // run (a minified JSON blob, a long query string) passed through undetected — even
    // though the identical token alone was correctly caught. Patterns are now verified
    // ReDoS-safe at any length (see the ReDoS-safety block below), so nothing is skipped.
    const padding = 'x'.repeat(480);
    const ghToken = cat('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0'.repeat(2));
    const blob = cat('{"', padding, '":"', ghToken, '"}');
    expect(blob.length).toBeGreaterThan(512);
    expect(isVerbatimRisk(blob)).toBe(true);
  });
});

describe('verbatimRiskVerdict — negatives (savings preserved)', () => {
  it('stays silent on ordinary prose', () => {
    expect(verbatimRiskVerdict('The quick brown fox jumps over the lazy dog. '.repeat(50)))
      .toEqual({ pin: false, reason: null });
  });

  it('stays silent on ordinary source code', () => {
    const code = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`.repeat(40);
    expect(isVerbatimRisk(code)).toBe(false);
  });

  it('does not treat a lone path / version / single sha as a secret', () => {
    expect(isVerbatimRisk('see src/core/transform.ts at v0.8.0, commit 4c4b77c')).toBe(false);
  });

  it('leaves identifier-dense bulk (lockfiles / logs) alone — pxpipe images those', () => {
    // A yarn-lockfile-shaped wall of checksums/versions: dense with identifiers but no
    // credentials. The guard must NOT fire (this is profitable imaging traffic).
    const lock = Array.from(
      { length: 400 },
      (_, i) => `  pkg-${i}@npm:1.${i}.0: checksum=${'a'.repeat(24)}${i}`,
    ).join('\n');
    expect(isVerbatimRisk(lock)).toBe(false);
    // A git-log-shaped wall of short shas: also left alone.
    const log = Array.from({ length: 300 }, (_, i) => (0xa00000000000 + i).toString(16)).join('\n');
    expect(isVerbatimRisk(log)).toBe(false);
  });

  it('does not fire on a prose word after a keyword (entropy gate)', () => {
    expect(isVerbatimRisk('the password is stored securely in the vault service'))
      .toBe(false);
    expect(isVerbatimRisk('token: see the design system documentation for details'))
      .toBe(false);
  });

  it('returns not-risky for empty / non-string input', () => {
    expect(isVerbatimRisk('')).toBe(false);
    // @ts-expect-error — defensive against non-string input at the boundary
    expect(isVerbatimRisk(undefined)).toBe(false);
  });
});

describe('verbatimRiskVerdict — ReDoS safety', () => {
  it('completes quickly on a large base64/minified blob', () => {
    const blob = 'aB3dE6gH9jK2mN5pQ8rS/tU1vW+xY0zA='.repeat(20_000); // ~640k chars
    const start = Date.now();
    verbatimRiskVerdict(blob);
    // Bounded, chunk-limited scan: must finish well under a second even on junk input.
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ---- wiring through transformRequest --------------------------------------

function makeReq(content: unknown[], model = 'claude-3-5-sonnet') {
  return enc.encode(
    JSON.stringify({
      model,
      system: 'x'.repeat(80_000), // large static slab → compression path is active
      messages: [{ role: 'user', content }],
    }),
  );
}

function userBlocks(body: Uint8Array): any[] {
  const req = JSON.parse(dec.decode(body));
  const user = (req.messages ?? []).find((m: any) => m.role === 'user');
  return Array.isArray(user?.content) ? user.content : [];
}

// A big tool_result (> the 6k min) that also embeds a secret-shaped token.
const SECRET = cat('AKIA', 'IOSFODNN7EXAMPLE');
const BIG_WITH_SECRET =
  'log line filler that is dense enough to be profitable to image\n'.repeat(400) +
  `\naws_secret_marker ${SECRET}\n`;

describe('verbatim-risk guard wiring', () => {
  it('pins a large secret-bearing tool_result as text by default', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_secret', content: BIG_WITH_SECRET }]),
      { multiCol: 1, charsPerToken: 2 },
    );

    expect(info.toolResultImgs ?? 0).toBe(0);
    expect(info.verbatimGuardPins?.secret ?? 0).toBeGreaterThan(0);
    expect(info.passthroughReasons?.verbatim_guard ?? 0).toBeGreaterThan(0);

    // The secret survived byte-for-byte as text (not imaged, not corrupted).
    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    const text =
      typeof tr?.content === 'string'
        ? tr.content
        : (tr?.content ?? []).find((b: any) => b.type === 'text')?.text;
    expect(text).toBe(BIG_WITH_SECRET);
  });

  it('images the same block when verbatimGuard is disabled', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_secret', content: BIG_WITH_SECRET }]),
      { multiCol: 1, charsPerToken: 2, verbatimGuard: false },
    );

    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(info.verbatimGuardPins?.secret ?? 0).toBe(0);
    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    const hasImage = Array.isArray(tr?.content) && tr.content.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);
  });

  it('lets a caller keepSharp win (counted as keptSharp, not a guard pin)', async () => {
    const { info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_secret', content: BIG_WITH_SECRET }]),
      { multiCol: 1, charsPerToken: 2, keepSharp: () => true },
    );
    expect(info.keptSharpBlocks ?? 0).toBeGreaterThan(0);
    expect(info.verbatimGuardPins?.secret ?? 0).toBe(0);
  });

  it('does not disturb a clean large tool_result (still imaged)', async () => {
    const clean = 'clean dense log line with no secrets whatsoever here now\n'.repeat(400);
    const { info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_clean', content: clean }]),
      { multiCol: 1, charsPerToken: 2 },
    );
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(info.verbatimGuardPins).toBeUndefined();
  });
});
