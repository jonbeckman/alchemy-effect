import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import * as HttpEffectModule from "effect/unstable/http/HttpEffect";
import type * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import { isWorkerEvent, type WorkerServices } from "./Worker.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const workersHttpHandler = <Req = never>(
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return (event: any) => {
    if (isWorkerEvent(event) && event.type === "fetch") {
      const webRequest = event.input;
      return serveWebRequest(webRequest, safeHandler, {
        remoteAddress: webRequest.headers.get("cf-connecting-ip") ?? undefined,
      });
    }
  };
};

export const serveWebRequest = <Req = never>(
  webRequest: cf.Request,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError | HttpBodyError,
    Req
  >,
  options: {
    // Preserve transport metadata when this helper is adapting a request
    // that originated from another runtime surface.
    remoteAddress?: string;
    // Durable Objects need to register the accepted socket on object state
    // instead of calling `server.accept()` directly.
    acceptWebSocket?: (socket: cf.WebSocket) => void;
  } = {},
): Effect.Effect<
  Response,
  never,
  Exclude<Req, HttpServerRequest.HttpServerRequest | Scope>
> =>
  Effect.flatMap(Effect.context<any>(), (parentContext) =>
    Effect.callback<Response>((resume) => {
      const request = HttpServerRequest.fromWeb(
        webRequest as any as globalThis.Request,
      ).modify({
        remoteAddress: Option.fromUndefinedOr(options.remoteAddress),
      });

      Object.defineProperty(request, "raw", {
        get: () =>
          Object.assign(request.stream, {
            raw: webRequest.body,
          }),
      });

      // Run the handler through `toHandled` so any `preResponseHandler`s that
      // middleware (e.g. `HttpMiddleware.cors()`) registered on the request
      // are applied to the final response. Without this drain, only OPTIONS
      // preflights — which `cors()` short-circuits — get CORS headers; real
      // GET/POST/etc. responses don't.
      const httpApp = HttpEffectModule.toHandled(
        handler,
        (_req, response) => {
          const transferred = HttpEffectModule.scopeTransferToStream(response);
          resume(
            Effect.succeed(
              HttpServerResponse.toWeb(transferred, { context: parentContext }),
            ),
          );
          return Effect.void;
        },
      );

      const fiber = httpApp.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(Request, webRequest as any),
        Effect.provide(parentContext),
        Effect.runFork,
      );

      return Effect.sync(() => {
        fiber.interruptUnsafe();
      });
    }),
  ) as any;
