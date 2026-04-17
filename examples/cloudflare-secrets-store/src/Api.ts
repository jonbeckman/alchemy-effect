import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ApiKey } from "./Secret.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const secret = yield* Cloudflare.StoreSecret.bind(ApiKey);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url === "/secret") {
          const value = yield* secret
            .get()
            .pipe(
              Effect.catchTag("SecretError", (err) =>
                Effect.succeed(`Error: ${err.message}`),
              ),
            );
          const masked = value.slice(0, 4) + "****";
          return HttpServerResponse.text(`Secret (masked): ${masked}`);
        }

        return HttpServerResponse.text(
          "Hello from Cloudflare Secrets Store example!",
        );
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.SecretBindingLive))),
) {}
