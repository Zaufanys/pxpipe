/**
 * The pixelpipe proxy as a single Web-standard fetch handler.
 *
 * Both `src/node.ts` and `src/worker.ts` adapt this to their respective
 * runtimes (node:http server vs CF Worker `fetch` export). The handler
 * itself only uses `Request`, `Response`, `URL`, and global `fetch` — all
 * of which exist identically in Node 18+ and Workers.
 */

import { transformRequest, type TransformOptions, type TransformInfo } from './transform.js';
import type { Usage } from './types.js';

export interface ProxyConfig {
  /** Anthropic API base, no trailing slash. Defaults to api.anthropic.com. */
  upstream?: string;
  /** Override or supply an API key. If unset, we forward whatever the client sent. */
  apiKey?: string;
  /** Per-request transform options. */
  transform?: TransformOptions;
  /** Called after every request — useful for logging / metrics in the host. */
  onRequest?: (event: ProxyEvent) => void | Promise<void>;
}

export interface ProxyEvent {
  method: string;
  path: string;
  status: number;
  /** Wall-clock ms from request start to event fire (≈ end of upstream response
   *  body, since we now wait for usage extraction). For first-byte latency see
   *  firstByteMs. */
  durationMs: number;
  /** Wall-clock ms from request start to upstream response headers. */
  firstByteMs?: number;
  info?: TransformInfo;
  /** Usage block from Anthropic's response — input/output/cache tokens. */
  usage?: Usage;
  error?: string;
}

/**
 * Tee the response body so we can scan for the usage block (SSE: in the
 * message_start event; non-stream: at the top of the JSON) without buffering
 * the whole stream or blocking the client. Returns the un-touched response
 * to forward to the client + a Promise that resolves to the parsed Usage
 * (or undefined if we couldn't find one within the budget).
 */
function teeForUsage(res: Response): {
  response: Response;
  usagePromise: Promise<Usage | undefined>;
} {
  // Errors and bodyless responses: nothing to extract.
  if (!res.body || res.status >= 400) {
    return { response: res, usagePromise: Promise.resolve(undefined) };
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const [forClient, forUs] = res.body.tee();

  const usagePromise = (async (): Promise<Usage | undefined> => {
    const reader = forUs.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const drain = async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* ignore */
      }
    };

    try {
      if (ct.includes('text/event-stream')) {
        // SSE: usage is in the FIRST event (`message_start`). Cap scan at 64
        // KiB so we don't hold the tee buffer open for the entire stream.
        const MAX = 65536;
        while (buf.length < MAX) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const idx = buf.indexOf('event: message_start');
          if (idx >= 0) {
            // The data: line follows. Match the first data: after that idx.
            const m = /^data:\s*(.+)$/m.exec(buf.slice(idx));
            if (m) {
              try {
                const j = JSON.parse(m[1]!);
                void drain();
                return j?.message?.usage as Usage | undefined;
              } catch {
                /* not yet a complete JSON line — keep reading */
              }
            }
          }
        }
        void drain();
        return undefined;
      }

      if (ct.includes('application/json')) {
        // Non-stream: buffer fully (capped at 4 MiB).
        const MAX = 4 * 1024 * 1024;
        while (buf.length < MAX) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        try {
          const j = JSON.parse(buf);
          return j?.usage as Usage | undefined;
        } catch {
          return undefined;
        }
      }
    } catch {
      /* tee may be released early if the client aborts — ignore */
    }
    void drain();
    return undefined;
  })();

  return {
    response: new Response(forClient, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    }),
    usagePromise,
  };
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

/** Headers we strip on the way out — they're hop-by-hop or proxy-injected. */
const STRIP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length', // we recompute
  'expect',
  'accept-encoding', // let upstream choose
]);

const STRIP_RES_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding', // we don't re-encode
  'content-length',   // body may differ after streaming
]);

function filterHeaders(src: Headers, strip: Set<string>): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    if (!strip.has(k.toLowerCase())) out.append(k, v);
  });
  return out;
}

/** Build the proxy fetch handler bound to a config. */
export function createProxy(config: ProxyConfig = {}) {
  const upstream = (config.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '');

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    const fire = (
      status: number,
      info?: TransformInfo,
      error?: string,
      firstByteMs?: number,
      usage?: Usage,
    ): void => {
      void config.onRequest?.({
        method: req.method,
        path: url.pathname,
        status,
        durationMs: Date.now() - t0,
        firstByteMs,
        info,
        usage,
        error,
      });
    };

    // Only intercept /v1/messages POSTs. Everything else passes through.
    const isMessages = req.method === 'POST' && url.pathname === '/v1/messages';

    let bodyOut: BodyInit | null = null;
    let info: TransformInfo | undefined;

    if (isMessages) {
      const bodyIn = new Uint8Array(await req.arrayBuffer());
      try {
        const r = await transformRequest(bodyIn, config.transform);
        // Cast: TS narrows Uint8Array<ArrayBufferLike> away from BodyInit, but
        // it's a valid body and we never use SharedArrayBuffer.
        bodyOut = r.body as unknown as BodyInit;
        info = r.info;
      } catch (e) {
        fire(502, undefined, `transform_error: ${(e as Error).message}`);
        return new Response(JSON.stringify({ error: 'pixelpipe transform failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    } else {
      // Pass body through unchanged.
      bodyOut = req.body;
    }

    const outHeaders = filterHeaders(req.headers, STRIP_REQ_HEADERS);
    if (config.apiKey) outHeaders.set('x-api-key', config.apiKey);

    const upstreamUrl = upstream + path;
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: outHeaders,
        body: bodyOut,
        // duplex is required by spec when sending a stream as body
        ...(bodyOut instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
    } catch (e) {
      fire(502, info, `upstream_error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: 'pixelpipe upstream unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    const firstByteMs = Date.now() - t0;

    // Tee the upstream body so we can extract Anthropic's usage block. The
    // client gets one side immediately; we read the other in the background.
    const { response: teed, usagePromise } = teeForUsage(upstreamRes);

    // Fire the host event once usage is known (or once we've given up on
    // finding it). Don't await — the response below is what unblocks the
    // client; fire happens in the background.
    void usagePromise
      .then((usage) => fire(upstreamRes.status, info, undefined, firstByteMs, usage))
      .catch(() => fire(upstreamRes.status, info, undefined, firstByteMs, undefined));

    return new Response(teed.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: filterHeaders(upstreamRes.headers, STRIP_RES_HEADERS),
    });
  };
}
