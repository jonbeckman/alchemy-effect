import * as Cloudflare from "@/Cloudflare/index.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Search } from "./search.ts";

/**
 * Declarative (non-Effect) Worker fixture that proves the `ai_search` binding
 * is correctly inferred by `Cloudflare.InferEnv`. Pairs with
 * `worker-async-handler.ts` which reads `env.Search` and calls `info()`.
 */
export const WorkerAsync = Cloudflare.Worker("AiSearchTestWorkerAsync", {
  main: path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "worker-async-handler.ts",
  ),
  subdomain: { enabled: true, previewsEnabled: false },
  compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  bindings: {
    Search,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof WorkerAsync>;
