import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CallerRpcs } from "./group.ts";
import BindingTargetRpcWorker from "./target-worker.ts";

/**
 * Caller {@link RpcWorker} that uses `Cloudflare.RpcWorker.bind` to
 * obtain a per-request factory for {@link BindingTargetRpcWorker}.
 *
 * The bind call is hoisted to **init**: it registers the service
 * binding on this worker and returns an `Effect<RpcClient>` factory.
 * Each `ProxyGreet` request `yield*`s the factory to build a fresh
 * `RpcClient` (Cloudflare rejects cross-request reuse of the
 * underlying stub I/O).
 */
export default class BindingCallerRpcWorker extends Cloudflare.RpcWorker<BindingCallerRpcWorker>()(
  "BindingCallerRpcWorker",
  { main: import.meta.filename, schema: CallerRpcs },
  Effect.gen(function* () {
    const makeTarget = yield* Cloudflare.RpcWorker.bind(BindingTargetRpcWorker);

    const handlers = CallerRpcs.toLayer({
      ProxyGreet: ({ name }) =>
        Effect.gen(function* () {
          const target = yield* makeTarget;
          return yield* target.Greet({ name });
        }).pipe(Effect.orDie),
    });
    return RpcServer.toHttpEffect(CallerRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }),
) {}
