import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import { replaceEffectStream } from "../stream.ts";
import type { KVNamespace } from "./KVNamespace.ts";
import { NamespaceBinding } from "./KVNamespaceBinding.ts";

export type PutValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | runtime.ReadableStream
  | Stream.Stream<any>;

export interface PutOptions extends runtime.KVNamespacePutOptions {}

export class Put extends Binding.Service<
  Put,
  (
    namespace: KVNamespace,
  ) => Effect.Effect<
    (
      key: string,
      value: PutValue,
      options?: PutOptions,
    ) => Effect.Effect<void, never, WorkerEnvironment>
  >
>()("Cloudflare.KV.Put") {}

export const PutLive = Layer.effect(
  Put,
  Effect.gen(function* () {
    const Policy = yield* PutPolicy;

    return Effect.fn(function* (namespace: KVNamespace) {
      yield* Policy(namespace);

      return (key: string, value: PutValue, options?: PutOptions) =>
        WorkerEnvironment.asEffect().pipe(
          Effect.flatMap((env) => {
            const kvNamespace = (
              env as Record<string, runtime.KVNamespace>
            )[namespace.LogicalId];
            return Effect.promise(() =>
              kvNamespace.put(key, replaceEffectStream(value), options),
            );
          }),
        );
    });
  }),
);

export class PutPolicy extends Binding.Policy<
  PutPolicy,
  (namespace: KVNamespace) => Effect.Effect<void>
>()("Cloudflare.KV.Put") {}

export const PutPolicyLive = PutPolicy.layer.succeed(NamespaceBinding);
