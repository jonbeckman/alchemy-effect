/**
 * Shared support for the factory-form of a Platform/Resource — a
 * default export of the shape `(args) => Worker(id, props, body)`.
 *
 * ```ts
 * export default Worker((scriptName: string) =>
 *   Worker("Api", { name: scriptName, main: import.meta.filename, ... }, body));
 * ```
 *
 * At deploy time, calling `yield* MyWorker(...args)` runs the inner
 * Effect and stamps `args` into `Props.env` under
 * {@link FACTORY_ARGS_KEY}, so the standard env-binding lifecycle
 * persists them as a `plain_text` binding on the deployed resource.
 * At runtime, the generated entrypoint detects the
 * {@link FACTORY_MARKER} marker on the imported default export,
 * JSON-decodes the args from `env`, and calls the factory before
 * treating the result as a Layer/Effect.
 *
 * v1 limitation: factory args must be JSON-serializable. `Output` /
 * `Redacted` args are not yet supported — they would need per-arg
 * bindings (so secrets can use `secret_text`) and a matching
 * marker-aware decode on the runtime side.
 */

import * as Effect from "effect/Effect";

export const FACTORY_ARGS_KEY = "__ALCHEMY_FACTORY_ARGS__";
export const FACTORY_MARKER = "__alchemyFactory" as const;

export const makeFactory = (
  fn: (...args: any[]) => Effect.Effect<any>,
): ((...args: any[]) => Effect.Effect<any>) & {
  readonly [FACTORY_MARKER]: true;
} => {
  const factory = (...args: any[]) =>
    Effect.gen(function* () {
      const resource = yield* fn(...args);
      if (resource && typeof resource === "object") {
        const props = (resource as any).Props ?? {};
        (resource as any).Props = {
          ...props,
          env: {
            ...(props.env ?? {}),
            [FACTORY_ARGS_KEY]: JSON.stringify(args),
          },
        };
      }
      return resource;
    });
  return Object.assign(factory, { [FACTORY_MARKER]: true as const });
};
