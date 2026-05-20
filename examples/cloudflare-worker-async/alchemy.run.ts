import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { Counter as CounterClass } from "./src/async-worker.ts";

export const DB = Cloudflare.D1Database("DB");

export const Bucket = Cloudflare.R2Bucket("Bucket");

// Queue producer + consumer wiring (both sides exercised by the same worker).
// The Worker sends a message via `env.QUEUE.send(...)` from POST /queue/send,
// then receives and persists it via its `queue(batch)` handler — end-to-end
// regression guard for the Queue, QueueBinding, and QueueConsumer resources.
export const Queue = Cloudflare.Queue("Queue");

export const Counter = Cloudflare.DurableObjectNamespace<CounterClass>(
  "Counter",
  {
    className: "Counter",
  },
);

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/async-worker.ts",
  assets: {
    directory: "./public",
  },
  bindings: {
    DB,
    Bucket,
    Queue,
    Counter,
  },
});

export default Alchemy.Stack(
  "CloudflareWorker",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const queue = yield* Queue;
    const asyncWorker = yield* Worker;

    // Register the same worker script as a consumer of Queue. The worker's
    // `queue(batch)` handler (see src/worker.ts) receives each message batch.
    yield* Cloudflare.QueueConsumer("QueueConsumer", {
      queueId: queue.queueId,
      scriptName: asyncWorker.workerName,
      settings: {
        batchSize: 10,
        maxRetries: 3,
        maxWaitTimeMs: 5000,
      },
    });

    const rpcWorker = yield* Cloudflare.Worker("RpcWorker", {
      main: "./src/rpc-worker.ts",
    });

    const httpWorker = yield* Cloudflare.Worker("HttpWorker", {
      main: "./src/http-worker.ts",
      compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
    });

    return {
      async: asyncWorker.url,
      rpc: rpcWorker.url,
      http: httpWorker.url,
    };
  }),
);
