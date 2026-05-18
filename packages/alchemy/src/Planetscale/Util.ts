import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const DEFAULT_MIGRATIONS_TABLE = "__alchemy_migrations";

/**
 * Tagged error raised when polling for a state predicate that has not yet
 * been reached. Used internally with `Effect.retry` to drive long-running
 * status waits.
 */
class NotReady extends Data.TaggedError("Planetscale::NotReady")<{
  description: string;
}> {}

/**
 * Tagged error raised by reconcilers when an immutable property of a live
 * PlanetScale resource does not match the desired configuration (e.g.
 * region, kind, parent_branch). User-recoverable: change the config to
 * match, or replace/delete the existing resource and retry.
 */
export class PlanetscaleConflict extends Data.TaggedError(
  "Planetscale::Conflict",
)<{
  message: string;
}> {}

/**
 * Default polling schedule: exponential backoff starting at 200ms, capped
 * at ~3 minutes total via `Schedule.recurs(60)`.
 */
const defaultSchedule = Schedule.exponential("200 millis").pipe(
  Schedule.both(Schedule.recurs(60)),
);

/**
 * Generic polling helper that retries until `predicate(value)` returns true
 * (or until the schedule is exhausted). Engine-specific helpers (e.g.
 * `waitForKeyspaceReady`, `waitForPendingPostgresChanges`) are built on top
 * of this primitive.
 */
export const pollUntil = <A, E, R>(
  description: string,
  fn: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  schedule: Schedule.Schedule<unknown, unknown, never> = defaultSchedule,
): Effect.Effect<A, E, R> =>
  fn.pipe(
    Effect.flatMap((value) =>
      predicate(value)
        ? Effect.succeed(value)
        : Effect.fail(new NotReady({ description })),
    ),
    Effect.retry({
      while: (e: any) => e?._tag === "Planetscale::NotReady",
      schedule,
    }),
  ) as Effect.Effect<A, E, R>;

/**
 * Polls a branch via `getBranch` until it reports `ready === true`. Returns
 * the final branch shape.
 */
export const waitForBranchReady = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
) {
  return yield* pollUntil(
    `branch "${branch}" ready`,
    ops.getBranch({ organization, database, branch }),
    (data) => data.ready,
  );
});

/**
 * Polls a database via `getDatabase` until it reports `ready === true`.
 */
export const waitForDatabaseReady = Effect.fn(function* (
  organization: string,
  database: string,
) {
  return yield* pollUntil(
    `database "${database}" ready`,
    ops.getDatabase({ organization, database }),
    (data) => data.ready,
  );
});

export const isKnownError =
  (tag: string, message: string) => (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === tag &&
    (error as { readonly message?: unknown }).message === message;

// todo: this repeats across Neon, D1, and PlanetScale resources so maybe we should move it to Diff? or Util?
export const recordsEqual = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};
