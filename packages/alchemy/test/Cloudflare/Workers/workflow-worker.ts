import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Test fixture: a Worker that defines a single Workflow class.
 *
 * The Workflow body just echoes the event payload through a `task` so
 * the bundle has real workflow metadata that exercises the
 * `WorkflowResource` reconcile path.
 */
class EchoWorkflow extends Cloudflare.Workflow<EchoWorkflow>()(
  "EchoWorkflow",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const event = yield* Cloudflare.WorkflowEvent;
      return yield* Cloudflare.task(
        "echo",
        Effect.succeed({ received: event.payload }),
      );
    });
  }),
) {}

export default class WorkflowFixtureWorker extends Cloudflare.Worker<WorkflowFixtureWorker>()(
  "WorkflowFixtureWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    yield* EchoWorkflow;
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok", { status: 200 });
      }),
    };
  }),
) {}
