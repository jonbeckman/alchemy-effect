import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import {
  ALCHEMY_PROFILE,
  AuthError,
  getProfile,
  setProfile,
  writeCredentials,
} from "alchemy/Auth";
import {
  CloudflareEnvironment,
  createEdgeSession,
  EdgeSessionError,
} from "alchemy/Cloudflare";
import {
  HTTP_STATE_STORE_AUTH_PROVIDER_NAME,
  type HttpStateStoreStoredCredentials,
} from "alchemy/State";
import * as Clank from "alchemy/Util/Clank";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  STATE_STORE_AUTH_TOKEN_SECRET_NAME,
  STATE_STORE_SCRIPT_NAME,
} from "./Constants.ts";

const CREDENTIALS_FILE = "http-state-store";
const PROBE_SCRIPT_NAME = "alchemy-state-store-probe";

/** ES-module worker that reads `env.SECRET.get()` and returns it. */
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
 * Upload a tiny edge-preview worker that binds the given Secrets
 * Store secret, call it once, and return the decoded value.
 *
 * This is the only supported way to read a Secrets Store value out
 * of band: the Cloudflare REST API deliberately hides secret values
 * and only worker bindings can resolve them.
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
    const response = yield* http.get(session.url, { headers: session.headers });
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

export interface LoginWithCloudflareOptions {
  /**
   * Project namespace written to the stored credentials. When omitted
   * the user is prompted interactively via Clank — pass an explicit
   * value from non-TTY contexts (tests, scripts).
   */
  readonly project?: string;
}

/**
 * Log in to a Cloudflare-deployed HTTP state-store by:
 *
 * 1. Finding the single account-wide Secrets Store.
 * 2. Uploading a short-lived edge-preview worker that binds the
 *    auth-token secret and returns its value on fetch.
 * 3. Deriving the state-store worker URL from the hardcoded script
 *    name: `https://alchemy-state-store.{subdomain}.workers.dev`.
 * 4. Resolving the project namespace (explicit arg, or interactive
 *    prompt if omitted).
 * 5. Writing `{ url, token, project }` under the
 *    `http-state-store` credentials file, the same shape
 *    `HttpStateStoreAuth` reads at deploy time.
 *
 * Requirements are covered by the Cloudflare provider stack (which
 * brings `CloudflareEnvironment`, `Credentials`, and `HttpClient`).
 */
export const loginWithCloudflare = (
  options: LoginWithCloudflareOptions = {},
) =>
  Effect.gen(function* () {
    const profileName = yield* ALCHEMY_PROFILE;
    const { accountId } = yield* CloudflareEnvironment;

    // 1. Locate the single Secrets Store on the account. The Secrets
    //    Store provider (`Cloudflare.SecretsStore`) is a per-account
    //    singleton, so taking the first result is safe.
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

    // 2. Spin up an edge-preview worker that reads the auth-token
    //    secret and returns it.
    const token = yield* readSecretViaEdge(
      store.id,
      STATE_STORE_AUTH_TOKEN_SECRET_NAME,
    );

    // 3. Derive the deployed worker URL from the hardcoded script name
    //    and the account's workers.dev subdomain.
    const getSubdomain = yield* workers.getSubdomain;
    const { subdomain } = yield* getSubdomain({ accountId });
    const url = `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`;

    // 4. Resolve the project namespace — explicit input wins, else
    //    prompt. Prompts cannot run under a non-TTY (tests, CI), so
    //    callers in those contexts must pass `project` explicitly.
    const project =
      options.project !== undefined
        ? options.project
        : yield* Clank.text({
            message:
              "Project name (namespace under which state is stored)",
            validate: (v) => (v.length === 0 ? "Required" : undefined),
          }).pipe(
            Effect.mapError(
              (e) =>
                new AuthError({
                  message: "Project prompt cancelled",
                  cause: e,
                }),
            ),
          );

    // 5. Persist the credentials file `HttpStateStoreAuth.read`
    //    uses at deploy time.
    yield* writeCredentials<HttpStateStoreStoredCredentials>(
      profileName,
      CREDENTIALS_FILE,
      { url, token: token.trim(), project },
    ).pipe(
      Effect.mapError(
        (e) =>
          new AuthError({ message: "Failed to write credentials", cause: e }),
      ),
    );

    // 6. Register the auth method in `~/.alchemy/profiles.json` so
    //    `loadOrConfigure` finds an existing config and doesn't
    //    fall through to `HttpStateStoreAuth.configure` (which
    //    would re-prompt for url/token/project). Merge into the
    //    existing profile so other providers' configs survive.
    const existing = yield* getProfile(profileName).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    yield* setProfile(profileName, {
      ...(existing ?? {}),
      [HTTP_STATE_STORE_AUTH_PROVIDER_NAME]: { method: "stored" },
    }).pipe(
      Effect.mapError(
        (e) =>
          new AuthError({
            message: "Failed to write profile entry",
            cause: e,
          }),
      ),
    );

    yield* Clank.success(
      `HTTP state store credentials saved for '${profileName}'.`,
    );
    yield* Clank.info(`  url:     ${url}`);
    yield* Clank.info(`  project: ${project}`);
  }).pipe(
    // Surface any edge-session failure as a tagged AuthError for
    // uniform downstream handling.
    Effect.catchTag("EdgeSessionError", (e) =>
      Effect.fail(
        new AuthError({
          message: `Edge-preview secret read failed: ${e.message}`,
          cause: e.cause,
        }),
      ),
    ),
  );
