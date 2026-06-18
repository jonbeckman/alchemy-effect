import * as Cloudflare from "@/Cloudflare";
import { toBinding } from "@/Cloudflare/Workers/WorkerAsyncBindings.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

interface WorkflowActionsEntrypoint {
  run(name: string): Effect.Effect<string>;
}

type Assert<T extends true> = T;
type IsAssignable<A, B> = A extends B ? true : false;

const workflowActions: Cloudflare.WorkerEntrypointBinding<WorkflowActionsEntrypoint> =
  {
    BindingType: "Cloudflare.WorkerEntrypointBinding",
    service: "api-worker",
    entrypoint: "WorkflowActions",
  };

const dynamicWorkflow = {
  BindingType: "Cloudflare.Workflow",
  workflowName: "dynamic-workflow",
  className: "DynamicUserWorkflow",
  scriptName: "api-worker",
} as unknown as Cloudflare.WorkflowResource;

type _EntrypointIsService = Assert<
  IsAssignable<Cloudflare.GetBindingType<typeof workflowActions>, Service>
>;
type _EntrypointMethodIsRpc = Assert<
  IsAssignable<
    Cloudflare.GetBindingType<typeof workflowActions>["run"],
    (name: string) => Promise<string | Cloudflare.RpcErrorEnvelope>
  >
>;
type _WorkflowIsRuntimeWorkflow = Assert<
  IsAssignable<Cloudflare.GetBindingType<typeof dynamicWorkflow>, Workflow>
>;

describe("toBinding", () => {
  it("converts named worker entrypoint bindings to service bindings", () => {
    expect(toBinding("WORKFLOW_ACTIONS", workflowActions)).toEqual({
      type: "service",
      name: "WORKFLOW_ACTIONS",
      service: "api-worker",
      entrypoint: "WorkflowActions",
    });
  });

  it("converts WorkflowResource values to workflow bindings", () => {
    expect(toBinding("DYNAMIC_WORKFLOW", dynamicWorkflow)).toEqual({
      type: "workflow",
      name: "DYNAMIC_WORKFLOW",
      workflowName: "dynamic-workflow",
      className: "DynamicUserWorkflow",
      scriptName: "api-worker",
    });
  });
});
