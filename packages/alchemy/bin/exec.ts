import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AlchemyContextLive } from "../src/AlchemyContext.ts";
import { inkCLI } from "../src/Cli/InkCLI.tsx";
import { PlatformServices, runMain } from "../src/Util/PlatformServices.ts";
import { execStack, ExecStackOptions } from "./commands/deploy.ts";

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  inkCLI(),
);

const options = Schema.decodeSync(ExecStackOptions)(
  JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
);

// Propagate the resolved profile to spawned subprocesses (e.g. the
// Cloudflare local-runtime sidecar) via env so they see the same
// profile selection. ConfigProvider's `withProfileOverride` only
// applies to this Effect runtime, not to children.
if (options.profile && !process.env.ALCHEMY_PROFILE) {
  process.env.ALCHEMY_PROFILE = options.profile;
}

execStack(options).pipe(Effect.provide(services), Effect.scoped, runMain);
