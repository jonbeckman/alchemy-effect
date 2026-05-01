import * as Effect from "effect/Effect";
import type * as vite from "vite";

/**
 * A snapshot of the SSR module graph at a given generation.
 * Shape matches WorkerLoaderWorkerCode minus runtime-specific fields,
 * which the host worker fills in.
 */
export interface ModuleSnapshot {
  generation: number;
  mainModule: string;
  modules: Record<string, { js: string }>;
}

/**
 * Walk the SSR module graph starting from `entry` and produce a flat
 * map of module-name → transformed JS that can be handed to the
 * worker_loader binding inline.
 *
 * Module names use the Vite URL form (e.g. `/src/worker.ts`,
 * `/@id/__x00__virtual:distilled/worker-entry`). Vite rewrites import
 * specifiers in transformed output to use the same scheme, so import
 * resolution inside the loaded isolate matches the keys here.
 */
export const collectSnapshot = (
  server: vite.ViteDevServer,
  entry: string,
  generation: number,
): Effect.Effect<ModuleSnapshot, Error> =>
  Effect.tryPromise({
    try: async () => {
      const ssr = server.environments.ssr;
      if (!ssr) {
        throw new Error("Vite SSR environment is not available");
      }

      const visited = new Map<string, string>();
      const queue: string[] = [];

      const enqueue = (url: string) => {
        if (!visited.has(url) && !queue.includes(url)) {
          queue.push(url);
        }
      };

      const resolved = await ssr.pluginContainer.resolveId(
        entry,
        undefined,
        {},
      );
      if (!resolved) {
        throw new Error(`Failed to resolve SSR entry: ${entry}`);
      }
      const mainUrl = urlFromId(resolved.id);
      enqueue(mainUrl);

      while (queue.length > 0) {
        const url = queue.shift()!;
        if (visited.has(url)) continue;
        const result = await ssr.transformRequest(url);
        if (!result) {
          throw new Error(`Failed to transform module: ${url}`);
        }
        visited.set(url, result.code);
        const node = await ssr.moduleGraph.getModuleByUrl(url);
        if (node) {
          for (const dep of node.importedModules) {
            if (dep.url) enqueue(dep.url);
          }
        }
      }

      const modules: Record<string, { js: string }> = {};
      for (const [url, code] of visited) {
        modules[url] = { js: code };
      }

      return {
        generation,
        mainModule: mainUrl,
        modules,
      };
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed to collect Vite module snapshot: ${String(cause)}`),
  });

/**
 * Translate a transformed module ID into the URL form Vite uses inside
 * the module graph. Vite's `resolveId` returns absolute paths for
 * filesystem modules and `\0`-prefixed strings for virtuals.
 */
const urlFromId = (id: string): string => {
  if (id.startsWith("\0")) {
    return `/@id/${id.replace(/^\0/, "__x00__")}`;
  }
  if (id.startsWith("/@")) return id;
  if (id.startsWith("/") && !id.startsWith("//")) {
    return `/@fs${id}`;
  }
  return id;
};
