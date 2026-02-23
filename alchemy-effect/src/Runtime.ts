import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

export class Runtime extends ServiceMap.Service<Runtime, RuntimeService>()(
  "Alchemy::Runtime",
) {}

export type RuntimeService<Type extends string = string> =
  | EventRuntimeService<Type>
  | ProcessRuntimeService<Type>;

export interface BaseRuntimeService<Type extends string> {
  type: Type;
  /**
   * Get a value from the Runtime
   */
  get<T>(key: string): Effect.Effect<T>;
}

export interface EventRuntimeService<
  Type extends string,
> extends BaseRuntimeService<Type> {
  listen: <A, Req = never, InitReq = never>(
    effect: Effect.Effect<
      (event: any) => Effect.Effect<A, never, Req> | void,
      never,
      InitReq
    >,
  ) => Effect.Effect<A, never, Req | InitReq>;
  run?: never;
}

export interface ProcessRuntimeService<
  Type extends string,
> extends BaseRuntimeService<Type> {
  listen?: never;
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}
