import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  ALCHEMY_PROFILE,
  getAuthProvider,
  loadOrConfigure,
} from "../Auth/index.ts";
import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";
import { encodeState, reviveState } from "./StateEncoding.ts";
import { State, StateStoreError, type StateService } from "./State.ts";
import {
  HTTP_STATE_STORE_AUTH_PROVIDER_NAME,
  type HttpStateStoreAuthConfig,
  type HttpStateStoreResolvedCredentials,
} from "./HttpStateStoreAuth.ts";

/**
 * RPC methods the HTTP state-store server accepts. The wire protocol
 * is generic — any server that implements this contract works.
 */
type RpcMethod =
  | "listStacks"
  | "listStages"
  | "list"
  | "get"
  | "set"
  | "delete"
  | "getReplacedResources";

/** Envelope returned by the server for every RPC call. */
type RpcResult<T> =
  | { ok: true; result: T | null }
  | { ok: false; error: { code: string; message: string } };

const fail = (message: string, cause?: Error) =>
  Effect.fail(new StateStoreError({ message, cause }));

/**
 * Layer that implements {@link State} by POSTing to an HTTP
 * state-store server through Effect's `HttpClient`. Credentials (URL,
 * bearer token, project namespace) are resolved through the
 * {@link HttpStateStoreAuth} provider.
 *
 * Build {@link HttpStateStoreAuth} alongside this layer so the
 * provider is registered before the state-store resolves its config.
 * A `FetchHttpClient.layer` is provided for the underlying transport
 * so consumers don't need to wire one up themselves.
 *
 * The wire contract is generic HTTP RPC at
 * `POST {url}/projects/{project}/state/{method}` with a bearer token
 * and a JSON body. Redacted values round-trip through a
 * `{ __redacted__: … }` envelope on the wire (see {@link encodeState}
 * / {@link reviveState}).
 */
export const HttpStateStore = Layer.effect(
  State,
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<
      HttpStateStoreAuthConfig,
      HttpStateStoreResolvedCredentials
    >(HTTP_STATE_STORE_AUTH_PROVIDER_NAME);
    const profileName = yield* ALCHEMY_PROFILE;
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    const config = yield* loadOrConfigure(auth, profileName, { ci });
    const creds = yield* auth.read(
      profileName,
      config as HttpStateStoreAuthConfig,
    );

    const baseUrl = creds.url.replace(/\/+$/, "");
    const project = creds.project;
    const token = Redacted.value(creds.token);

    // Preconfigure the client with the service's base URL and bearer
    // token. Individual calls only supply the path and body.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((req) =>
        req.pipe(
          HttpClientRequest.prependUrl(baseUrl),
          HttpClientRequest.bearerToken(token),
        ),
      ),
    );

    /**
     * POST `/projects/:project/state/:method` with `body` as JSON.
     *
     * The body is passed through {@link encodeState} first so nested
     * `Redacted<T>` values become `{ __redacted__: … }` envelopes
     * rather than collapsing to the `"<redacted>"` placeholder. The
     * response is parsed with {@link reviveState} so envelopes come
     * back as real `Redacted<T>` values.
     */
    const rpc = <T>(
      method: RpcMethod,
      body: Record<string, unknown>,
    ): Effect.Effect<T | null, StateStoreError, never> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `/projects/${encodeURIComponent(project)}/state/${method}`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe(encodeState(body)));

        const response = yield* client.execute(request);
        const text = yield* response.text;

        let parsed: RpcResult<T>;
        try {
          parsed = JSON.parse(text, reviveState) as RpcResult<T>;
        } catch {
          return yield* fail(
            `non-JSON response from ${method} (status ${response.status}): ${text.slice(0, 500)}`,
          );
        }
        if (!parsed.ok) {
          const err = parsed.error ?? {
            code: "unknown",
            message: `status ${response.status}`,
          };
          return yield* fail(
            `${method} failed: [${err.code}] ${err.message} (status ${response.status})`,
          );
        }
        return (parsed.result ?? null) as T | null;
      }).pipe(
        Effect.catchTag("HttpClientError", (e) =>
          fail(`HTTP error calling ${method}: ${e.message}`, e),
        ),
      );

    const service: StateService = {
      listStacks: () =>
        rpc<string[]>("listStacks", {}).pipe(
          Effect.flatMap((r) =>
            r == null ? fail("listStacks returned null") : Effect.succeed(r),
          ),
        ),
      listStages: (stack) =>
        rpc<string[]>("listStages", { stack }).pipe(
          Effect.flatMap((r) =>
            r == null ? fail("listStages returned null") : Effect.succeed(r),
          ),
        ),
      list: (request) =>
        rpc<string[]>("list", request).pipe(
          Effect.flatMap((r) =>
            r == null ? fail("list returned null") : Effect.succeed(r),
          ),
        ),
      get: (request) =>
        rpc<ResourceState | null>("get", request).pipe(
          // Server returns `null` for missing keys; `StateService`
          // expects `undefined`. Normalise.
          Effect.map((r) => r ?? undefined),
        ),
      getReplacedResources: (request) =>
        rpc<ReplacedResourceState[]>("getReplacedResources", request).pipe(
          Effect.map((r) => r ?? []),
        ),
      set: <V extends ResourceState>(request: {
        stack: string;
        stage: string;
        fqn: string;
        value: V;
      }) =>
        rpc<ResourceState>("set", request).pipe(
          // The server echoes the stored value, but the client
          // already has the canonical object (including any
          // `Redacted<T>` instances); returning it avoids a lossy
          // round-trip.
          Effect.map(() => request.value),
        ),
      delete: (request) => rpc<null>("delete", request).pipe(Effect.asVoid),
    };
    return service;
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
