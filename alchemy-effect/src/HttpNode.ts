import * as NodeHttpServerPlatform from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeHttp from "node:http";
import { HttpServer, resolvePort, safeHttpEffect } from "./Http.ts";

export const NodeHttpServer = () =>
  Layer.succeed(HttpServer, {
    serve: (handler, options) =>
      Effect.gen(function* () {
        const port = yield* resolvePort(options);
        const server = yield* NodeHttpServerPlatform.make(
          NodeHttp.createServer,
          { port },
        );
        yield* server.serve(safeHttpEffect(handler));
      }).pipe(Effect.orDie),
  });
