import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

export const ping = HttpApiEndpoint.get("ping", "/ping", {
  success: Schema.String,
});

export class Api extends HttpApi.make("Api").add(
  HttpApiGroup.make("Tasks").add(ping),
) {}

const httpEffect = HttpApiBuilder.layer(Api).pipe(HttpRouter.toHttpEffect);

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export default {
  fetch(request: Request) {
    const layer = Layer.mergeAll(
      HttpApiBuilder.group(Api, "Tasks", (handlers) =>
        handlers.handle("ping", () => Effect.succeed("pong")),
      ),
      Layer.succeed(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request as any).modify({
          remoteAddress: Option.fromUndefinedOr(
            request.headers.get("cf-connecting-ip") ?? undefined,
          ),
        }),
      ),
      FetchHttpClient.layer,
      NodeServices.layer,
    ).pipe(Layer.provideMerge([Etag.layer, HttpPlatformStub, Path.layer]));
    const eff = httpEffect.pipe(
      Effect.flatMap((eff) => eff),
      Effect.provide(layer),
      Effect.flatMap((response) =>
        Effect.context().pipe(
          Effect.map((context) =>
            HttpServerResponse.toWeb(response as any, {
              context,
            }),
          ),
        ),
      ),
      Effect.scoped,
    );

    return Effect.runPromise(eff);
  },
};
