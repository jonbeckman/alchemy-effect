import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Pipeable } from "effect/Pipeable";
import type { Input } from "./Input.ts";
import type * as Output from "./Output/index.ts";
import type { Provider, ProviderService } from "./Provider.ts";

export type ResourceClassFn = (
  id: string,
  props?: any,
) => Effect.Effect<ResourceLike>;

export type ResourceClass<Fn extends ResourceClassFn = ResourceClassFn> = Fn & {
  readonly type: ResourceClass.Type<Fn>;
  readonly fn: Fn;
  new (): ResourceClass.Instance<Fn>;
  provider: {
    effect<
      Req = never,
      ReadReq = never,
      DiffReq = never,
      PrecreateReq = never,
      CreateReq = never,
      UpdateReq = never,
      DeleteReq = never,
    >(
      eff: Effect.Effect<
        ProviderService<
          Extract<Effect.Success<ReturnType<Fn>>, ResourceLike>,
          ReadReq,
          DiffReq,
          PrecreateReq,
          CreateReq,
          UpdateReq,
          DeleteReq
        >,
        never,
        Req
      >,
    ): Layer.Layer<
      Provider<Extract<Effect.Success<ReturnType<Fn>>, ResourceLike>>,
      never,
      Req | ReadReq | DiffReq | PrecreateReq | CreateReq | UpdateReq | DeleteReq
    >;
    of: <
      ReadReq = never,
      DiffReq = never,
      PrecreateReq = never,
      CreateReq = never,
      UpdateReq = never,
      DeleteReq = never,
    >(
      service: ProviderService<
        ResourceClass.Instance<Fn>,
        ReadReq,
        DiffReq,
        PrecreateReq,
        CreateReq,
        UpdateReq,
        DeleteReq
      >,
    ) => ProviderService<
      ResourceClass.Instance<Fn>,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq
    >;
  };
};

export declare namespace ResourceClass {
  export type Type<Fn extends ResourceClassFn> = Instance<Fn>["type"];
  export type Instance<Fn extends ResourceClassFn> = Extract<
    Effect.Success<ReturnType<Fn>>,
    ResourceLike
  >;
}

export const Resource = <Fn extends ResourceClassFn>(
  type: ResourceClass.Type<Fn>,
): ResourceClass<Fn> => {
  const fn = (id: string, props?: any) => undefined;

  return Object.assign(fn, {
    type,
    fn,
  }) as any as ResourceClass<Fn>;
};

export interface ResourceLike<
  Type extends string = any,
  Id extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = any,
> extends Pipeable {
  type: Type;
  id: Id;
  attr: Attributes;
  props: Props;
  binding: Binding;
}

export type Resource<
  Type extends string = any,
  Id extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = never,
> = ResourceLike<Type, Id, Props, Attributes, Binding> & {
  bind(binding: Input<Binding>): Effect.Effect<void>;
} & {
  [attr in keyof Attributes]: <Self extends ResourceLike>(
    this: Self,
  ) => Effect.Effect<Output.Output<Attributes[attr], Self, never>>;
};

export interface Attribute<Attr, Self extends any> extends Output.Output<
  // @ts-expect-error
  Self["attr"][Attr],
  // @ts-expect-error
  Self,
  never
> {
  readonly resource: Self;
  readonly attr: Attr;
}
