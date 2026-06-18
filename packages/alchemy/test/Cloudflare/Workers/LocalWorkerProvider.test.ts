import { toRuntimeBinding } from "@/Cloudflare/Workers/LocalWorkerProvider.ts";
import type { WorkerBinding } from "@/Cloudflare/Workers/WorkerBinding.ts";
import {
  make,
  PluginContext,
} from "@distilled.cloud/cloudflare-runtime/PluginContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

type RemoteBinding = {
  readonly name: string;
  readonly type: string;
  readonly [key: string]: unknown;
};

const runRemoteBinding = async (binding: WorkerBinding) => {
  const registrations: RemoteBinding[] = [];
  const context = await Effect.runPromise(
    make(
      { name: "test-worker" } as never,
      new Map([
        [
          "cloudflare-runtime/plugin/RemoteBindings",
          {
            api: {
              register: (binding: RemoteBinding) =>
                Effect.sync(() => {
                  registrations.push(binding);
                  return {
                    name: "remote-bindings:client",
                    props: {
                      json: JSON.stringify({ binding: binding.name }),
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

  return { registrations, runtimeBinding };
};

describe("toRuntimeBinding", () => {
  it("converts AI Search instance bindings for local runtime", async () => {
    const { registrations, runtimeBinding } = await runRemoteBinding({
      type: "ai_search",
      name: "SEARCH",
      instanceName: "docs",
      namespace: "default",
    });

    expect(registrations).toEqual([
      {
        type: "ai_search",
        name: "SEARCH",
        instanceName: "docs",
      },
    ]);
    expect(runtimeBinding).toEqual({
      name: "SEARCH",
      service: {
        name: "remote-bindings:client",
        props: { json: JSON.stringify({ binding: "SEARCH" }) },
      },
    });
  });

  it("converts AI Search namespace bindings for local runtime", async () => {
    const { registrations, runtimeBinding } = await runRemoteBinding({
      type: "ai_search_namespace",
      name: "SEARCH_NS",
      namespace: "docs",
    });

    expect(registrations).toEqual([
      {
        type: "ai_search_namespace",
        name: "SEARCH_NS",
        namespace: "docs",
      },
    ]);
    expect(runtimeBinding).toEqual({
      name: "SEARCH_NS",
      service: {
        name: "remote-bindings:client",
        props: { json: JSON.stringify({ binding: "SEARCH_NS" }) },
      },
    });
  });
});
