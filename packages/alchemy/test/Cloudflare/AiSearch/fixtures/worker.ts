import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Search } from "./search.ts";

/**
 * Worker fixture that proves the `ai_search` binding is wired up by calling
 * `search.info()` to round-trip metadata through the runtime
 * `AiSearchInstance` binding. Indexed content isn't required — `info()` works
 * as soon as the instance exists.
 */
export default class AiSearchTestWorker extends Cloudflare.Worker<AiSearchTestWorker>()(
  "AiSearchTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const search = yield* Cloudflare.AiSearch.bind(Search);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/info")) {
          const info = yield* search.info().pipe(Effect.orDie);
          return yield* HttpServerResponse.json(info);
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.AiSearchBindingLive)),
) {}
