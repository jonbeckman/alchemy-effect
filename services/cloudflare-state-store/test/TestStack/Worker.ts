import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * A minimal Cloudflare Worker used by the login integration test.
 *
 * Lives in its own file so `main: import.meta.path` resolves to a
 * module that does **not** execute `Alchemy.Stack(...)` /
 * `Cloudflare.providers()` at load time — those pull in every
 * provider (including `CloudflareAuth` → Clank → `sisteransi`) and
 * end up in the worker bundle. Keeping the worker entry lean avoids
 * "No such module 'sisteransi'" at deploy-time.
 */
export default class TestWorker extends Cloudflare.Worker<TestWorker>()(
  "TestWorker",
  {
    name: "alchemy-state-store-test-worker",
    main: import.meta.path,
    url: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return HttpServerResponse.text(
          `state-store-test-worker OK (${request.method} ${request.url})`,
        );
      }),
    };
  }),
) {}
