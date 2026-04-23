import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ALCHEMY_PROFILE,
  AuthError,
  AuthProviderLayer,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  retryOnce,
  writeCredentials,
  type ConfigureContext,
} from "../Auth/index.ts";
import { CloudflareEnvironment } from "../Cloudflare/CloudflareEnvironment.ts";
import {
  createEdgeSession,
  EdgeSessionError,
} from "../Cloudflare/EdgeSession.ts";
import * as Clank from "../Util/Clank.ts";
import {
  HTTP_STATE_STORE_AUTH_PROVIDER_NAME,
  STATE_STORE_AUTH_TOKEN_SECRET_NAME,
  STATE_STORE_SCRIPT_NAME,
} from "./HttpStateStoreConstants.ts";

export {
  HTTP_STATE_STORE_AUTH_PROVIDER_NAME,
  STATE_STORE_AUTH_TOKEN_SECRET_NAME,
  STATE_STORE_SCRIPT_NAME,
};

/** Filename used for stored credentials under the profile directory. */
const CREDENTIALS_FILE = "http-state-store";

/** Preview script name used by the edge-probe worker. */
const PROBE_SCRIPT_NAME = "alchemy-state-store-probe";

/**
 * Tiny ES-module worker that reads `env.SECRET.get()` and echoes it
 * back. Uploaded as an ephemeral edge-preview, called once, then
 * discarded — see {@link readSecretViaEdge}.
 */
const SECRET_PROBE_SOURCE = `export default {
  async fetch(_request, env) {
    try {
      const value = await env.SECRET.get();
      return new Response(value ?? "", { status: 200, headers: { "content-type": "text/plain" } });
    } catch (e) {
      return new Response("Error: " + (e && e.message ? e.message : String(e)), { status: 500 });
    }
  },
};`;

/**
 * Persisted configuration. Selects the login strategy used to write
 * the credentials file — the credentials themselves always live at
 * `~/.alchemy/credentials/<profile>/http-state-store.json`.
 *
 * - `stored` — fully manual, user pastes URL and token.
 * - `cloudflare` — URL is derived from {@link STATE_STORE_SCRIPT_NAME}
 *   and the account's workers.dev subdomain; the token is fetched
 *   out-of-band via an edge-preview worker bound to
 *   {@link STATE_STORE_AUTH_TOKEN_SECRET_NAME} in the account's
 *   Secrets Store.
 */
export type HttpStateStoreAuthConfig =
  | { method: "stored" }
  | { method: "cloudflare" };

/**
 * Shape persisted under
 * `~/.alchemy/credentials/<profile>/http-state-store.json`.
 */
export interface HttpStateStoreStoredCredentials {
  /** Base URL of the state-store server. */
  url: string;
  /** Bearer token used to authenticate every request. */
  token: string;
}

/**
 * Credentials produced by `read`. `token` is wrapped in `Redacted` so
 * it never shows up in logs or error formatting.
 */
