import * as http from "node:http";
import { Writable } from "node:stream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { serveBunOrNode, type ViteDev } from "./ViteDev.ts";

export class FrontProxyError extends Schema.TaggedErrorClass<FrontProxyError>()(
  "FrontProxyError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface FrontProxy {
  readonly host: string;
  readonly port: number;
  readonly address: string;
}

export interface FrontProxyOptions {
  /** Vite dev handle. Vite middleware handles its known paths first. */
  readonly dev: ViteDev;
  /**
   * Optional workerd HTTP address (`http://host:port`). If provided,
   * requests Vite's middleware does not handle are proxied here.
   * Required when `dev.hasSsr` is true.
   */
  readonly workerdAddress?: string;
}

/**
 * HTTP front-proxy that:
 *  - Lets Vite's connect middleware handle `/@vite/*`, `/@id/*`, source
 *    transforms, asset transforms, and HMR.
 *  - Falls through to workerd for everything Vite did not respond to.
 *
 * The control endpoint that the host worker uses to fetch SSR
 * snapshots lives on a separate internal HTTP server inside `ViteDev`
 * so workerd can hit it directly via an `external` service binding.
 */
export const start = (
  options: FrontProxyOptions,
): Effect.Effect<FrontProxy, FrontProxyError, Scope.Scope> =>
  Effect.gen(function* () {
    const bound = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          serveBunOrNode({
            host: "127.0.0.1",
            port: 0,
            handler: async (req) => proxyRequest(options, req),
            // No WebSocket handler: HMR runs on a dedicated Vite port
            // (configured in `ViteDev.start`) and the browser connects
            // to it directly via `clientPort`. Bridging the upgrade
            // through Bun.serve to Vite's WS server is fragile (Vite
            // expects a Node `http.Server` for its WS handlers); the
            // dedicated-port approach matches what the official Vite
            // ecosystem uses for proxied/middleware setups.
          }),
        catch: (cause) =>
          new FrontProxyError({
            message: "Failed to start Vite front-proxy HTTP server",
            cause,
          }),
      }),
      (srv) =>
        Effect.promise(async () => {
          await srv.stop();
        }),
    );

    return {
      host: bound.host,
      port: bound.port,
      address: `http://${bound.host}:${bound.port}`,
    };
  });

/**
 * Forward a request through Vite's connect middleware first; if Vite
 * doesn't handle it (no response written), fall through to workerd.
 *
 * The Vite middleware is the connect-style stack mounted on the inner
 * `ViteDevServer.middlewares` instance. We wrap it in a synthetic
 * `IncomingMessage`/`ServerResponse` pair so we can detect whether it
 * actually wrote a response. If it didn't, we proxy to workerd (or
 * return 404 in pure-SPA mode).
 */
const proxyRequest = async (
  options: FrontProxyOptions,
  req: Request,
): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname + url.search;

  const middlewareResponse = await runViteMiddleware(
    options.dev.viteServer.middlewares,
    req,
    path,
  );
  if (middlewareResponse) return middlewareResponse;

  if (options.workerdAddress) {
    return fetchUpstream(options.workerdAddress, req);
  }
  return new Response("Not Found", { status: 404 });
};

/**
 * Drive Vite's connect middleware against a synthetic Node-style
 * (req, res) pair. Returns a Web `Response` if the middleware wrote
 * one, or null if it called `next()` without responding.
 *
 * The response object is a real `node:stream.Writable` (via
 * `MiddlewareResponse`) so that middleware that uses `pipe()` —
 * notably `sirv`'s `fs.createReadStream(file).pipe(res)` for
 * Vite's `/@fs/` static-file route — sees a working stream
 * destination. A purely-objectual fake breaks pipe and produces
 * empty/MIME-typeless responses for `.mjs` etc.
 */
