/// <reference types="@cloudflare/workers-types" />

import type { AsyncWorkerEnv } from "./worker-async.ts";

/**
 * Plain (non-Effect) async worker entry point. The whole point of this
 * fixture is to exercise `Cloudflare.InferEnv` against an AiSearch binding,
 * so the handler reads `env.Search` (typed as `AiSearchInstance`) and calls
 * `.info()` directly.
 */
export default {
  async fetch(_request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const info = await env.Search.info();
    return new Response(JSON.stringify(info), {
      headers: { "content-type": "application/json" },
    });
  },
};
