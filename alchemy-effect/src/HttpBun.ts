import * as BunHttpServerPlatform from "@effect/platform-bun/BunHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer, resolvePort, safeHttpEffect } from "./Http.ts";

export const BunHttpServer = () =>
  Layer.succeed(HttpServer, {
    serve: (handler, options) =>
      Effect.gen(function* () {
        const port = yield* resolvePort(options);
        const server = yield* BunHttpServerPlatform.make({ port });
        yield* server.serve(safeHttpEffect(handler));
      }).pipe(Effect.orDie),
  });
