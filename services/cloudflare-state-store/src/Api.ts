import * as Cloudflare from "alchemy/Cloudflare";
import type { ResourceState } from "alchemy/State";
import { STATE_STORE_SCRIPT_NAME } from "alchemy/State/HttpStateStoreConstants";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import StateStore, { ROOT_DO_NAME } from "./StateStore.ts";
import { AuthToken } from "./Token.ts";

class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}
class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly message: string;
}> {}

/**
 * Timing-safe string comparison using the Workers runtime's built-in
 * `crypto.subtle.timingSafeEqual`.
 *
 * @see https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
};

const errorResponse = (
  code: string,
  message: string,
  status: number,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
  HttpServerResponse.json(
    { ok: false, error: { code, message } },
    { status },
  ).pipe(Effect.orDie);

const okResponse = (
  result: unknown,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
  HttpServerResponse.json({ ok: true, result: result ?? null }).pipe(
    Effect.orDie,
  );

const requireString = (
  body: Record<string, unknown>,
  field: string,
): Effect.Effect<string, BadRequest> => {
  const value = body[field];
  return typeof value === "string" && value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new BadRequest({
          message: `field '${field}' is required and must be a non-empty string`,
        }),
      );
};

const requireObject = (
  body: Record<string, unknown>,
  field: string,
): Effect.Effect<ResourceState, BadRequest> => {
  const value = body[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? Effect.succeed(value as ResourceState)
    : Effect.fail(
        new BadRequest({
          message: `field '${field}' is required and must be an object`,
        }),
      );
};

/**
 * Parse the JSON body of the current request, normalising errors to
 * `BadRequest`. Reads `HttpServerRequest` from the Effect context.
 */
const parseBody: Effect.Effect<
  Record<string, unknown>,
  BadRequest,
  HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const text = yield* request.text.pipe(Effect.orDie);
  return yield* Effect.try({
    try: () => {
      const body = text ? JSON.parse(text) : {};
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("expected JSON object body");
      }
      return body as Record<string, unknown>;
    },
    catch: (e) =>
      new BadRequest({
        message: e instanceof Error ? e.message : "invalid JSON body",
      }),
  });
});

/**
 * Wrap a handler so its tagged errors map to structured JSON
 * responses and any defect (e.g. from `Effect.orDie`ed DO calls)
 * returns a JSON 500 instead of Cloudflare's default plain-text error
 * page.
 *
 * Handlers declare their failure modes as `Unauthorized | BadRequest`
 * so `catchTag` can pattern-match concretely.
 */
const wrap = <R>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Unauthorized | BadRequest,
    R
  >,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  handler.pipe(
    Effect.catchTag("Unauthorized", () =>
      errorResponse("unauthorized", "invalid bearer token", 401),
    ),
    Effect.catchTag("BadRequest", (e) =>
      errorResponse("bad_request", e.message, 400),
    ),
    Effect.catchCause((cause) => errorResponse("internal", String(cause), 500)),
  );

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    name: STATE_STORE_SCRIPT_NAME,
    main: import.meta.path,
    url: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const secret = yield* Cloudflare.Secret.bind(AuthToken);
    const stateStore = yield* StateStore;

    let cachedToken: string | undefined;

    const authenticate = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const authHeader = request.headers.authorization ?? "";
      const prefix = "Bearer ";
      if (!authHeader.startsWith(prefix)) {
        return yield* Effect.fail(new Unauthorized());
      }
      const presented = authHeader.slice(prefix.length).trim();
      if (cachedToken === undefined) {
        cachedToken = yield* secret
          .get()
          .pipe(
            Effect.catchTag("SecretError", () =>
              Effect.fail(new Unauthorized()),
            ),
          );
      }
      if (!cachedToken || !timingSafeEqual(presented, cachedToken)) {
        return yield* Effect.fail(new Unauthorized());
      }
    });

    // `stateStore.getByName(...)` must be called lazily from inside a
    // request handler — at plan/pre-create time the DO binding isn't
    // bound yet (`WorkerEnvironment` is undefined) and the call throws.

    /** DO instance that holds the stack-name index. */
    const rootDO = () => stateStore.getByName(ROOT_DO_NAME);

    /** DO instance for a specific stack. */
    const stackDO = (stack: string) => stateStore.getByName(stack);

    const routes = Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/state/listStacks",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const result = yield* rootDO().listStacks().pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/state/listStages",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const result = yield* stackDO(stack)
              .listStages()
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/state/list",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const result = yield* stackDO(stack)
              .list({ stage })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/state/get",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const fqn = yield* requireString(body, "fqn");
            const result = yield* stackDO(stack)
              .get({ stage, fqn })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/state/set",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const fqn = yield* requireString(body, "fqn");
            const value = yield* requireObject(body, "value");
            // Write the resource first — if root registration fails
            // afterward, the next `set` on the same stack retries it
            // (registerStack is idempotent).
            const result = yield* stackDO(stack)
              .set({ stage, fqn, value })
              .pipe(Effect.orDie);
            yield* rootDO().registerStack({ stack }).pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/state/delete",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const fqn = yield* requireString(body, "fqn");
            // The DO method is `remove`, not `delete` — `delete` is
            // reserved by Cloudflare's RPC stub proxy.
            yield* stackDO(stack).remove({ stage, fqn }).pipe(Effect.orDie);
            return yield* okResponse(null);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/state/getReplacedResources",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const result = yield* stackDO(stack)
              .getReplacedResources({ stage })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
    ).pipe(Layer.provideMerge(HttpRouter.layer));

    const fetch = yield* HttpRouter.toHttpEffect(routes);

    return {
      // Any error from unmatched routes (`HttpServerError`) or a
      // leaked defect collapses to a JSON 500 instead of Cloudflare's
      // default plain-text 500 page.
      fetch: fetch.pipe(
        Effect.catchCause((cause) =>
          errorResponse("internal", String(cause), 500),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.SecretBindingLive))),
) {}
