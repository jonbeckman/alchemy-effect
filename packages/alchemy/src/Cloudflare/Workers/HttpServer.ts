import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import { isWorkerEvent, type WorkerServices } from "./Worker.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler = <Req = never>(
  httpEffect: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  const safeHttpEffect = Http.makeSafeHttpEffect(httpEffect);
  return (event: Request) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, safeHttpEffect, {
          remoteAddress:
            event.input.headers.get("cf-connecting-ip") ?? undefined,
        })
      : undefined;
};

export const makeRequestEffect = <Req = never>(
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
  Exclude<Req, HttpServerRequest.HttpServerRequest | Scope.Scope>
> =>
  Effect.gen(function* () {
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

    return HttpServerResponse.toWeb(
      yield* handler.pipe(
        Effect.provide([
          Layer.succeed(HttpServerRequest.HttpServerRequest, request),
          Layer.succeed(Request, webRequest as any),
        ]),
      ),
    );
  }) as any;
