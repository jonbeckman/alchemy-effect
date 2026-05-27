import * as ops from "@distilled.cloud/planetscale/Operations";
import {
  Credentials as PsCredentials,
  fromOAuth,
} from "@distilled.cloud/planetscale/Credentials";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import {
  getEnvRedactedRequired,
  getEnvRequired,
  retryOnce,
} from "../Auth/Env.ts";
import * as Clank from "../Util/Clank.ts";
import * as OAuthClient from "./OAuthClient.ts";

/**
 * Canonical name registered in {@link AuthProviders}. Use this key to look
 * up the PlanetScale {@link AuthProvider} from inside provider Layers.
 */
export const PLANETSCALE_AUTH_PROVIDER_NAME = "Planetscale";

const options: Array<{
  value: PlanetscaleAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "oauth",
    label: "OAuth",
    hint: "recommended — device-flow login with automatic token refresh",
  },
  {
    value: "env",
    label: "Environment Variables",
    hint: "PLANETSCALE_API_TOKEN_ID + PLANETSCALE_API_TOKEN + PLANETSCALE_ORGANIZATION",
  },
  {
    value: "stored",
    label: "Service Token",
    hint: "enter service token interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Auth configuration persisted in `~/.alchemy/profiles.json` for the
 * PlanetScale provider.
 *
 * - `oauth`: PlanetScale OAuth device flow. Access and refresh tokens are
 *   stored in `~/.alchemy/credentials/<profile>/planetscale-oauth.json` and
 *   refreshed automatically on use.
 * - `env`: read credentials from environment variables at resolution time.
 * - `stored`: read service-token credentials from
 *   `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 */
export type PlanetscaleAuthConfig =
  | { method: "env" }
  | { method: "stored" }
  | { method: "oauth"; scopes: string[]; organization: string };

/**
 * Service-token credentials persisted to disk for `method: "stored"`.
 * Stored under the file key `"planetscale-stored"`.
 */
export interface PlanetscaleStoredCredentials {
  type: "apiToken";
  tokenId: string;
  token: string;
  organization: string;
}

/**
 * Resolved in-memory PlanetScale credentials returned by
 * {@link AuthProviderImpl.read}.
 */
export type PlanetscaleResolvedCredentials =
  | {
      type: "apiToken";
      tokenId: Redacted.Redacted<string>;
      token: Redacted.Redacted<string>;
      organization: string;
      source: {
        type: PlanetscaleAuthConfig["method"];
        details?: string;
      };
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      scopes: string[];
      organization: string;
      source: {
        type: PlanetscaleAuthConfig["method"];
        details?: string;
      };
    };

/**
 * Scopes alchemy requests by default. Cover the typical alchemy-managed
 * resources: databases, branches, branch passwords, and postgres roles.
 *
 * @see https://planetscale.com/docs/api/reference/oauth-access-scopes
 */
export const DEFAULT_SCOPES = [
  "read_user",
  "read_organization",
  "read_organizations",
  "read_databases",
  "create_databases",
  "write_databases",
  "delete_databases",
  "read_branches",
  "write_branches",
  "delete_branches",
  "promote_branches",
  "delete_production_branches",
  "manage_passwords",
  "manage_production_branch_passwords",
];

/**
 * Full set of OAuth scopes recognized by PlanetScale, grouped by what they
 * grant access to. Used as the option list when the user customizes scopes
 * during `alchemy login`.
 */
export const ALL_SCOPES: Record<string, string> = {
  read_user: "Read user info",
  write_user: "Write user info",
  read_organizations: "List a user's organizations",
  read_organization: "Read organization",
  write_organization: "Write organization",
  delete_organization: "Delete organization",
  read_invoices: "Read organization invoices",
  read_members: "Read organization members",
  write_members: "Write organization members",
  delete_members: "Delete organization members",
  read_databases: "Read databases",
  create_databases: "Create databases",
  write_databases: "Write databases",
  delete_databases: "Delete databases",
  read_branches: "Read database branches",
  write_branches: "Write database branches",
  delete_branches: "Delete database branches",
  promote_branches: "Promote database branches",
  delete_production_branches: "Delete production branches",
  manage_passwords: "Read, write, and delete branch passwords",
  manage_production_branch_passwords:
    "Read, write, and delete production branch passwords",
  read_deploy_requests: "Read deploy requests",
  write_deploy_requests: "Create and update deploy requests",
  deploy_deploy_requests: "Deploy deploy requests",
  approve_deploy_requests: "Approve deploy requests",
  read_comments: "Read deploy request comments",
  write_comments: "Create deploy request comments",
  read_backups: "Read backups",
  write_backups: "Create and update backups",
  delete_backups: "Delete backups",
  delete_production_branch_backups: "Delete production backups",
  restore_backups: "Restore backups to new branches",
  restore_production_branch_backups:
    "Restore production branch backups to new branches",
};

/**
 * Build a one-off PlanetScale Credentials + HttpClient layer wrapping an
 * OAuth access token. Used by `configureOAuth` to list the user's
 * organizations after the device-flow login.
 */
const withOAuthCredentials = <A, E>(
  accessToken: string,
  effect: Effect.Effect<A, E, PsCredentials | HttpClient.HttpClient>,
): Effect.Effect<A, E> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      fromOAuth({
        load: Effect.succeed({
          accessToken,
          organization: "",
        }),
        refresh: () =>
          Effect.die("refresh not expected during organization selection"),
      }),
      FetchHttpClient.layer,
    ),
  );

const selectOrganization = (accessToken: string) =>
  Effect.gen(function* () {
    const list = yield* ops.listOrganizations;
    const response = yield* list({});
    const orgs = response.data;
    if (orgs.length === 0) {
      yield* new AuthError({
        message: "Planetscale: no organizations found for this account.",
      });
    }
    if (orgs.length === 1) {
      const org = orgs[0]!;
      yield* Clank.info(`Planetscale: using organization: ${org.name}`);
      return org.name;
    }
    return yield* Clank.select({
      message: "Select a Planetscale organization",
      options: orgs.map((o) => ({
        value: o.name,
        label: o.name,
        hint: o.plan,
      })),
    }).pipe(retryOnce);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

const promptOAuthScopes = () =>
  Clank.confirm({
    message: "Customize OAuth scopes? (default covers typical use cases)",
    initialValue: false,
  }).pipe(
    retryOnce,
    Effect.flatMap((customize) => {
      if (!customize) return Effect.succeed([...DEFAULT_SCOPES]);
      return Clank.multiselect({
        message: "Select OAuth scopes",
        initialValues: DEFAULT_SCOPES as string[],
        options: Object.entries(ALL_SCOPES).map(([value, hint]) => ({
          value: value as string,
          label: value,
          hint,
        })),
        required: true,
      }).pipe(
        Effect.map((s) => s as string[]),
        retryOnce,
      );
    }),
  );

/**
 * Layer that registers the PlanetScale {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the
 * PlanetScale `providers()` layer so `alchemy login` can discover it.
 *
 * Supported methods:
 * - `oauth`: device-flow login. Opens the verification URL in a browser
 *   and polls until the user authorizes. Access tokens refresh on use.
 * - `env`: reads `PLANETSCALE_API_TOKEN_ID`/`PLANETSCALE_API_TOKEN`/`PLANETSCALE_ORGANIZATION`.
 * - `stored`: prompts for a service token interactively and writes it to
 *   `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 */
export const PlanetscaleAuth = AuthProviderLayer<
  PlanetscaleAuthConfig,
  PlanetscaleResolvedCredentials
>()(
  PLANETSCALE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const oauthLogin = (profileName: string, scopes: string[]) =>
      Effect.gen(function* () {
        const verification = yield* OAuthClient.requestDevice(scopes);

        yield* Clank.info(
          `Planetscale: open ${verification.verificationUri} and enter the code:`,
        );
        yield* Clank.info(`  ${verification.userCode}`);
        const target =
          verification.verificationUriComplete ?? verification.verificationUri;
        yield* Clank.openUrl(target).pipe(
          Effect.catch(() =>
            Clank.warn(
              "Planetscale: could not open browser automatically. Please open the URL above manually.",
            ),
          ),
        );
        yield* Clank.info(
          `Planetscale: waiting for authorization (up to ${Duration.format(Duration.seconds(verification.expiresIn))})...`,
        );

        const credentials = yield* OAuthClient.pollForToken(verification);
        yield* store.write(profileName, "planetscale-oauth", credentials);
        yield* Clank.success("Planetscale: OAuth credentials saved.");
        return credentials;
      });

    const loginStored = Effect.fnUntraced(function* (profileName: string) {
      const tokenId = yield* Clank.text({
        message: "Planetscale Service Token ID",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const token = yield* Clank.password({
        message: "Planetscale Service Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const organization = yield* Clank.text({
        message: "Planetscale Organization (URL slug)",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      yield* store.write<PlanetscaleStoredCredentials>(
        profileName,
        "planetscale-stored",
        {
          type: "apiToken",
          tokenId,
          token,
          organization,
        },
      );
      yield* Clank.success("Planetscale: credentials saved.");
      return { method: "stored" as const };
    });

    const configureOAuth = Effect.fnUntraced(function* (profileName: string) {
      const scopes = yield* promptOAuthScopes();

      const oauthCreds = yield* oauthLogin(profileName, scopes);

      const organization = yield* selectOrganization(oauthCreds.access).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "Planetscale: could not list organizations",
              cause: e,
            }),
        ),
      );

      return {
        method: "oauth" as const,
        scopes,
        organization,
      };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Planetscale authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("oauth", () => configureOAuth(profileName)),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
        }
        return yield* configureInteractive(profileName);
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: PlanetscaleAuthConfig,
    ): Effect.Effect<PlanetscaleResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fnUntraced(function* () {
            const tokenId = yield* getEnvRedactedRequired(
              "PLANETSCALE_API_TOKEN_ID",
            );
            const token = yield* getEnvRedactedRequired(
              "PLANETSCALE_API_TOKEN",
            );
            const organization = yield* getEnvRequired(
              "PLANETSCALE_ORGANIZATION",
            );

            return {
              type: "apiToken" as const,
              tokenId,
              token,
              organization,
              source: {
                type: "env" as const,
                details: "PLANETSCALE_API_TOKEN_ID/PLANETSCALE_API_TOKEN",
              },
            } satisfies PlanetscaleResolvedCredentials;
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .read<PlanetscaleStoredCredentials>(
              profileName,
              "planetscale-stored",
            )
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "Planetscale stored credentials not found. Run: alchemy login --configure",
                      }),
                    )
                  : Effect.succeed({
                      type: "apiToken" as const,
                      tokenId: Redacted.make(creds.tokenId),
                      token: Redacted.make(creds.token),
                      organization: creds.organization,
                      source: {
                        type: "stored" as const,
                        details: undefined,
                      },
                    } satisfies PlanetscaleResolvedCredentials),
              ),
            ),
        ),
        Match.when({ method: "oauth" }, (cfg) =>
          Effect.gen(function* () {
            const creds = yield* store.read<OAuthClient.OAuthCredentials>(
              profileName,
              "planetscale-oauth",
            );
            if (creds == null || creds.type !== "oauth") {
              return yield* Effect.fail(
                new AuthError({
                  message:
                    "Planetscale OAuth credentials not found. Run: alchemy login",
                }),
              );
            }
            // Refresh proactively if the token has expired (or is within
            // 10s of expiring). Persist the refreshed creds so subsequent
            // resolves don't repeat the round-trip.
            const fresh =
              creds.expires > Date.now() + 10_000
                ? creds
                : yield* OAuthClient.refresh(creds).pipe(
                    Effect.tap((refreshed) =>
                      store.write(profileName, "planetscale-oauth", refreshed),
                    ),
                    Effect.mapError(
                      (e) =>
                        new AuthError({
                          message:
                            "Planetscale OAuth refresh failed. Run: alchemy login",
                          cause: e,
                        }),
                    ),
                  );
            return {
              type: "oauth" as const,
              accessToken: Redacted.make(fresh.access),
              expires: fresh.expires,
              scopes: fresh.scopes,
              organization: cfg.organization,
              source: { type: "oauth" as const },
            } satisfies PlanetscaleResolvedCredentials;
          }),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: PlanetscaleAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, "planetscale-stored")
            .pipe(
              Effect.andThen(
                Clank.success("Planetscale: stored credentials removed"),
              ),
            ),
        ),
        Match.when({ method: "oauth" }, () =>
          store
            .read<OAuthClient.OAuthCredentials>(
              profileName,
              "planetscale-oauth",
            )
            .pipe(
              Effect.tap((creds) =>
                creds?.type === "oauth"
                  ? OAuthClient.revoke(creds).pipe(
                      Effect.catchTag("OAuthError", (err) =>
                        Clank.warn(
                          `Planetscale: could not revoke OAuth token: ${err.errorDescription}`,
                        ),
                      ),
                    )
                  : Effect.void,
              ),
              Effect.andThen(store.delete(profileName, "planetscale-oauth")),
              Effect.andThen(
                Clank.success("Planetscale: OAuth credentials removed."),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: PlanetscaleAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .read<PlanetscaleStoredCredentials>(
                profileName,
                "planetscale-stored",
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.when({ method: "oauth" }, (c) =>
            Effect.gen(function* () {
              const creds = yield* store.read<OAuthClient.OAuthCredentials>(
                profileName,
                "planetscale-oauth",
              );

              if (creds?.type === "oauth") {
                yield* Clank.info(
                  "Planetscale: refreshing OAuth credentials...",
                );
                yield* OAuthClient.refresh(creds).pipe(
                  Effect.flatMap((refreshed) =>
                    store
                      .write(profileName, "planetscale-oauth", refreshed)
                      .pipe(
                        Effect.andThen(
                          Clank.success(
                            "Planetscale: OAuth credentials refreshed.",
                          ),
                        ),
                      ),
                  ),
                  Effect.catchTag("OAuthError", () =>
                    oauthLogin(profileName, c.scopes).pipe(Effect.asVoid),
                  ),
                );
                return;
              }

              yield* oauthLogin(profileName, c.scopes);
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const prettyPrint = (profileName: string, config: PlanetscaleAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) =>
              Effect.all([
                Console.log(`  tokenId: ${displayRedacted(c.tokenId, 3)}`),
                Console.log(`  token: ${displayRedacted(c.token, 6)}`),
                Console.log(`  organization: ${c.organization}`),
                Console.log(`  source: ${sourceStr}`),
              ]),
            ),
            Match.when({ type: "oauth" }, (c) => {
              const remainingMs = c.expires - Date.now();
              const expiresAt = new Date(c.expires).toISOString();
              const expiresStr =
                remainingMs <= 0
                  ? `expired (${expiresAt})`
                  : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
              return Effect.all([
                Console.log(`  accessToken: ${displayRedacted(c.accessToken)}`),
                Console.log(`  expires: ${expiresStr}`),
                Console.log(`  scopes: ${c.scopes.join(", ")}`),
                Console.log(`  organization: ${c.organization}`),
                Console.log(`  source: ${sourceStr}`),
              ]);
            }),
            Match.exhaustive,
          );
        }),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
      );

    return {
      configure: configureCredentials,
      logout,
      login,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);
