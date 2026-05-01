import * as RuntimeServices from "@distilled.cloud/cloudflare-runtime/RuntimeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as AlchemyContext from "../../AlchemyContext.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { LockError } from "../../Sidecar/Lock.ts";
import * as RpcServer from "../../Sidecar/RpcServer.ts";
import {
  httpServer,
  PlatformServices,
  runMain,
} from "../../Util/PlatformServices.ts";
import { CloudflareAuth } from "../Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import * as Credentials from "../Credentials.ts";
import { Sidecar, SidecarSchema } from "./Sidecar.ts";
import { SidecarHandlers } from "./SidecarHandlers.ts";

const apiServices = Layer.merge(
  Credentials.fromAuthProvider(),
  CloudflareEnvironment.fromProfile(),
).pipe(
  Layer.provide(CloudflareAuth),
  Layer.provide(Layer.succeed(AuthProviders, {})),
);

const runtimeServices = SidecarHandlers.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const { accountId } =
          yield* CloudflareEnvironment.CloudflareEnvironment;
        const { dotAlchemy } = yield* AlchemyContext.AlchemyContext;
        const path = yield* Path.Path;
        return RuntimeServices.layer({
          accountId,
          storage: path.join(dotAlchemy, "local"),
        });
      }),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(apiServices, FetchHttpClient.layer, httpServer()),
  ),
);

const services = Layer.provideMerge(
  Layer.provideMerge(runtimeServices, RpcServer.layerServices(import.meta.url)),
  PlatformServices,
);

RpcServer.makeRpcServer(Sidecar.asEffect(), SidecarSchema).pipe(
  // If another sidecar already holds the lock (typically a `bun --watch`
  // reload race during dev), exit silently with code 0. The parent RPC
  // client retries until the canonical sidecar's URL file appears, so a
  // failed loser process printing a stack trace would just be noise.
  Effect.catchIf(
    (e): e is LockError => e instanceof LockError && e.reason === "Conflict",
    () => Effect.sync(() => process.exit(0)),
  ),
  Effect.provide(services),
  Effect.scoped,
  runMain,
);
