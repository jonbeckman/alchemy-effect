/**
 * Constants shared between the HTTP state-store server
 * (`services/cloudflare-state-store`) and the client-side
 * `HttpStateStoreAuth` provider.
 *
 * Kept in a dedicated leaf module — no runtime side effects, no
 * heavy imports — so the state-store worker can `import` these
 * values without Rolldown pulling in `HttpStateStoreAuth` (which
 * transitively references Clank / `@clack/prompts` / `sisteransi`
 * and breaks the `workerd` bundle).
 */

/**
 * Canonical name used to look up the HTTP state-store auth provider
 * in the `AuthProviders` registry and in `~/.alchemy/credentials`.
 */
export const HTTP_STATE_STORE_AUTH_PROVIDER_NAME =
  "HttpStateStore" as const;

/**
 * Fixed Cloudflare Worker script name the `cloudflare` login method
 * expects a deployed state store to use. Both the server (which
 * passes this as `name` to its `Cloudflare.Worker`) and the login
 * flow (which derives the service URL from it) import this constant.
 */
export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

/**
 * Logical id / secret name of the bearer token the state-store
 * worker authenticates against. The `Cloudflare.Secret` provider
 * uses the logical id as the secret name when no explicit `name`
 * prop is supplied, so this is the single source of truth for both
 * sides of the handshake.
 */
export const STATE_STORE_AUTH_TOKEN_SECRET_NAME =
  "AlchemyStateStoreToken" as const;
