import * as Cloudflare from "@/Cloudflare/index.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import {
  isWorkflowExport,
  task,
  sleep,
  sleepUntil,
  WorkflowEvent,
  WorkflowStep,
  type WorkflowExport,
  type WorkflowBody,
} from "@/Cloudflare/Workers/Workflow";
import { makeWorkflowBridge } from "@/Cloudflare/Workers/Rpc";
import * as Test from "@/Test/Vitest";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const workflowMain = pathe.resolve(
  import.meta.dirname,
  "workflow-worker.ts",
);

// ---------------------------------------------------------------------------
// isWorkflowExport
// ---------------------------------------------------------------------------

describe("isWorkflowExport", () => {
  it.effect("detects valid WorkflowExport", () =>
    Effect.gen(function* () {
      const valid: WorkflowExport = {
        kind: "workflow",
        make: () => Effect.succeed(Effect.void as any),
      };
      expect(isWorkflowExport(valid)).toBe(true);
    }),
  );

  it.effect("rejects non-workflow values", () =>
    Effect.gen(function* () {
      expect(isWorkflowExport(null)).toBe(false);
      expect(isWorkflowExport(undefined)).toBe(false);
      expect(isWorkflowExport(42)).toBe(false);
      expect(isWorkflowExport("workflow")).toBe(false);
      expect(isWorkflowExport({})).toBe(false);
      expect(isWorkflowExport({ kind: "durableObject" })).toBe(false);
      expect(isWorkflowExport({ kind: "workflow" })).toBe(true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Helpers for bridge tests
// ---------------------------------------------------------------------------

class FakeEntrypoint {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
  async run(_event: any, _step: any): Promise<unknown> {
    return undefined;
  }
}

const fakeStep = () => ({
  do: async (_n: string, fn: () => Promise<unknown>) => fn(),
  sleep: async () => {},
  sleepUntil: async () => {},
});

const makeGetExport = (body: WorkflowBody) => async () => (_env: unknown) =>
  Effect.succeed(body);

// ---------------------------------------------------------------------------
// makeWorkflowBridge
// ---------------------------------------------------------------------------

describe("makeWorkflowBridge", () => {
  it.effect("delegates run() to the Effect body with services", () =>
    Effect.gen(function* () {
      const body: WorkflowBody = Effect.gen(function* () {
        const event = yield* WorkflowEvent;
        const result = yield* task(
          "greet",
          Effect.succeed(`Hello ${event.payload}`),
        );
        return result;
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});
      const result = yield* Effect.promise(() =>
        instance.run(
          { payload: "World", timestamp: new Date(), instanceId: "x" },
          fakeStep(),
        ),
      );
      expect(result).toBe("Hello World");
    }),
  );

  it.effect("wraps step.sleep correctly", () =>
    Effect.gen(function* () {
      let sleepCalledWith: [string, unknown] | undefined;

      const body: WorkflowBody = Effect.gen(function* () {
        yield* sleep("pause", "5 seconds");
        return "done";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});

      const step = {
        ...fakeStep(),
        sleep: async (name: string, duration: unknown) => {
          sleepCalledWith = [name, duration];
        },
      };

      const result = yield* Effect.promise(() =>
        instance.run(
          { payload: {}, timestamp: new Date(), instanceId: "x" },
          step,
        ),
      );

      expect(result).toBe("done");
      expect(sleepCalledWith).toEqual(["pause", "5 seconds"]);
    }),
  );

  it.effect("wraps step.sleepUntil correctly", () =>
    Effect.gen(function* () {
      let sleepUntilCalledWith: [string, unknown] | undefined;
      const target = new Date("2025-06-01T00:00:00Z");

      const body: WorkflowBody = Effect.gen(function* () {
        yield* sleepUntil("wait", target);
        return "done";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});

      const step = {
        ...fakeStep(),
        sleepUntil: async (name: string, ts: unknown) => {
          sleepUntilCalledWith = [name, ts];
        },
      };

      yield* Effect.promise(() =>
        instance.run(
          { payload: {}, timestamp: new Date(), instanceId: "x" },
          step,
        ),
      );

      expect(sleepUntilCalledWith?.[0]).toBe("wait");
      expect(sleepUntilCalledWith?.[1]).toBe(target.toISOString());
    }),
  );

  it.effect("provides WorkflowEvent with correct fields", () =>
    Effect.gen(function* () {
      let receivedPayload: unknown;
      let receivedTimestamp: Date | undefined;
      let receivedInstanceId: string | undefined;

      const body: WorkflowBody = Effect.gen(function* () {
        const event = yield* WorkflowEvent;
        receivedPayload = event.payload;
        receivedTimestamp = event.timestamp;
        receivedInstanceId = event.instanceId;
        return "ok";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});
      const ts = new Date("2025-01-01T00:00:00Z");

      yield* Effect.promise(() =>
        instance.run(
          { payload: { key: "value" }, timestamp: ts, instanceId: "abc-123" },
          fakeStep(),
        ),
      );

      expect(receivedPayload).toEqual({ key: "value" });
      expect(receivedTimestamp).toEqual(ts);
      expect(receivedInstanceId).toBe("abc-123");
    }),
  );

  it.effect("converts numeric timestamp to Date", () =>
    Effect.gen(function* () {
      let receivedTimestamp: Date | undefined;
      const tsNum = 1735689600000;

      const body: WorkflowBody = Effect.gen(function* () {
        const event = yield* WorkflowEvent;
        receivedTimestamp = event.timestamp;
        return "ok";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});

      yield* Effect.promise(() =>
        instance.run(
          { payload: {}, timestamp: tsNum, instanceId: "" },
          fakeStep(),
        ),
      );

      expect(receivedTimestamp).toBeInstanceOf(Date);
      expect(receivedTimestamp!.getTime()).toBe(tsNum);
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────
// Lifecycle convergence
//
// Reconcile must converge from any starting state — pristine, drifted,
// or out-of-band-deleted — without leaning on `olds` as a source of
// truth. Each test runs `destroy → deploy → … → destroy` against a
// real Cloudflare account.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "redeploy with same props is a no-op (workflow identity preserved)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("WorkflowIdempotent", {
            main: workflowMain,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
          return worker;
        }),
      );

      const observed1 = yield* workflows.getWorkflow({
        accountId,
        workflowName: "EchoWorkflow",
      });
      expect(observed1.scriptName).toEqual(v1.workerName);
      expect(observed1.className).toEqual("EchoWorkflow");

      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("WorkflowIdempotent", {
            main: workflowMain,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
          return worker;
        }),
      );
      expect(v2.workerName).toEqual(v1.workerName);

      const observed2 = yield* workflows.getWorkflow({
        accountId,
        workflowName: "EchoWorkflow",
      });
      // Workflow id is stable across no-op redeploys.
      expect(observed2.id).toEqual(observed1.id);
      expect(observed2.scriptName).toEqual(observed1.scriptName);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets workflow scriptName mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("WorkflowDrift", {
            main: workflowMain,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      // Out-of-band: stand up a *different* worker that also defines
      // EchoWorkflow, then re-`putWorkflow` to point at that script.
      // This simulates a dashboard edit that re-targets the workflow.
      const driftedWorker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("WorkflowDriftAlt", {
            main: workflowMain,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      yield* workflows.putWorkflow({
        accountId,
        workflowName: "EchoWorkflow",
        className: "EchoWorkflow",
        scriptName: driftedWorker.workerName,
      });

      const drifted = yield* workflows.getWorkflow({
        accountId,
        workflowName: "EchoWorkflow",
      });
      expect(drifted.scriptName).toEqual(driftedWorker.workerName);

      // Reconcile of the original logical resource must observe the
      // drifted scriptName and putWorkflow back to the original
      // worker's script.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("WorkflowDrift", {
            main: workflowMain,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      expect(v2.workerName).toEqual(v1.workerName);

      const reconverged = yield* workflows.getWorkflow({
        accountId,
        workflowName: "EchoWorkflow",
      });
      expect(reconverged.scriptName).toEqual(v1.workerName);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      yield* waitForWorkerToBeDeleted(driftedWorker.workerName, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a workflow deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("WorkflowRecreate", {
            main: workflowMain,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      // Delete the workflow out-of-band. Local state still claims it
      // exists; Cloudflare disagrees. Reconcile must observe the
      // missing workflow (WorkflowNotFound caught), fall through to
      // putWorkflow, and converge.
      yield* workflows.deleteWorkflow({
        accountId,
        workflowName: "EchoWorkflow",
      });

      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("WorkflowRecreate", {
            main: workflowMain,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      expect(v2.workerName).toEqual(v1.workerName);

      const recreated = yield* workflows.getWorkflow({
        accountId,
        workflowName: "EchoWorkflow",
      });
      expect(recreated.scriptName).toEqual(v1.workerName);
      expect(recreated.className).toEqual("EchoWorkflow");

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
    }).pipe(logLevel),
);

test.provider("destroying an already-deleted workflow is a no-op", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("WorkflowDoubleDestroy", {
          main: workflowMain,
          url: false,
          compatibility: { date: "2024-01-01" },
        });
      }),
    );

    // Delete the workflow out-of-band so the next destroy hits the
    // `WorkflowNotFound` path inside provider.delete. It must succeed.
    yield* workflows.deleteWorkflow({
      accountId,
      workflowName: "EchoWorkflow",
    });

    // First destroy: the engine still has state for this resource;
    // delete should idempotently succeed because the underlying
    // `deleteWorkflow` call catches `WorkflowNotFound`.
    yield* stack.destroy();

    // Second destroy: state is gone; this is a true no-op. Repeated
    // destroys must never throw.
    yield* stack.destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(logLevel),
);