const runViteMiddleware = (
  middlewares: any,
  req: Request,
  path: string,
): Promise<Response | null> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const fakeReq: any = {
      method: req.method,
      url: path,
      headers,
      // Connect middleware that needs the body (e.g. POST handlers)
      // will still see the body via the proxy fallback to workerd —
      // Vite's dev middleware itself doesn't read the request body.
    };

    const res = new MiddlewareResponse(resolve);

    const next = (err?: unknown) => {
      if (err) {
        reject(err);
        return;
      }
      if (!res.handled) {
        resolve(null);
      }
    };

    try {
      middlewares(fakeReq, res, next);
    } catch (err) {
      reject(err);
    }
  });

/**
 * Real `Writable` that mimics enough of Node's `http.ServerResponse`
 * surface for connect-style middleware (Vite + sirv) to drive it.
 * Headers are buffered until the stream finishes, then converted into
 * a Web `Response` and handed to the resolver.
 */
class MiddlewareResponse extends Writable {
  handled = false;
  statusCode = 200;
  statusMessage = "OK";
  headersSent = false;
  private resHeaders: Record<string, string | string[]> = {};
  private chunks: Buffer[] = [];
  private finished = false;
  private resolve: (response: Response | null) => void;

  constructor(resolve: (response: Response | null) => void) {
    super();
    this.resolve = resolve;
    this.on("finish", () => this.flush());
  }

  override _write(
    chunk: any,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.handled = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }

  setHeader(name: string, value: string | string[]) {
    this.resHeaders[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string) {
    return this.resHeaders[name.toLowerCase()];
  }
  getHeaderNames() {
    return Object.keys(this.resHeaders);
  }
  getHeaders() {
    return { ...this.resHeaders };
  }
  hasHeader(name: string) {
    return name.toLowerCase() in this.resHeaders;
  }
  removeHeader(name: string) {
    delete this.resHeaders[name.toLowerCase()];
  }
  appendHeader(name: string, value: string | string[]) {
    const key = name.toLowerCase();
    const existing = this.resHeaders[key];
    const incoming = Array.isArray(value) ? value : [value];
    if (existing === undefined) {
      this.resHeaders[key] = incoming.length === 1 ? incoming[0] : incoming;
    } else if (Array.isArray(existing)) {
      this.resHeaders[key] = [...existing, ...incoming];
    } else {
      this.resHeaders[key] = [existing, ...incoming];
    }
    return this;
  }
  flushHeaders() {
    return this;
  }
  writeHead(
    code: number,
    msgOrHeaders?: any,
    maybeHeaders?: Record<string, string | string[]>,
  ) {
    this.handled = true;
    this.statusCode = code;
    if (typeof msgOrHeaders === "string") {
      this.statusMessage = msgOrHeaders;
      if (maybeHeaders) {
        for (const [k, v] of Object.entries(maybeHeaders)) {
          this.resHeaders[k.toLowerCase()] = v;
        }
      }
    } else if (msgOrHeaders) {
      for (const [k, v] of Object.entries(msgOrHeaders)) {
        this.resHeaders[k.toLowerCase()] = v as string | string[];
      }
    }
    this.headersSent = true;
    return this;
  }

  private flush() {
    if (this.finished) return;
    this.finished = true;
    const body = Buffer.concat(this.chunks);
    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(this.resHeaders)) {
      if (Array.isArray(v)) {
        for (const item of v) responseHeaders.append(k, item);
      } else if (v !== undefined) {
        responseHeaders.set(k, String(v));
      }
    }
    this.resolve(
      new Response(body, {
        status: this.statusCode,
        statusText: this.statusMessage,
        headers: responseHeaders,
      }),
    );
  }
}

/**
 * Forward `req` to the workerd HTTP socket and stream the response back.
 */
const fetchUpstream = async (
  upstreamAddress: string,
  req: Request,
): Promise<Response> => {
  const incoming = new URL(req.url);
  const target = new URL(incoming.pathname + incoming.search, upstreamAddress);
  const headers = new Headers(req.headers);
  headers.set("host", target.host);
  const init: RequestInit = {
    method: req.method,
    headers,
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await req.arrayBuffer(),
  };
  return fetch(target.toString(), init);
};
