import type * as vite from "vite";

/**
 * Append `if (import.meta.hot) import.meta.hot.accept()` to user
 * client modules so a plain Vite SPA gets hot-update behavior without
 * the user writing the boilerplate by hand.
 *
 * Heuristics:
 *  - dev only (`apply: "serve"`).
 *  - client environment only — SSR modules go through the host worker
 *    runner and don't use Vite's browser HMR client.
 *  - JS/TS source files — no JSON, CSS, virtuals, query strings, or
 *    files inside `node_modules`.
 *  - skip modules that already mention `import.meta.hot` so users
 *    keeping explicit accept boundaries aren't double-instrumented.
 *
 * Frameworks with their own HMR plumbing (React Refresh, Vue SFC,
 * Svelte) inject their accept calls earlier in the transform pipeline
 * and will already be matched by the existing-mention skip; this hook
 * is a no-op in those cases.
 */
export const autoAcceptHmrPlugin = (): vite.Plugin => ({
  name: "alchemy:auto-hmr-accept",
  apply: "serve",
  applyToEnvironment(environment) {
    return environment.name === "client";
  },
  transform: {
    order: "post",
    handler(code, id) {
      if (id.includes("\0")) return null;
      if (id.includes("node_modules")) return null;
      const cleanId = id.split("?")[0];
      if (!/\.[jt]sx?$/.test(cleanId)) return null;
      if (code.includes("import.meta.hot")) return null;
      return {
        code:
          code +
          "\n;if (import.meta.hot) import.meta.hot.accept();\n",
        map: null,
      };
    },
  },
});
