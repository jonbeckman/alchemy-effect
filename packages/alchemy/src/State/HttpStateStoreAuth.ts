import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  retryOnce,
  writeCredentials,
  type ConfigureContext,
} from "../Auth/index.ts";
import * as Clank from "../Util/Clank.ts";

/**
 * Canonical name used to look up this provider in the `AuthProviders`
 * registry and in `~/.alchemy/credentials`.
 */
export const HTTP_STATE_STORE_AUTH_PROVIDER_NAME =
  "HttpStateStore" as const;

/** Filename used for stored credentials under the profile directory. */
const CREDENTIALS_FILE = "http-state-store";

/**
 * Persisted configuration. Today there is only one source — stored
 * credentials written by the interactive login flow.
 */
export type HttpStateStoreAuthConfig = { method: "stored" };

/**
 * Shape persisted under
 * `~/.alchemy/credentials/<profile>/http-state-store.json`.
 */
export interface HttpStateStoreStoredCredentials {
  /** Base URL of the state-store server. */
  url: string;
  /** Bearer token used to authenticate every request. */
  token: string;
  /** Project namespace to use for this profile. */
  project: string;
}

/**
 * Credentials produced by `read`. `token` is wrapped in `Redacted` so
 * it never shows up in logs or error formatting.
 */
export interface HttpStateStoreResolvedCredentials {
  url: string;
  token: Redacted.Redacted<string>;
  project: string;
  source: {
    type: HttpStateStoreAuthConfig["method"];
    details?: string;
  };
}

/**
 * Layer that registers the HTTP state-store auth provider into the
 * `AuthProviders` registry when built. Include this layer in any stack
 * that uses {@link HttpStateStore} so `alchemy login` can discover the
 * provider.
 *
 * The wire protocol is generic — any server that implements the HTTP
 * state-store contract (see `services/cloudflare-state-store` for a
 * Cloudflare Workers reference implementation) can be used.
 */
export const HttpStateStoreAuth = AuthProviderLayer<
  HttpStateStoreAuthConfig,
  HttpStateStoreResolvedCredentials
>()(HTTP_STATE_STORE_AUTH_PROVIDER_NAME, {
  configure: (profileName, ctx) => configureCredentials(profileName, ctx),
  login: (profileName) => login(profileName),
  logout: (profileName) => logout(profileName),
  prettyPrint: (profileName, config) => prettyPrint(profileName, config),
  read: (profileName) => resolveCredentials(profileName),
});

const resolveCredentials = (profileName: string) =>
  readCredentials<HttpStateStoreStoredCredentials>(
    profileName,
    CREDENTIALS_FILE,
  ).pipe(
    Effect.flatMap((creds) =>
      creds == null
        ? Effect.fail(
            new AuthError({
              message:
                "HTTP state store credentials not found. Run: alchemy-effect login --configure",
            }),
          )
        : Effect.succeed({
            url: creds.url,
            token: Redacted.make(creds.token),
            project: creds.project,
            source: { type: "stored" as const },
          } satisfies HttpStateStoreResolvedCredentials),
    ),
    Effect.mapError(
      (e) =>
        new AuthError({
          message: "failed to resolve HTTP state store credentials",
          cause: e,
        }),
    ),
  );

const login = (profileName: string) =>
  readCredentials<HttpStateStoreStoredCredentials>(
    profileName,
    CREDENTIALS_FILE,
  ).pipe(
    Effect.flatMap((creds) =>
      creds == null ? loginStored(profileName) : Effect.void,
    ),
    Effect.mapError(
      (e) => new AuthError({ message: "login failed", cause: e }),
    ),
    Effect.asVoid,
  );

const logout = (profileName: string) =>
  deleteCredentials(profileName, CREDENTIALS_FILE).pipe(
    Effect.andThen(
      Clank.success("HTTP state store: stored credentials removed"),
    ),
  );

const configureCredentials = (
  profileName: string,
  _ctx: ConfigureContext,
) =>
  loginStored(profileName).pipe(
    Effect.mapError(
      (e) =>
        new AuthError({
          message: "failed to configure credentials",
          cause: e,
        }),
    ),
  );

const loginStored = Effect.fnUntraced(function* (profileName: string) {
  const url = yield* Clank.text({
    message: "HTTP state store URL",
    placeholder: "https://…",
    validate: (v) =>
      v.length === 0
        ? "Required"
        : /^https?:\/\//.test(v)
          ? undefined
          : "Must start with http:// or https://",
  }).pipe(retryOnce);

  const token = yield* Clank.password({
    message: "HTTP state store bearer token",
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  }).pipe(retryOnce);

  const project = yield* Clank.text({
    message: "Project name (namespace under which state is stored)",
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  }).pipe(retryOnce);

  yield* writeCredentials<HttpStateStoreStoredCredentials>(
    profileName,
    CREDENTIALS_FILE,
    {
      url: url.replace(/\/+$/, ""),
      token,
      project,
    },
  );
  yield* Clank.success("HTTP state store: credentials saved.");

  return { method: "stored" as const };
});

const prettyPrint = (
  profileName: string,
  _config: HttpStateStoreAuthConfig,
) =>
  resolveCredentials(profileName).pipe(
    Effect.tap((creds) =>
      Effect.all([
        Console.log(`  url:     ${creds.url}`),
        Console.log(`  token:   ${displayRedacted(creds.token)}`),
        Console.log(`  project: ${creds.project}`),
        Console.log(`  source:  ${creds.source.type}`),
      ]),
    ),
    Effect.catch((e) =>
      Console.error(`  Failed to retrieve credentials: ${e}`),
    ),
  );
