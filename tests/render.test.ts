import { describe, expect, it } from 'vitest';
import { renderChunkToPng, renderTextToPngs } from '../src/core/render.js';
import { encodeGrayPng, bytesToBase64 } from '../src/core/png.js';
import { transformRequest } from '../src/core/transform.js';

describe('png encoder', () => {
  it('produces a valid PNG signature', async () => {
    const pixels = new Uint8Array(4 * 4).fill(128); // 4×4 mid-gray
    const png = await encodeGrayPng(pixels, 4, 4);
    expect(png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // Last chunk should be IEND
    const tail = png.slice(-12);
    expect(String.fromCharCode(tail[4]!, tail[5]!, tail[6]!, tail[7]!)).toBe('IEND');
  });

  it('round-trips bytesToBase64 ↔ atob', () => {
    const original = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const b64 = bytesToBase64(original);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(original);
  });
});

describe('renderer', () => {
  it('renders a one-line string to a single PNG', async () => {
    const img = await renderChunkToPng('Hello, world!');
    expect(img.png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(img.height).toBeLessThanOrEqual(1568);
    expect(img.width).toBeGreaterThan(0);
  });

  it('splits very long input into multiple PNGs', async () => {
    const huge = ('lorem ipsum dolor sit amet '.repeat(20) + '\n').repeat(500);
    const imgs = await renderTextToPngs(huge);
    expect(imgs.length).toBeGreaterThan(1);
    for (const img of imgs) expect(img.height).toBeLessThanOrEqual(1568);
  });
});

describe('transform', () => {
  it('is a no-op when below min-chars', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are helpful.',
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes, { minCompressChars: 100 });
    expect(info.compressed).toBe(false);
    expect(body).toBe(bytes); // returns same reference
  });

  it('compresses large system fields into image blocks', async () => {
    const bigSystem = 'You are a helpful assistant. '.repeat(200);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: bigSystem,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);
    expect(info.imageCount).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(body));
    expect(Array.isArray(out.system)).toBe(true);
    const imageBlocks = out.system.filter((b: any) => b.type === 'image');
    expect(imageBlocks.length).toBe(info.imageCount);
    expect(imageBlocks[0].source.media_type).toBe('image/png');
  });

  it('folds tool docs into the same image and stubs originals', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'short',
      tools: [
        {
          name: 'BigTool',
          description: 'A very long tool description. '.repeat(100),
          input_schema: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ],
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    expect(out.tools[0].description).toContain('See image');
    expect(out.tools[0].name).toBe('BigTool');
  });

  it('strips x-anthropic-billing-header line and keeps it as text', async () => {
    const sysText = 'x-anthropic-billing-header: cch=abc123\n' + 'real prompt text. '.repeat(200);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: sysText,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    const textBlocks = out.system.filter((b: any) => b.type === 'text');
    expect(textBlocks.some((b: any) => b.text.includes('x-anthropic-billing-header'))).toBe(true);
  });

  it('keeps <env> as text after the image so cache_control stays stable', async () => {
    const staticSlab = 'claude.md ground truth.\n'.repeat(500);
    const envBlock =
      "<env>\nWorking directory: /tmp/parityproj\nIs directory a git repo: Yes\nPlatform: darwin\nToday's date: 2026-05-18\n</env>";
    const sys = staticSlab + '\n' + envBlock;
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.compressed).toBe(true);
    expect(info.dynamicBlockCount).toBe(1);
    expect(info.dynamicChars).toBeGreaterThan(0);
    expect(info.staticChars).toBeGreaterThan(info.dynamicChars);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const blocks = out.system as any[];
    // Find the last image block.
    let lastImageIdx = -1;
    for (let i = 0; i < blocks.length; i++) if (blocks[i].type === 'image') lastImageIdx = i;
    expect(lastImageIdx).toBeGreaterThanOrEqual(0);

    // Everything AFTER the last image should be text and should contain the
    // <env> block verbatim — that's the whole point of the split.
    const tail = blocks
      .slice(lastImageIdx + 1)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    expect(tail).toContain('<env>');
    expect(tail).toContain('Working directory: /tmp/parityproj');

    // And the static slab must NOT show up in any text block — it lives in
    // the image now.
    for (const b of blocks) {
      if (b.type === 'text') expect(b.text).not.toContain('claude.md ground truth.');
    }
  });

  it('puts cache_control on the image only, never on the dynamic tail', async () => {
    const sys =
      'claude.md\n'.repeat(500) +
      '<env>\nWorking directory: /tmp/x\n</env>\n' +
      '<context name="todoList">\n[ ] do thing\n</context>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.dynamicBlockCount).toBe(2);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const cached = (out.system as any[]).filter((b: any) => b.cache_control);
    expect(cached.length).toBe(1);
    expect(cached[0].type).toBe('image');
  });

  it('passes through when the system prompt is only dynamic blocks', async () => {
    const sys = '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body, { minCompressChars: 100 });
    // Static slab is empty → below_min_chars → no-op pass-through.
    expect(info.compressed).toBe(false);
    expect(info.reason).toMatch(/below_min_chars/);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    expect(out.system).toBe(sys);
  });
});
