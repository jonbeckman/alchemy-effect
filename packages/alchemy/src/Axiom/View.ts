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

export type ViewProps = Axiom.CreateViewInput;

export type View = Resource<
  "Axiom.View",
  ViewProps,
  Axiom.CreateViewOutput & {
    /**
     * Path identifier used by `updateView` / `getView` / `deleteView`.
     * Currently derived from `name` because Axiom's view list/get responses
     * don't expose a separate id field.
     */
    id: string;
  },
  never,
  Providers
>;

/**
 * An Axiom saved view — a named, shareable APL query. Useful for building
 * starter dashboards, providing canned "open in Axiom" links from your app,
 * or pinning common investigations the team revisits.
 *
 * The path identifier is `name`. Renaming a view triggers a replacement
 * (the old one is deleted, a new one is created).
 *
 * @see https://axiom.co/docs/query-data/datasets — APL query reference
 *
 * @section Creating a View
 * @example Recent errors across one dataset
 * ```typescript
 * yield* Axiom.View("recent-errors", {
 *   name: "recent-errors",
 *   description: "Last 100 5xx responses",
 *   datasets: ["my-app-traces"],
 *   aplQuery: `
 *     ['my-app-traces']
 *     | where status >= 500
 *     | order by _time desc
 *     | take 100
 *   `,
 * });
 * ```
 *
 * @example Cross-dataset join (logs + traces by trace_id)
 * ```typescript
 * yield* Axiom.View("trace-with-logs", {
 *   name: "trace-with-logs",
 *   datasets: ["my-app-traces", "my-app-logs"],
 *   aplQuery: `
 *     ['my-app-traces']
 *     | where duration_ms > 1000
 *     | join kind=leftouter (['my-app-logs']) on trace_id
 *   `,
 * });
 * ```
 */
export const View = Resource<View>("Axiom.View");

export const ViewProvider = () =>
  Provider.effect(
    View,
    Effect.gen(function* () {
      const create = yield* Axiom.createView;
      const update = yield* Axiom.updateView;
      const get = yield* Axiom.getView;
      const del = yield* Axiom.deleteView;

      return {
        stables: ["id"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.name !== output.name) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const marker = buildMarker(stack.name, stage, id);
          const desiredDescription = augmentDescription(
            news.description,
            marker,
          );
          const desired = { ...news, description: desiredDescription };

          // Observe — `name` is the path identifier for views. Renames are
          // forced to a replacement by `diff` above, so the cached
          // `output.id` (set to `news.name` on first create) and the
          // current `news.name` always agree by the time we land here.
          const viewId = output?.id ?? news.name;
          const observed = yield* get({ id: viewId }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );

          // Ensure — POST creates the view under `news.name`. Axiom's
          // `createView` declares `UnprocessableEntity` for name reuse;
          // 409s fall through `HTTP_STATUS_MAP` to `Conflict` (typed) or
          // `UnknownAxiomError` (fallback). On any of those, re-observe
          // and either update if we own it or surface the foreign-owner
          // error so the engine's adoption gate fires.
          if (observed === undefined) {
            const result = yield* create(desired).pipe(
              Effect.catch((e: { readonly _tag?: string }) => {
                const tag = e._tag;
                if (
                  tag === "UnprocessableEntity" ||
                  tag === "Conflict" ||
                  tag === "UnknownAxiomError"
                ) {
                  return Effect.gen(function* () {
                    const existing = yield* get({ id: news.name }).pipe(
                      Effect.catchTag("NotFound", () =>
                        Effect.succeed(undefined),
                      ),
                    );
                    if (existing === undefined) {
                      return yield* Effect.fail(e);
                    }
                    const ownership = parseMarker(existing.description);
                    const isOurs =
                      ownership === undefined ||
                      (ownership.stack === stack.name &&
                        ownership.stage === stage &&
                        ownership.id === id);
                    if (!isOurs) {
                      return yield* Effect.fail(e);
                    }
                    return yield* update({ ...desired, id: news.name });
                  });
                }
                return Effect.fail(e);
              }),
            );
            return { ...result, id: news.name };
          }

          // Sync — the view exists; PUT against its id with the desired
          // props. If the view disappeared mid-reconcile, recreate.
          const result = yield* update({ ...desired, id: viewId }).pipe(
            Effect.catchTag("NotFound", () => create(desired)),
          );
          return { ...result, id: viewId };
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
          const attrs = { ...existing, id: output.id };
          return isOurs ? attrs : Unowned(attrs);
        }),
      };
    }),
  );
