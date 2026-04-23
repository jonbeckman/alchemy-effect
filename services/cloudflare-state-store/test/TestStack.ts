import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import TestWorker from "./TestWorker.ts";

/**
 * Downstream stack whose only resource is {@link TestWorker}. Deploy
 * and destroy it with `HttpStateStore` as the `State` service to
 * exercise the remote-state flow end-to-end.
 *
 * This file is the *stack* definition — it is never used as a worker
 * entry module. The worker entry lives in `TestWorker.ts` which
 * imports far less of the Cloudflare surface, keeping the bundled
 * worker small.
 */
export default Alchemy.Stack(
  "AlchemyStateStoreLoginTest",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const worker = yield* TestWorker;
    return { url: worker.url.as<string>() };
  }),
);
