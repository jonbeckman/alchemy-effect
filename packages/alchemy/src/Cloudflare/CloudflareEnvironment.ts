import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AuthError, getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, loadOrConfigure } from "../Auth/Profile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthProvider.ts";

class CloudflareEnvironmentService extends Context.Service<
  CloudflareEnvironmentService,
  Effect.Effect<CloudflareResolvedCredentials, AuthError, FileSystem.FileSystem>
>()("Cloudflare::CloudflareEnvironment") {}

export const CloudflareEnvironment: Effect.Effect<
  CloudflareResolvedCredentials,
  AuthError,
  CloudflareEnvironmentService | FileSystem.FileSystem
> = Effect.flatten(CloudflareEnvironmentService.asEffect());

/**
 * Type alias so the public name works as both a value (the Effect above)
 * and a service requirement: `Effect.Effect<A, E, CloudflareEnvironment>`.
 */
export type CloudflareEnvironment = CloudflareEnvironmentService;

const CLOUDFLARE_ACCOUNT_ID = Config.string("CLOUDFLARE_ACCOUNT_ID");

export const fromEnv = () =>
  Layer.succeed(
    CloudflareEnvironmentService,
    Effect.gen(function* () {
      const accountId = yield* CLOUDFLARE_ACCOUNT_ID.pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      );
      return { account: accountId } as any;
    }).pipe(
      Effect.mapError(
        (e) =>
          new AuthError({
            message: `Failed to resolve Cloudflare environment from CLOUDFLARE_ACCOUNT_ID: ${(e as { message?: string }).message ?? String(e)}`,
            cause: e,
          }),
      ),
    ),
  );

export const fromProfile = () =>
  Layer.effect(
    CloudflareEnvironmentService,
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<
        CloudflareAuthConfig,
        CloudflareResolvedCredentials
      >(CLOUDFLARE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const ctx = yield* Effect.context<never>();

      return loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as CloudflareAuthConfig),
        ),
        Effect.mapError((e) =>
          e instanceof AuthError
            ? e
            : new AuthError({
                message: `Failed to resolve Cloudflare credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
                cause: e,
              }),
        ),
        Effect.provide(ctx),
      );
    }),
  );
