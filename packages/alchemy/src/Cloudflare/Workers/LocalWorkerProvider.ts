import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as path from "node:path";
import * as Provider from "../../Provider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { Sidecar } from "../Local/Sidecar.ts";
import { getCompatibility } from "./Compatibility.ts";
import { Worker, type WorkerBinding, type WorkerProps } from "./Worker.ts";
import { createWorkerName } from "./WorkerName.ts";

export const LocalWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const stack = yield* Stack;
      const sidecar = yield* Sidecar;

      const run = Effect.fn(function* (
        id: string,
        props: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
      ) {
        const name = yield* createWorkerName(id, props.name);
        const workerBindings: WorkerBinding[] = [];
        const durableObjectNamespaces: Record<string, string> = {};
        for (const { sid, data } of bindings) {
          for (const binding of data.bindings ?? []) {
            workerBindings.push(binding);
            if (binding.type === "durable_object_namespace") {
              durableObjectNamespaces[binding.name] = sid;
            }
          }
        }
        for (const [key, value] of Object.entries(props.env ?? {})) {
          if (Redacted.isRedacted(value)) {
            workerBindings.push({
              type: "secret_text",
              name: key,
              text: Redacted.value(value),
            });
          } else {
            workerBindings.push({
              type: "plain_text",
              name: key,
              text: value,
            });
          }
        }
        const dons = Object.entries(durableObjectNamespaces).map(
          ([className, namespaceId]) => ({
            className,
            uniqueKey: namespaceId,
            sql: true,
          }),
        );
        const result = props.vite
          ? yield* sidecar.serveVite({
              id,
              name,
              rootDir: props.vite.rootDir ?? path.resolve(process.cwd()),
              compatibility: getCompatibility(props),
              bindings: workerBindings,
              durableObjectNamespaces: dons,
            })
          : yield* sidecar.serve({
              id,
              name,
              main: props.main,
              compatibility: getCompatibility(props),
              entry: props.isExternal
                ? { kind: "external" }
                : {
                    kind: "effect",
                    exports: (props.exports ?? {}) as any,
                  },
              stack: { name: stack.name, stage: stack.stage },
              bindings: workerBindings,
              durableObjectNamespaces: dons,
            });
        return {
          workerId: name,
          workerName: name,
          logpush: undefined,
          url: result.address,
          tags: [],
          durableObjectNamespaces,
          domains: [],
          accountId,
        } satisfies Worker["Attributes"];
      });

      return {
        diff: () => Effect.succeed({ action: "update" }),
        create: ({ id, news, bindings }) => run(id, news, bindings),
        update: ({ id, news, bindings }) => run(id, news, bindings),
        delete: ({ output }) => sidecar.stop(output.workerName),
      };
    }),
  );
