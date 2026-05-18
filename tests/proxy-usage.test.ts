import { describe, it, expect } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

/** Tiny in-process mock upstream — accepts any request and returns whatever
 *  the test fixture configured. Lets us assert that the proxy correctly
 *  extracts Anthropic's usage block from both SSE and JSON responses without
 *  touching the network. */
function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  // Patch globalThis.fetch for the duration of the test.
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    return Promise.resolve(handler(r));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const SAMPLE_REQ_BODY = JSON.stringify({
  model: 'claude-3-5-haiku-latest',
  messages: [{ role: 'user', content: 'hi' }],
  system: 'short',
});

describe('proxy usage extraction', () => {
  it('extracts usage tokens from a non-stream JSON response', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
              input_tokens: 123,
              output_tokens: 7,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 100,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    // Drain the client-side body so the tee is forced to finish.
    await res.text();
    // Give the onRequest callback a tick to fire (it's behind a void promise).
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(123);
    expect(captured!.usage?.output_tokens).toBe(7);
    expect(captured!.usage?.cache_read_input_tokens).toBe(100);
    expect(captured!.firstByteMs).toBeTypeOf('number');
  });

  it('extracts usage tokens from an SSE stream (message_start event)', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: ' +
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 42,
            output_tokens: 0,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 0,
          },
        },
      }) +
      '\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(42);
    expect(captured!.usage?.cache_creation_input_tokens).toBe(5000);
  });

  it('fires the event with undefined usage when the response is an error', async () => {
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(529);
    expect(captured!.usage).toBeUndefined();
  });
});
