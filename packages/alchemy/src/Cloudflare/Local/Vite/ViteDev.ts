import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as vite from "vite";
import { autoAcceptHmrPlugin } from "./AutoAcceptPlugin.ts";
import { collectSnapshot, type ModuleSnapshot } from "./ModuleSnapshot.ts";

export class ViteDevError extends Schema.TaggedErrorClass<ViteDevError>()(
  "ViteDevError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ViteDevOptions {
  rootDir: string;
  /** SSR entry specifier the host worker should load. */
  ssrEntry?: string;
}

export interface ViteDev {
  /** Whether the project has an SSR entry. When false, no workerd needed. */
  readonly hasSsr: boolean;
  /** Underlying Vite server — exposes `middlewares` (connect handler) and `ws`. */
  readonly viteServer: vite.ViteDevServer;
  /** Snapshot fetcher used by the host worker via service binding. */
  readonly snapshot: Effect.Effect<ModuleSnapshot, ViteDevError>;
  /** Latest known generation; bumped on Vite invalidations. */
  readonly generation: SubscriptionRef.SubscriptionRef<number>;
  /**
   * Internal HTTP address (`host:port`) for the alchemy control plane.
   * Exposes only `/__alchemy/vite/snapshot`. Bound to 127.0.0.1 — the
   * host worker reaches it via an `external` service binding in workerd.
   */
  readonly controlHost: string;
  readonly controlPort: number;
  readonly controlAddress: string;
}

/**
 * Spawn Vite in middleware mode. Returns a handle exposing the Vite
 * connect middleware (so callers can mount it on their own HTTP server)
 * plus the SSR module snapshot helpers used by the workerd host worker.
 */
