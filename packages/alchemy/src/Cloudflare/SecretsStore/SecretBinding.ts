import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { StoreSecret } from "./Secret.ts";

export class SecretError extends Data.TaggedError("SecretError")<{
  message: string;
  cause: Error;
}> {}

export interface SecretClient {
  /**
   * Effect that resolves to the raw Cloudflare `SecretsStoreSecret` binding.
   */
  raw: Effect.Effect<runtime.SecretsStoreSecret, never, WorkerEnvironment>;
  /**
   * Read the current value of the secret.
   */
  get(): Effect.Effect<string, SecretError, WorkerEnvironment>;
}

export class SecretBinding extends Binding.Service<
  SecretBinding,
  (secret: StoreSecret) => Effect.Effect<SecretClient>
>()("Cloudflare.SecretsStore.Secret") {}

export const SecretBindingLive = Layer.effect(
  SecretBinding,
  Effect.gen(function* () {
    const bind = yield* SecretBindingPolicy;

    return Effect.fn(function* (secret: StoreSecret) {
      yield* bind(secret);
      const env = WorkerEnvironment.asEffect();
      const raw = env.pipe(
        Effect.map(
          (env) =>
            (env as Record<string, runtime.SecretsStoreSecret>)[
              secret.LogicalId
            ],
        ),
      );
      const tryPromise = <T>(
        fn: () => Promise<T>,
      ): Effect.Effect<T, SecretError> =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new SecretError({
              message: error.message ?? "Unknown error",
              cause: error,
            }),
        });

      return {
        raw,
        get: () => raw.pipe(Effect.flatMap((raw) => tryPromise(() => raw.get()))),
      } satisfies SecretClient;
    });
  }),
);

export class SecretBindingPolicy extends Binding.Policy<
  SecretBindingPolicy,
  (secret: StoreSecret) => Effect.Effect<void>
>()("Cloudflare.SecretsStore.Secret") {}

export const SecretBindingPolicyLive = SecretBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, secret: StoreSecret) {
    if (isWorker(host)) {
      yield* host.bind`${secret}`({
        bindings: [
          {
            type: "secrets_store_secret",
            name: secret.LogicalId,
            secretName: secret.secretName,
            storeId: secret.storeId,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`SecretBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);