export interface HttpStateStoreResolvedCredentials {
  url: string;
  token: Redacted.Redacted<string>;
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
 * state-store contract can be used. The `cloudflare` login method is
 * a convenience for the Cloudflare reference deployment
 * (`services/cloudflare-state-store`) that avoids hand-pasting
 * credentials.
 */
export const HttpStateStoreAuth = AuthProviderLayer<
  HttpStateStoreAuthConfig,
  HttpStateStoreResolvedCredentials
>()(HTTP_STATE_STORE_AUTH_PROVIDER_NAME, {
  configure: (profileName, ctx) => configureCredentials(profileName, ctx),
  login: (profileName, config) => login(profileName, config),
  logout: (profileName) => logout(profileName),
  prettyPrint: (profileName, config) => prettyPrint(profileName, config),
  read: (profileName) => resolveCredentials(profileName),
});

// -- resolve ------------------------------------------------------

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

// -- login / logout / configure ------------------------------------

/**
 * `alchemy login` hook. Re-runs the chosen method so `cloudflare`
 * refreshes the token via edge-preview and `stored` re-prompts if
 * credentials have been cleared.
 */
const login = (profileName: string, config: HttpStateStoreAuthConfig) =>
  Match.value(config)
    .pipe(
      Match.when({ method: "stored" }, () =>
        readCredentials<HttpStateStoreStoredCredentials>(
          profileName,
          CREDENTIALS_FILE,
        ).pipe(
          Effect.flatMap((creds) =>
            creds == null ? loginStored(profileName) : Effect.void,
          ),
          Effect.asVoid,
        ),
      ),
      Match.when({ method: "cloudflare" }, () =>
        loginWithCloudflare().pipe(Effect.asVoid),
      ),
      Match.exhaustive,
    )
    .pipe(
      Effect.mapError(
        (e) => new AuthError({ message: "login failed", cause: e }),
      ),
    );

const logout = (profileName: string) =>
  deleteCredentials(profileName, CREDENTIALS_FILE).pipe(
    Effect.andThen(
      Clank.success("HTTP state store: stored credentials removed"),
    ),
  );

const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
  Effect.gen(function* () {
    if (ctx.ci) {
      // CI always uses `cloudflare` — token is fetched via the
      // edge-preview binding, but the project namespace must come
      // from somewhere non-interactive. We fail loudly here rather
      // than silently pick a name the user didn't choose.
      return yield* Effect.fail(
        new AuthError({
          message:
            "HTTP state store cannot be configured non-interactively yet. Run `alchemy login` once locally to persist credentials.",
        }),
      );
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

const configureInteractive = (profileName: string) =>
  Clank.select({
    message: "HTTP state store authentication method",
    options: [
      {
        value: "cloudflare" as const,
        label: "Cloudflare edge",
        hint: "fetch token via an edge-preview worker, derive URL from script name (recommended)",
      },
      {
        value: "stored" as const,
        label: "Stored",
        hint: "paste URL and token manually",
      },
    ],
  }).pipe(
    Effect.flatMap((method) =>
      Match.value(method).pipe(
        Match.when("stored", () => loginStored(profileName)),
        Match.when("cloudflare", () =>
          loginWithCloudflare().pipe(
            Effect.map(() => ({ method: "cloudflare" as const })),
          ),
        ),
        Match.exhaustive,
      ),
    ),
  );

// -- stored login --------------------------------------------------

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

  yield* writeCredentials<HttpStateStoreStoredCredentials>(
    profileName,
    CREDENTIALS_FILE,
    {
      url: url.replace(/\/+$/, ""),
      token,
    },
  );
  yield* Clank.success("HTTP state store: credentials saved.");

  return { method: "stored" as const };
});

// -- cloudflare login ---------------------------------------------

/**
 * Upload a tiny edge-preview worker that binds the given Secrets
 * Store secret, call it once, and return the decoded value. The
 * Cloudflare REST API deliberately hides secret values; only worker
 * bindings can resolve them, so this is the out-of-band path.
 */
const readSecretViaEdge = (storeId: string, secretName: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const file = new File([SECRET_PROBE_SOURCE], "worker.js", {
      type: "application/javascript+module",
    });
    const session = yield* createEdgeSession({
      scriptName: PROBE_SCRIPT_NAME,
      files: [file],
      bindings: [
        { type: "secrets_store_secret", name: "SECRET", secretName, storeId },
      ],
    });
    const response = yield* http.get(session.url, {
      headers: session.headers,
    });
    if (response.status !== 200) {
      const body = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      return yield* Effect.fail(
        new EdgeSessionError({
          message: `Secret probe returned ${response.status}: ${body.slice(0, 200)}`,
        }),
      );
    }
    return yield* response.text;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof EdgeSessionError
        ? cause
        : new EdgeSessionError({ message: "Failed to read secret", cause }),
    ),
  );

/**
 * Log in to a Cloudflare-deployed HTTP state-store.
 *
 * 1. Find the single account-wide Secrets Store.
 * 2. Upload a short-lived edge-preview worker that binds the
 *    auth-token secret and returns its value.
 * 3. Derive the state-store worker URL from
 *    {@link STATE_STORE_SCRIPT_NAME} and the account's workers.dev
 *    subdomain.
 * 4. Persist `{ url, token }` under the `http-state-store`
 *    credentials file.
 *
 * Requirements are covered by the Cloudflare provider stack —
 * `CloudflareEnvironment`, `Credentials`, `HttpClient`, and
 * `FileSystem`.
 */
export const loginWithCloudflare = () =>
  Effect.gen(function* () {
    const profileName = yield* ALCHEMY_PROFILE;
    const { accountId } = yield* CloudflareEnvironment;

    // 1. Locate the single Secrets Store on the account.
    const listStores = yield* secretsStore.listStores;
    const stores = yield* listStores({ accountId });
    const store = stores.result[0];
    if (!store) {
      return yield* Effect.fail(
        new AuthError({
          message:
            "No Secrets Store found on this account. Deploy the state store first.",
        }),
      );
    }

    // 2. Fetch the auth-token value via an edge-preview worker.
    const token = yield* readSecretViaEdge(
      store.id,
      STATE_STORE_AUTH_TOKEN_SECRET_NAME,
    );

    // 3. Derive the deployed worker URL.
    const getSubdomain = yield* workers.getSubdomain;
    const { subdomain } = yield* getSubdomain({ accountId });
    const url = `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`;

    // 4. Persist credentials. The profile entry is managed by
    //    `loadOrConfigure` when this is invoked through `configure`.
    yield* writeCredentials<HttpStateStoreStoredCredentials>(
      profileName,
      CREDENTIALS_FILE,
      { url, token: token.trim() },
    ).pipe(
      Effect.mapError(
        (e) =>
          new AuthError({ message: "Failed to write credentials", cause: e }),
      ),
    );

    yield* Clank.success(
      `HTTP state store credentials saved for '${profileName}'.`,
    );
    yield* Clank.info(`  url:     ${url}`);

    return { method: "cloudflare" as const };
  }).pipe(
    Effect.catchTag("EdgeSessionError", (e) =>
      Effect.fail(
        new AuthError({
          message: `Edge-preview secret read failed: ${e.message}`,
          cause: e.cause,
        }),
      ),
    ),
  );

// -- pretty print --------------------------------------------------

const prettyPrint = (profileName: string, _config: HttpStateStoreAuthConfig) =>
  resolveCredentials(profileName).pipe(
    Effect.tap((creds) =>
      Effect.all([
        Console.log(`  url:    ${creds.url}`),
        Console.log(`  token:  ${displayRedacted(creds.token)}`),
        Console.log(`  source: ${creds.source.type}`),
      ]),
    ),
    Effect.catch((e) =>
      Console.error(`  Failed to retrieve credentials: ${e}`),
    ),
  );
