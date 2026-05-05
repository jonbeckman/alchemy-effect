import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import type { Providers } from "./Providers.ts";

const MARKER_RE = /\s*\[alchemy:stack=([^;]+);stage=([^;]+);id=([^\]]+)\]\s*$/;

const buildMarker = (stack: string, stage: string, id: string) =>
  `[alchemy:stack=${stack};stage=${stage};id=${id}]`;

const stripMarker = (description: string | undefined) =>
  (description ?? "").replace(MARKER_RE, "").trimEnd();

const augmentDescription = (
  description: string | undefined,
  marker: string,
) => {
  const base = stripMarker(description);
  return base.length > 0 ? `${base}\n${marker}` : marker;
};

const parseMarker = (
  description: string | undefined,
): { stack: string; stage: string; id: string } | undefined => {
  if (!description) return undefined;
  const m = description.match(MARKER_RE);
  if (!m) return undefined;
  return { stack: m[1], stage: m[2], id: m[3] };
};

export type VirtualFieldProps = Axiom.CreateVirtualFieldInput;

export type VirtualField = Resource<
  "Axiom.VirtualField",
  VirtualFieldProps,
  Axiom.CreateVirtualFieldOutput,
  never,
  Providers
>;

/**
 * An Axiom virtual field — a saved APL expression that appears as a derived
 * column on a dataset at query time. Use these to standardise common
 * computations (status classes, latency buckets, parsed JSON paths) so
 * dashboards and monitors don't have to redefine them.
 *
 * Bound to a single `dataset`; changing the dataset triggers a replacement.
 *
 * @see https://axiom.co/docs/query-data/virtual-fields
 *
 * @section Creating a Virtual Field
 * @example HTTP status class (e.g. 200 → "2xx")
 * ```typescript
 * yield* Axiom.VirtualField("status-class", {
 *   dataset: "my-app-traces",
 *   name: "status_class",
 *   description: "HTTP response class bucket",
 *   expression: 'strcat(tostring(toint(status / 100)), "xx")',
 *   type: "string",
 * });
 * ```
 *
 * @example Latency bucket in seconds
 * ```typescript
 * yield* Axiom.VirtualField("latency-bucket", {
 *   dataset: "my-app-traces",
 *   name: "latency_bucket_s",
 *   expression: "bin(duration_ms / 1000.0, 0.5)",
 *   type: "number",
 *   unit: "s",
 * });
 * ```
 */
export const VirtualField = Resource<VirtualField>("Axiom.VirtualField");

export const VirtualFieldProvider = () =>
  Provider.effect(
    VirtualField,
    Effect.gen(function* () {
      const create = yield* Axiom.createVirtualField;
      const update = yield* Axiom.updateVirtualField;
      const get = yield* Axiom.getVirtualField;
      const del = yield* Axiom.deleteVirtualField;

      return {
        stables: ["id"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.dataset !== output.dataset) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const marker = buildMarker(stack.name, stage, id);
          const desired = {
            ...news,
            description: augmentDescription(news.description, marker),
          };

          // Observe — Axiom assigns the virtual-field id server-side, so
          // the only handle to a previously-created field is the cached
          // `output.id`. Probe for live state with that id; treat NotFound
          // (deleted out-of-band) as "no observed state" so we converge by
          // re-creating.
          const observed = output?.id
            ? yield* get({ id: output.id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;

          // Ensure — POST mints a new virtual field with a fresh id.
          if (observed === undefined) {
            return yield* create(desired);
          }

          // Sync — the field exists; PUT against its id with the desired
          // props. `dataset` is replacement-only (handled in diff). If the
          // field disappeared between observe and update, recreate.
          return yield* update({ ...desired, id: observed.id }).pipe(
            Effect.catchTag("NotFound", () => create(desired)),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (!output?.id) return undefined;
          const stack = yield* Stack;
          const stage = yield* Stage;
          const existing = yield* get({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!existing) return undefined;
          const ownership = parseMarker(existing.description);
          const isOurs =
            ownership !== undefined &&
            ownership.stack === stack.name &&
            ownership.stage === stage &&
            ownership.id === id;
          return isOurs ? existing : Unowned(existing);
        }),
      };
    }),
  );
