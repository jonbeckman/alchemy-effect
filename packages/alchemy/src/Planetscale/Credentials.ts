import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  DEFAULT_API_BASE_URL,
  fromApiToken,
  fromOAuth,
  type OAuthConfig,
} from "@distilled.cloud/planetscale/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { CredentialsStore } from "../Auth/Credentials.ts";
import { ALCHEMY_PROFILE, Profile } from "../Auth/Profile.ts";
import {
  PLANETSCALE_AUTH_PROVIDER_NAME,
  type PlanetscaleAuthConfig,
  type PlanetscaleResolvedCredentials,
} from "./AuthProvider.ts";
import * as OAuthClient from "./OAuthClient.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/planetscale/Credentials";

/**
 * Build a PlanetScale `Credentials` Layer from an explicit service token.
 * Useful for tests or when the caller already has credentials in hand.
 *
 * @example
 * ```ts
 * Effect.provide(
 *   Planetscale.fromToken({
 *     tokenId: "abcd1234",
 *     token: "api-token-secret",
 *     organization: "my-org",
 *   }),
 * )
 * ```
 */
export const fromToken = (input: {
  tokenId: string | Redacted.Redacted<string>;
  token: string | Redacted.Redacted<string>;
  organization: string;
  apiBaseUrl?: string;
}) =>
  fromApiToken({
    tokenId:
      typeof input.tokenId === "string"
        ? input.tokenId
        : Redacted.value(input.tokenId),
    token:
      typeof input.token === "string"
        ? input.token
        : Redacted.value(input.token),
    organization: input.organization,
    apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
  });

const toOAuthConfig = (
  creds: OAuthClient.OAuthCredentials,
  organization: string,
): OAuthConfig => ({
  accessToken: creds.access,
  refreshToken: creds.refresh,
  expiresAt: creds.expires,
  organization,
});

/**
 * Build a PlanetScale `Credentials` Layer that resolves credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * For OAuth profiles, delegates to {@link fromOAuth} so the distilled SDK
 * can refresh the access token transparently on every API call. For
 * service-token profiles (env/stored), delegates to {@link fromApiToken}.
 */
export const fromAuthProvider = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<
        PlanetscaleAuthConfig,
        PlanetscaleResolvedCredentials
      >(PLANETSCALE_AUTH_PROVIDER_NAME);
      const store = yield* CredentialsStore;
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const apiBaseUrl = yield* Config.string("PLANETSCALE_API_BASE_URL").pipe(
        Config.withDefault(DEFAULT_API_BASE_URL),
      );

      const config = (yield* profile.loadOrConfigure(auth, profileName, {
        ci,
      })) as PlanetscaleAuthConfig;

      return Match.value(config).pipe(
        Match.when({ method: "oauth" }, (cfg) =>
          fromOAuth({
            apiBaseUrl,
            load: store
              .read<OAuthClient.OAuthCredentials>(
                profileName,
                "planetscale-oauth",
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null || creds.type !== "oauth"
                    ? Effect.fail(
                        new ConfigError({
                          message:
                            "Planetscale OAuth credentials not found. Run: alchemy login",
                        }),
                      )
                    : Effect.succeed(toOAuthConfig(creds, cfg.organization)),
                ),
              ),
            refresh: (current) =>
              OAuthClient.refresh({
                type: "oauth",
                access: current.accessToken,
                refresh: current.refreshToken ?? "",
                expires: current.expiresAt ?? 0,
                scopes: cfg.scopes,
              }).pipe(
                Effect.tap((refreshed) =>
                  store.write(profileName, "planetscale-oauth", refreshed),
                ),
                Effect.map((refreshed) =>
                  toOAuthConfig(refreshed, cfg.organization),
                ),
              ),
          }),
        ),
        Match.orElse(() =>
          Layer.unwrap(
            auth.read(profileName, config).pipe(
              Effect.map((resolved) => {
                if (resolved.type !== "apiToken") {
                  // The non-oauth branch only resolves apiToken-shaped creds.
                  return Layer.empty as Layer.Layer<Credentials>;
                }
                return fromApiToken({
                  tokenId: Redacted.value(resolved.tokenId),
                  token: Redacted.value(resolved.token),
                  organization: resolved.organization,
                  apiBaseUrl,
                });
              }),
              Effect.mapError(
                (e) =>
                  new ConfigError({
                    message: `Failed to resolve Planetscale credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
                  }),
              ),
            ),
          ),
        ),
      );
    }),
  );