export const start = (
  options: ViteDevOptions,
): Effect.Effect<ViteDev, ViteDevError, Scope.Scope> =>
  Effect.gen(function* () {
    const vite = yield* loadVite(options.rootDir);
    const generation = yield* SubscriptionRef.make(0);
    const snapshotCache = yield* Ref.make<ModuleSnapshot | null>(null);

    // Pick a free port for Vite's dedicated HMR WebSocket server. We
    // can't bridge HMR through the Bun.serve front-proxy reliably (the
    // upgrade has to be handed to Vite's WS server, which expects a
    // Node http.Server), so we let Vite run its own HMR server on a
    // separate port and tell the client to connect there directly.
    // `web.localhost:1337` -> workerd front-proxy (HTTP/HTML/transformed
    // sources). `localhost:HMR_PORT` -> Vite HMR (WebSocket).
    //
    // Persist the picked port across runs so that when `bun --watch`
    // reloads the dev process and tears Vite down, the new Vite comes
    // back on the same HMR port. Vite's HMR client auto-reconnects
    // when the WebSocket comes back, so the browser doesn't lose its
    // hot-update channel just because alchemy.run.ts changed.
    const hmrPort = yield* getOrPickHmrPort(options.rootDir);

    const viteServer = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          vite.createServer({
            root: options.rootDir,
            // Put the dep-optimizer cache outside `node_modules` so
            // Vite's writes don't trigger `bun --watch` to reload the
            // dev process (especially when alchemy is bun-linked, since
            // the watcher follows the package symlink into the
            // shared node_modules tree). `.alchemy/` is gitignored.
            // `path.resolve` (not `join`) is required — Vite resolves
            // a relative `cacheDir` against the same `root`, which
            // would produce e.g. `web/web/.alchemy/vite`.
            cacheDir: path.resolve(options.rootDir, ".alchemy", "vite"),
            // Inject Vite plugins alchemy contributes itself: currently
            // just the auto-accept HMR plugin so plain TS/JS client
            // modules get hot-update behavior without the user writing
            // `import.meta.hot.accept()` by hand. User plugins still
            // run normally — Vite merges the project's vite.config
            // plugins on top.
            plugins: [autoAcceptHmrPlugin()],
            server: {
              middlewareMode: true,
              hmr: {
                host: "127.0.0.1",
                port: hmrPort,
                clientPort: hmrPort,
              },
            },
            // Don't override `appType` — let the project's vite.config
            // pick `spa` (default, gives Vite's index.html fallback) or
            // `custom` (caller is responsible for HTML). For pure SPA
            // projects this is what makes `/` and unknown routes serve
            // index.html through the connect middleware stack.
            environments: {
              ssr: {
                build: { emptyOutDir: false },
              },
            },
          }),
        catch: (cause) =>
          new ViteDevError({
            message: "Failed to start Vite dev server",
            cause,
          }),
      }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to close Vite server", cause as Cause.Cause<unknown>),
          ),
        ),
    );

    const ssrEntry = yield* Effect.sync(() =>
      resolveSsrEntry(viteServer, options.ssrEntry),
    );

    const computeSnapshot = (gen: number) =>
      ssrEntry
        ? collectSnapshot(viteServer, ssrEntry, gen).pipe(
            Effect.mapError(
              (cause) =>
                new ViteDevError({
                  message: "Failed to compute SSR module snapshot",
                  cause,
                }),
            ),
          )
        : Effect.fail(
            new ViteDevError({
              message:
                "No SSR entry configured for this Vite project; module snapshot is unavailable.",
            }),
          );

    const snapshot = Effect.gen(function* () {
      const gen = yield* SubscriptionRef.get(generation);
      const cached = yield* Ref.get(snapshotCache);
      if (cached && cached.generation === gen) return cached;
      const fresh = yield* computeSnapshot(gen);
      yield* Ref.set(snapshotCache, fresh);
      return fresh;
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handler = (_file: string) => {
          if (!ssrEntry) return;
          void Effect.runPromise(
            SubscriptionRef.update(generation, (n) => n + 1),
          );
          void Effect.runPromise(Ref.set(snapshotCache, null));
        };
        viteServer.watcher.on("change", handler);
        viteServer.watcher.on("add", handler);
        viteServer.watcher.on("unlink", handler);
        return handler;
      }),
      (handler) =>
        Effect.sync(() => {
          viteServer.watcher.off("change", handler);
          viteServer.watcher.off("add", handler);
          viteServer.watcher.off("unlink", handler);
        }),
    );

    const controlServer = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          serveBunOrNode({
            host: "127.0.0.1",
            port: 0,
            handler: async (req) => {
              const url = new URL(req.url);
              if (url.pathname.startsWith("/__alchemy/vite/snapshot")) {
                const result = await Effect.runPromiseExit(snapshot);
                if (result._tag === "Success") {
                  return new Response(JSON.stringify(result.value), {
                    headers: { "content-type": "application/json" },
                  });
                }
                return new Response(
                  JSON.stringify({ error: Cause.pretty(result.cause) }),
                  {
                    status: 500,
                    headers: { "content-type": "application/json" },
                  },
                );
              }
              return new Response("Not Found", { status: 404 });
            },
          }),
        catch: (cause) =>
          new ViteDevError({
            message: "Failed to start Vite control HTTP server",
            cause,
          }),
      }),
      (srv) =>
        Effect.promise(async () => {
          await srv.stop();
        }),
    );

    const controlHost = controlServer.host;
    const controlPort = controlServer.port;

    return {
      hasSsr: ssrEntry !== null,
      viteServer,
      snapshot,
      generation,
      controlHost,
      controlPort,
      controlAddress: `http://${controlHost}:${controlPort}`,
    } satisfies ViteDev;
  });

const resolveSsrEntry = (
  server: vite.ViteDevServer,
  override: string | undefined,
): string | null => {
  if (override) return override;
  const ssr = server.environments.ssr;
  if (!ssr) return null;
  const input = (ssr.config.build as any)?.rollupOptions?.input;
  if (!input) return null;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input[0] ?? null;
  const values = Object.values(input as Record<string, string>);
  return values[0] ?? null;
};

