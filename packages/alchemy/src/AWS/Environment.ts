import * as Auth from "@distilled.cloud/aws/Auth";
import {
  fromAwsCredentialIdentity,
  type CredentialsError,
  type ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import type { AwsCredentialIdentity } from "@smithy/types";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, getProfile } from "../Auth/Profile.ts";
import {
  AWS_AUTH_PROVIDER_NAME,
  type AwsAuthConfig,
  type AwsResolvedCredentials,
} from "./AuthProvider.ts";

export const AWS_PROFILE = Config.string("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

export const AWS_REGION = Config.string("AWS_REGION");

export type AccountID = string;
export type RegionID = string;

export class FailedToGetAccount extends Data.TaggedError(
  "AWS::Environment::FailedToGetAccount",
)<{
  message: string;
  cause: Error;
}> {}

/**
 * Fully-resolved AWS environment for a stack. Mirrors `CloudflareEnvironment`:
 * one Context.Service that holds account, region, credentials, endpoint, and
 * (optionally) the SSO profile name.
 *
 * `credentials` is held as an Effect so callers can refresh on each access
 * (SSO sessions expire). The Effect itself is constructed once when this
 * service is built; resolving it lazily preserves @distilled.cloud/aws's
 * existing `Credentials` semantics.
 */
export interface AWSEnvironmentShape {
  accountId: AccountID;
  region: RegionID;
  credentials: Effect.Effect<ResolvedCredentials, CredentialsError>;
  endpoint?: string;
  profile?: string;
}

export class AWSEnvironment extends Context.Service<
  AWSEnvironment,
  AWSEnvironmentShape
>()("AWS::Environment") {}

/**
 * Build an `AWSEnvironment` for the active `ALCHEMY_PROFILE`. Driven by the
 * persisted {@link AwsAuthConfig} (`{ method: "env" | "stored" | "sso" }`)
 * recorded by `alchemy login --provider AWS --configure`.
 *
 * Falls back to the legacy `AWS_PROFILE`-based SSO loader if no Alchemy AWS
 * config is registered for the current profile (preserves the
 * "drop-in SSO without `alchemy login`" UX).
 */
export const Default = Layer.effect(
  AWSEnvironment,
  Effect.suspend(() => loadDefault()),
).pipe(Layer.orDie);

export const loadDefault = () =>
  Effect.gen(function* () {
    const fromAuth = yield* loadFromAuth().pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (fromAuth) return fromAuth;
    return yield* loadFromAwsProfile();
  });

const loadFromAuth = () =>
  Effect.gen(function* () {
    const profileName = yield* ALCHEMY_PROFILE;
    const auth = yield* getAuthProvider<AwsAuthConfig, AwsResolvedCredentials>(
      AWS_AUTH_PROVIDER_NAME,
    );
    const profile = yield* getProfile(profileName);
    const cfg = profile?.[AWS_AUTH_PROVIDER_NAME] as AwsAuthConfig | undefined;
    if (!cfg) return undefined;

    if (cfg.method === "sso") {
      return yield* loadFromSso(cfg.ssoProfile);
    }

    const resolved = yield* auth.read(profileName, cfg);
    const region = yield* resolveRegion(resolved.region);
    return {
      profile: profileName,
      accountId: cfg.accountId,
      region,
      credentials: Effect.succeed<ResolvedCredentials>({
        accessKeyId: resolved.accessKeyId,
        secretAccessKey: resolved.secretAccessKey,
        sessionToken: resolved.sessionToken,
      }),
    } satisfies AWSEnvironmentShape;
  });

const loadFromAwsProfile = () =>
  Effect.gen(function* () {
    const profileName = yield* AWS_PROFILE;
    return yield* loadFromSso(profileName);
  });

const loadFromSso = (ssoProfile: string) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Default;
    const profile = yield* auth.loadProfile(ssoProfile);
    if (!profile.sso_account_id) {
      return yield* Effect.die(
        `AWS SSO profile '${ssoProfile}' is missing sso_account_id`,
      );
    }
    const region = yield* resolveRegion(profile.region);
    return {
      profile: ssoProfile,
      accountId: profile.sso_account_id,
      region,
      credentials: auth.loadProfileCredentials(ssoProfile),
    } satisfies AWSEnvironmentShape;
  });

const resolveRegion = (preferred: string | undefined) =>
  preferred != null
    ? Effect.succeed(preferred)
    : AWS_REGION.pipe(
        Config.option,
        Config.map(Option.getOrElse(() => "us-east-1")),
      );

export interface AWSEnvironmentStaticInput {
  accountId: AccountID;
  region: RegionID;
  credentials: AwsCredentialIdentity;
  endpoint?: string;
  profile?: string;
}

const isStatic = (
  shape: AWSEnvironmentShape | AWSEnvironmentStaticInput,
): shape is AWSEnvironmentStaticInput =>
  shape.credentials != null &&
  typeof (shape.credentials as AwsCredentialIdentity).accessKeyId === "string";

/**
 * Build an `AWSEnvironment` Layer directly from values — useful for
 * static credentials in CI or tests.
 *
 * Named `makeEnvironment` rather than `of` because `Context.Service.of`
 * already exists with different semantics (builds the service value, not
 * a Layer); putting both on `AWSEnvironment` would be confusing.
 */
export const makeEnvironment = (
  shape: AWSEnvironmentShape | AWSEnvironmentStaticInput,
) =>
  Layer.succeed(
    AWSEnvironment,
    isStatic(shape)
      ? {
          ...shape,
          credentials: Effect.succeed(
            fromAwsCredentialIdentity(shape.credentials),
          ),
        }
      : shape,
  );
