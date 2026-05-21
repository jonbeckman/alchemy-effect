/// <reference types="@cloudflare/workers-types" />

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { WorkerBinding } from "../Workers/WorkerBinding.ts";
import type { AiSearch as AiSearchResource } from "./AiSearch.ts";

/**
 * Error raised by AI Search runtime operations.
 */
export class AiSearchError extends Data.TaggedError("AiSearchError")<{
  message: string;
  cause: unknown;
}> {}

/**
 * Effect-native client for a Cloudflare AI Search Worker binding.
 *
 * Wraps the runtime `AiSearchInstance` binding so each operation returns an
 * Effect tagged with {@link AiSearchError}. Use
 * `Cloudflare.AiSearch.bind(instance)` inside a Worker's init phase.
 */
export interface AiSearchClient {
  /**
   * Effect resolving to the raw `AiSearchInstance` binding.
   */
  raw: Effect.Effect<AiSearchInstance, never, RuntimeContext>;
  /**
   * Search the instance for chunks relevant to the request.
   */
  search(
    params: AiSearchSearchRequest,
  ): Effect.Effect<AiSearchSearchResponse, AiSearchError, RuntimeContext>;
  /**
   * Run a chat completion grounded in retrieved chunks.
   */
  chatCompletions(
    params: AiSearchChatCompletionsRequest,
  ): Effect.Effect<
    AiSearchChatCompletionsResponse,
    AiSearchError,
    RuntimeContext
  >;
  /**
   * Get instance statistics (item count, indexing status, etc.).
   */
  stats(): Effect.Effect<AiSearchStatsResponse, AiSearchError, RuntimeContext>;
  /**
   * Get metadata about the instance.
   */
  info(): Effect.Effect<AiSearchInstanceInfo, AiSearchError, RuntimeContext>;
}

/**
 * Binding service that turns an {@link AiSearchResource} resource into a typed
 * {@link AiSearchClient} for Worker runtime code.
 */
export class AiSearchBinding extends Binding.Service<
  AiSearchBinding,
  (instance: AiSearchResource) => Effect.Effect<AiSearchClient>
>()("Cloudflare.AiSearch.Binding") {}

/**
 * Runtime layer for {@link AiSearchBinding}.
 */
export const AiSearchBindingLive = Layer.effect(
  AiSearchBinding,
  Effect.gen(function* () {
    const Policy = yield* AiSearchBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (instance: AiSearchResource) {
      yield* Policy(instance);
      const raw = Effect.sync(
        () => (env as Record<string, AiSearchInstance>)[instance.LogicalId]!,
      );

      const use = <T>(
        fn: (raw: AiSearchInstance) => Promise<T>,
      ): Effect.Effect<T, AiSearchError> =>
        raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));

      return {
        raw,
        search: (params) => use((r) => r.search(params)),
        chatCompletions: (params) =>
          use((r) => r.chatCompletions(params)) as Effect.Effect<
            AiSearchChatCompletionsResponse,
            AiSearchError,
            RuntimeContext
          >,
        stats: () => use((r) => r.stats()),
        info: () => use((r) => r.info()),
      } satisfies AiSearchClient;
    });
  }),
);

/**
 * Deploy-time policy service that attaches an AI Search binding to Workers.
 */
export class AiSearchBindingPolicy extends Binding.Policy<
  AiSearchBindingPolicy,
  (instance: AiSearchResource) => Effect.Effect<void>
>()("Cloudflare.AiSearch.Binding") {}

/**
 * Live deploy-time policy layer for {@link AiSearchBindingPolicy}.
 *
 * Emits an `ai_search` binding (single-instance form) — the runtime
 * `env[name]` is an `AiSearchInstance` scoped to the bound instance.
 */
export const AiSearchBindingPolicyLive = AiSearchBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, instance: AiSearchResource) {
    if (isWorker(host)) {
      // The `ai_search` binding type is present in Cloudflare's API but not
      // yet exposed by `PutScriptRequest` in @distilled.cloud/cloudflare
      // v0.21.3 — cast through `unknown` until the SDK regenerates.
      const aiSearchBinding = {
        type: "ai_search" as const,
        name: instance.LogicalId,
        instanceName: instance.instanceName,
      } as unknown as WorkerBinding;
      yield* host.bind`${instance}`({ bindings: [aiSearchBinding] });
    } else {
      return yield* Effect.die(
        new Error(`AiSearchBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, AiSearchError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new AiSearchError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown AI Search runtime error",
        cause: error,
      }),
  });
