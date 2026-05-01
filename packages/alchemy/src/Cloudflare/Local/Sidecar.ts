import {
  ServeError,
  type ServeResult,
} from "@distilled.cloud/cloudflare-runtime/Server";
import * as Worker from "@distilled.cloud/cloudflare-runtime/Worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BundleError } from "../../Bundle/Bundle.ts";
import * as RpcClient from "../../Sidecar/RpcClient.ts";
import { defineSchema } from "../../Sidecar/RpcHandler.ts";
import type { WorkerBinding } from "../Workers/Worker.ts";
import type { WorkerBundleOptions } from "../Workers/WorkerBundle.ts";
import { ViteDevError } from "./Vite/ViteDev.ts";
import { FrontProxyError } from "./Vite/FrontProxy.ts";

export interface ServeOptions extends WorkerBundleOptions {
  name: string;
  bindings: WorkerBinding[];
  durableObjectNamespaces: Worker.DurableObjectNamespace[];
}

export interface ServeViteOptions {
  /** Logical resource id (used in logs). */
  id: string;
  /** Worker name registered with LocalProxy. */
  name: string;
  /** Project root passed to Vite as `root`. */
  rootDir: string;
  compatibility: { date: string; flags: string[] };
  bindings: WorkerBinding[];
  durableObjectNamespaces: Worker.DurableObjectNamespace[];
}

export const SidecarSchema = defineSchema<Sidecar["Service"]>({
  serve: {
    success: Schema.Struct({
      name: Schema.String,
      address: Schema.String,
    }),
    error: Schema.Union([ServeError, BundleError]),
  },
  serveVite: {
    success: Schema.Struct({
      name: Schema.String,
      address: Schema.String,
    }),
    error: Schema.Union([ServeError, ViteDevError, FrontProxyError]),
  },
  stop: { success: Schema.Void, error: Schema.Never },
});

export class Sidecar extends RpcClient.RpcClientService<
  Sidecar,
  {
    readonly serve: (
      options: ServeOptions,
    ) => Effect.Effect<ServeResult, ServeError | BundleError>;
    readonly serveVite: (
      options: ServeViteOptions,
    ) => Effect.Effect<ServeResult, ServeError | ViteDevError | FrontProxyError>;
    readonly stop: (name: string) => Effect.Effect<void>;
  }
>()("Sidecar") {}

export const SidecarLive = RpcClient.layer(Sidecar, {
  main: import.meta.resolve("./SidecarServer.ts", import.meta.url),
  schema: SidecarSchema,
});