/**
 * Cross-runtime HTTP listener that returns the bound host/port plus a
 * `stop()` finalizer. Bun's `node:http` shim has historically returned
 * `null` from `Server.address()` on Windows even after the `listening`
 * event fires, so we prefer `Bun.serve` when available.
 */
export interface BoundServer {
  host: string;
  port: number;
  stop: () => Promise<void>;
}

export const serveBunOrNode = (options: {
  host: string;
  port: number;
  handler: (req: Request) => Promise<Response> | Response;
}): BoundServer => {
  const bun = (globalThis as any).Bun;
  if (bun && typeof bun.serve === "function") {
    const srv = bun.serve({
      hostname: options.host,
      port: options.port,
      fetch: options.handler,
    });
    return {
      host: srv.hostname ?? options.host,
      port: srv.port,
      stop: async () => {
        await srv.stop();
      },
    };
  }
  throw new Error(
    "ViteDev currently requires the Bun runtime (`Bun.serve`); raw " +
      "node:http server.address() returns null on Bun-Windows so we cannot " +
      "fall back to it cleanly.",
  );
};

/**
 * Pick (or reuse) an HMR port for `rootDir`. The port is cached in
 * `<rootDir>/.alchemy/vite-hmr-port` so it survives `bun --watch`
 * reloads — when the new Vite binds the same port, the browser's HMR
 * WebSocket reconnects automatically. If the cached port is taken
 * (e.g. another tool grabbed it), fall through to a fresh free port.
 */
const getOrPickHmrPort = (rootDir: string): Effect.Effect<number, ViteDevError> =>
  Effect.tryPromise({
    try: async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fsSync = require("node:fs");
      const cacheFile = path.resolve(rootDir, ".alchemy", "vite-hmr-port");
      let cached: number | undefined;
      try {
        const text = fsSync.readFileSync(cacheFile, "utf8");
        const n = Number(text.trim());
        if (Number.isFinite(n) && n > 0 && n < 65536) cached = n;
      } catch {
        /* no cache yet */
      }
      const port = cached !== undefined && (await isPortFree(cached))
        ? cached
        : await pickFreePort();
      try {
        fsSync.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fsSync.writeFileSync(cacheFile, String(port));
      } catch {
        /* best-effort */
      }
      return port;
    },
    catch: (cause) =>
      new ViteDevError({
        message: "Failed to allocate HMR port",
        cause,
      }),
  });

const isPortFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require("node:net");
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });

const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require("node:net");
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to find a free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });

/**
 * Bind a TCP socket to port 0 to learn a free port, close it, and hand
 * the port to a downstream server. Vite needs an explicit port for its
 * HMR server when `clientPort` is set, so we pick one up front instead
 * of letting Vite pick — that way the same value works for both server
 * and client.
 */
const findFreePort = (): Effect.Effect<number, ViteDevError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const net = require("node:net");
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
          const addr = srv.address();
          if (!addr || typeof addr === "string") {
            srv.close();
            reject(new Error("Failed to find a free port"));
            return;
          }
          const { port } = addr;
          srv.close(() => resolve(port));
        });
      }),
    catch: (cause) =>
      new ViteDevError({
        message: "Failed to find a free port for Vite HMR",
        cause,
      }),
  });

type ViteModule = typeof import("vite");
let _viteModule: ViteModule | null = null;

const loadVite = (
  rootDir: string,
): Effect.Effect<ViteModule, ViteDevError> =>
  Effect.tryPromise({
    try: async () => {
      if (_viteModule) return _viteModule;
      let vitePath: string;
      try {
        const require = createRequire(path.join(rootDir, "package.json"));
        vitePath = require.resolve("vite");
      } catch {
        vitePath = "vite";
      }
      const viteUrl =
        vitePath === "vite" ? vitePath : pathToFileURL(vitePath).href;
      _viteModule = (await import(/* @vite-ignore */ viteUrl)) as ViteModule;
      return _viteModule;
    },
    catch: (cause) =>
      new ViteDevError({ message: "Failed to load vite from project", cause }),
  });
