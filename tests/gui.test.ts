/**
 * Tests for the local "paste in, compress out" GUI (src/gui.ts).
 *
 * The GUI is a thin browser shell over the already-tested `runExportCore`
 * pipeline (tests/export.test.ts covers that core deeply): a self-contained
 * HTML page and one JSON endpoint, no fs, no network, no API key. Contract
 * verified here:
 *   - guiHtml() is self-contained (no external script/style/font/CDN
 *     requests) and references the compress endpoint.
 *   - runGuiCompress() produces base64 image artifacts + decoded text
 *     artifacts, drops manifest.json (redundant with the returned manifest),
 *     and its numbers agree with runExportCore's on the same input.
 *   - handleGuiRequest(): GET / serves the page; POST /api/compress round-
 *     trips real Request/Response objects end-to-end; empty input, bad JSON,
 *     and unknown routes are handled without throwing.
 */

import { describe, expect, it } from 'vitest';
import { guiHtml, runGuiCompress, handleGuiRequest, GUI_COMPRESS_ROUTE } from '../src/gui.js';
import { runExportCore, DEFAULT_EXPORT_MODEL, DEFAULT_EXPORT_COLS } from '../src/core/export.js';

describe('guiHtml', () => {
  const html = guiHtml();

  it('is a self-contained page with no external network requests', () => {
    expect(html).toContain('<!doctype html>');
    // No CDN scripts/stylesheets/fonts, no analytics — matches the project's
    // no-phone-home posture and works fully offline.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<link');
  });

  it('references the compress endpoint the JS actually calls', () => {
    expect(html).toContain(GUI_COMPRESS_ROUTE);
  });
});

describe('runGuiCompress', () => {
  const DENSE = 'const x = 1;\n'.repeat(3000);

  it('produces base64 PNG artifacts and decoded text artifacts', async () => {
    const result = await runGuiCompress(DENSE);
    expect(result.manifest.pages.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);

    const pngArtifacts = result.artifacts.filter((a) => a.filename.endsWith('.png'));
    expect(pngArtifacts.length).toBe(result.manifest.pages.length);
    for (const a of pngArtifacts) {
      expect(a.base64).toBeTruthy();
      expect(a.text).toBeUndefined();
      expect(a.width).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0);
      // Valid base64 (decodes without throwing) and looks like a PNG (starts
      // with the 8-byte PNG signature once decoded).
      const bytes = Buffer.from(a.base64!, 'base64');
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50); // 'P'
    }

    const promptArtifact = result.artifacts.find((a) => a.filename === 'prompt.txt');
    expect(promptArtifact?.text).toContain('pxpipe');
    expect(promptArtifact?.base64).toBeUndefined();

    const factsheetArtifact = result.artifacts.find((a) => a.filename === 'factsheet.txt');
    expect(factsheetArtifact).toBeTruthy();
  });

  it('drops manifest.json (redundant with the returned manifest field)', async () => {
    const result = await runGuiCompress(DENSE);
    expect(result.artifacts.find((a) => a.filename === 'manifest.json')).toBeUndefined();
  });

  it('agrees with runExportCore on the same input (same pipeline, different shape)', async () => {
    const guiResult = await runGuiCompress(DENSE);
    const coreResult = await runExportCore(DENSE, {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });
    expect(guiResult.manifest.tokenReport).toEqual(coreResult.manifest.tokenReport);
    expect(guiResult.manifest.pages.length).toBe(coreResult.manifest.pages.length);
  });

  it('truncates and flags oversized input rather than hanging on an unbounded render', async () => {
    const huge = 'x'.repeat(2_000_001);
    const result = await runGuiCompress(huge);
    expect(result.truncated).toBe(true);
    expect(result.manifest.sourceChars).toBeLessThanOrEqual(2_000_000);
  });
});

describe('handleGuiRequest', () => {
  it('serves the HTML page on GET /', async () => {
    const res = await handleGuiRequest(new Request('http://127.0.0.1:47825/'));
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('text/html');
    expect(await res!.text()).toContain('pxpipe');
  });

  it('round-trips a real compress request end-to-end', async () => {
    const body = JSON.stringify({ text: 'dense line\n'.repeat(2000) });
    const req = new Request(`http://127.0.0.1:47825${GUI_COMPRESS_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const res = await handleGuiRequest(req);
    expect(res?.status).toBe(200);
    const json = await res!.json();
    expect(json.manifest.pages.length).toBeGreaterThan(0);
    expect(json.artifacts.some((a: any) => a.base64)).toBe(true);
  });

  it('returns 400 for empty input instead of rendering nothing silently', async () => {
    const req = new Request(`http://127.0.0.1:47825${GUI_COMPRESS_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    const res = await handleGuiRequest(req);
    expect(res?.status).toBe(400);
    const json = await res!.json();
    expect(json.error).toBeTruthy();
  });

  it('returns 400 for malformed JSON without throwing', async () => {
    const req = new Request(`http://127.0.0.1:47825${GUI_COMPRESS_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await handleGuiRequest(req);
    expect(res?.status).toBe(400);
  });

  it('returns undefined for an unrelated route (caller 404s)', async () => {
    const res = await handleGuiRequest(new Request('http://127.0.0.1:47825/nope'));
    expect(res).toBeUndefined();
  });
});
