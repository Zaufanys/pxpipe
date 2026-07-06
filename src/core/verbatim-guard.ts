/**
 * Verbatim-risk guard — decides whether a live-region block is too byte-exact-risky
 * to image at all, and must stay as plain text.
 *
 * pxpipe's imaging is lossy: dense identifiers mis-OCR *silently* (13/15 hex on Fable 5,
 * 0/15 on Opus — see FINDINGS.md). The fact-sheet (factsheet.ts) rescues the *common*
 * case by riding a budgeted list of precision tokens alongside each image. But one shape
 * must never be imaged at all:
 *
 *   **Secrets/credentials.** A silently-corrupted AWS key, GitHub token, JWT, or PEM
 *   private key is worse than useless — the model quotes a plausible-but-wrong secret,
 *   or the real one leaks into an image the fact-sheet never fully covers. Byte-exact by
 *   definition; zero tolerance for OCR drift.
 *
 * Scope is deliberately narrow. Lockfiles, `git log`, logs, and other identifier-dense
 * bulk are exactly what pxpipe profits from imaging (recent-turn re-reads + the fact-sheet
 * cover them), so the guard leaves them alone: it fires ONLY on credential shapes. On
 * ordinary traffic it stays silent, preserving the savings numbers, and it only ever pins
 * MORE as text — it can never cause additional imaging.
 *
 * Pure + deterministic (fixed pattern order, no Date/random), so a host can memoize it and
 * it never destabilizes the prompt cache.
 */

export type VerbatimRiskReason = 'secret';

export interface VerbatimRiskVerdict {
  /** True when the block must stay text (not be imaged). */
  readonly pin: boolean;
  /** Why it was pinned, or `null` when `pin` is false. */
  readonly reason: VerbatimRiskReason | null;
}

const NOT_RISKY: VerbatimRiskVerdict = { pin: false, reason: null };

/** Defensive input bound — matches factsheet.ts. Live-region blocks are already paged. */
const MAX_SCAN = 262_144;
/** Whitespace-free chunks longer than this are blobs (base64, minified) — skip for the
 *  opaque-token patterns to keep extraction strictly O(n). */
const MAX_CHUNK = 512;
/** Per-line scan cap for the keyword-assignment pattern (defends against minified lines). */
const MAX_LINE = 4096;
/** Max lines scanned for assignments — a real `.env`/config leak shows up in the first few. */
const MAX_LINES = 4096;

/**
 * Opaque secret shapes (no internal whitespace). Anchored with `\b`/literal prefixes and
 * BOUNDED quantifiers so they are ReDoS-safe on adversarial input. Ordered most- to
 * least-specific; first match wins.
 */
const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  // AWS access key id (AKIA…, ASIA…, and the other documented ARN prefixes)
  /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|AIPA|AKUA|ABIA|ACCA)[A-Z0-9]{16}\b/,
  // GitHub personal-access / OAuth / server / refresh / user tokens
  /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/,
  // GitHub fine-grained PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
  // GitLab PAT
  /\bglpat-[A-Za-z0-9_-]{20,64}\b/,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Slack token
  /\bxox[baprs]-[0-9A-Za-z-]{10,255}\b/,
  // Stripe live/test keys
  /\b[sprk]k_(?:live|test)_[0-9A-Za-z]{16,255}\b/,
  // OpenAI / Anthropic-style keys (sk-, sk-ant-, sk-proj-, …)
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,255}\b/,
  // JSON Web Token (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

/** PEM/OpenSSH private-key headers — check on the whole (capped) text, not per-chunk,
 *  because the header contains spaces. */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]{1,20} )?PRIVATE KEY-----/;
const OPENSSH_PRIVATE_KEY = /-----BEGIN OPENSSH PRIVATE KEY-----/;

/**
 * Keyword→value assignment (`password = "…"`, `api_key: '…'`, `Authorization: Bearer …`).
 * The value is captured in group 1 and then entropy-checked so prose like
 * `token: see the design system` never trips it. Bounded quantifiers only.
 */
const SECRET_ASSIGNMENT =
  /(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|bearer|authorization)["'\s]{0,3}[:=]["'\s]{0,4}["'`]?([A-Za-z0-9_+/.=~-]{16,120})/i;

/** `Authorization: Bearer <token>` / `Bearer <token>` — the separator sits between the
 *  header and `Bearer`, not before the token, so the assignment pattern misses it. */
const SECRET_BEARER = /\bBearer\s+["'`]?([A-Za-z0-9_+/.=~-]{16,120})/i;

/** A captured assignment value looks like a real secret (not a prose word or a path). */
function looksLikeSecretValue(value: string): boolean {
  if (value.length < 16) return false;
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const hasSymbol = /[_+/.=~-]/.test(value);
  // High-entropy mixed token: letters+digits (most keys), or a long base64/hex-ish blob.
  if (hasLetter && hasDigit) return true;
  if (value.length >= 24 && (hasSymbol || /^[0-9a-fA-F]+$/.test(value))) return true;
  return false;
}

/** True when `text` contains a credential/secret-shaped token. */
function containsSecret(scan: string): boolean {
  if (PEM_PRIVATE_KEY.test(scan) || OPENSSH_PRIVATE_KEY.test(scan)) return true;

  // Opaque tokens: split on whitespace, skip blob-length chunks (bounds each regex to a
  // short chunk → strictly O(n), no backtracking blowup on base64/minified input).
  for (const chunk of scan.split(/\s+/)) {
    if (chunk.length < 12 || chunk.length > MAX_CHUNK) continue;
    for (const re of SECRET_TOKEN_PATTERNS) {
      if (re.test(chunk)) return true;
    }
  }

  // Keyword=value assignments: scan line-by-line (values may follow a space), capped.
  let lineNo = 0;
  for (const rawLine of scan.split(/\r?\n/)) {
    if (++lineNo > MAX_LINES) break;
    const line = rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine;
    const m = SECRET_ASSIGNMENT.exec(line);
    if (m && looksLikeSecretValue(m[1]!)) return true;
    const b = SECRET_BEARER.exec(line);
    if (b && looksLikeSecretValue(b[1]!)) return true;
  }
  return false;
}

/**
 * Classify a live-region block's byte-exact risk.
 *
 * Returns `{ pin: true, reason: 'secret' }` when the block carries a credential/secret-shaped
 * token and must stay text; otherwise `{ pin: false, reason: null }`.
 *
 * Deterministic and side-effect-free.
 */
export function verbatimRiskVerdict(text: string): VerbatimRiskVerdict {
  if (typeof text !== 'string' || text.length === 0) return NOT_RISKY;
  const scan = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  if (containsSecret(scan)) return { pin: true, reason: 'secret' };
  return NOT_RISKY;
}

/** Convenience boolean form of {@link verbatimRiskVerdict}. */
export function isVerbatimRisk(text: string): boolean {
  return verbatimRiskVerdict(text).pin;
}
