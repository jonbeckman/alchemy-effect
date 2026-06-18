import { toRuntimeBinding } from "@/Cloudflare/Workers/LocalWorkerProvider.ts";
import type { WorkerBinding } from "@/Cloudflare/Workers/WorkerBinding.ts";
import {
  make,
  PluginContext,
} from "@distilled.cloud/cloudflare-runtime/PluginContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

type WorkerSubscriber = {
  readonly kind: "worker";
  readonly scriptName: string;
  readonly entrypoint?: string;
  readonly props?: unknown;
};

const runServiceBinding = async (binding: WorkerBinding) => {
  const subscriptions: WorkerSubscriber[] = [];
  const context = await Effect.runPromise(
    make(
      { name: "test-worker" } as never,
      new Map([
        [
          "cloudflare-runtime/plugin/RegistryProxy",
          {
            api: {
              subscribe: (subscriber: WorkerSubscriber) =>
                Effect.sync(() => {
                  subscriptions.push(subscriber);
                  return {
                    name: "cloudflare-runtime:registry-proxy",
                    entrypoint: "ExternalService",
                    props: {
                      json: JSON.stringify(subscriber),
                    },
                  };
                }),
            },
          },
        ],
      ]),
    ),
  );

  const hook = await Effect.runPromise(toRuntimeBinding(binding));
  const runtimeBinding = await Effect.runPromise(
    Effect.provideService(
      hook as Effect.Effect<unknown, unknown, PluginContext>,
      PluginContext,
      context,
    ),
  );

  return { subscriptions, runtimeBinding };
};

describe("toRuntimeBinding", () => {
  it("preserves service binding entrypoints for local runtime", async () => {
    const { subscriptions, runtimeBinding } = await runServiceBinding({
      type: "service",
      name: "WORKFLOW_ACTIONS",
      service: "api-worker",
      entrypoint: "WorkflowActions",
    });

    expect(subscriptions).toEqual([
      {
        kind: "worker",
        scriptName: "api-worker",
        entrypoint: "WorkflowActions",
        props: undefined,
      },
    ]);
    expect(runtimeBinding).toEqual({
      name: "WORKFLOW_ACTIONS",
      service: {
        name: "cloudflare-runtime:registry-proxy",
        entrypoint: "ExternalService",
        props: {
          json: JSON.stringify({
            kind: "worker",
            scriptName: "api-worker",
            entrypoint: "WorkflowActions",
          }),
        },
      },
    });
  });
});
