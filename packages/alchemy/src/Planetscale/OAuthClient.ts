import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * PlanetScale's OAuth endpoints (RFC 8628 device authorization grant).
 */
export const OAUTH_ENDPOINTS = {
  device: "https://auth.planetscale.com/oauth/authorize_device",
  token: "https://auth.planetscale.com/oauth/token",
  revoke: "https://auth.planetscale.com/oauth/revoke",
};

/**
 * Public OAuth client id/secret shipped with the PlanetScale CLI. PlanetScale
 * documents these as safe to embed in distributed binaries — they are not
 * confidential and the actual user-facing authorization happens on the
 * planetscale.com domain.
 *
 * @see https://github.com/planetscale/cli/blob/main/internal/auth/authenticator.go
 */
export const OAUTH_CLIENT_ID = "wzzkYKOfRcxFAiMgDgfbhO9yIikNIlt9-yhosmvPBQA";
export const OAUTH_CLIENT_SECRET =
  "eIDdgw21BYsovcrpC4iKZQ0o7ol9cN1LsSr8fuNyg5o";

export class OAuthError extends Data.TaggedError("OAuthError")<{
  error: string;
  errorDescription: string;
}> {}

/**
 * OAuth credentials persisted under `~/.alchemy/credentials/<profile>/planetscale-oauth.json`.
 */
export interface OAuthCredentials {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  scopes: string[];
}

/**
 * Response from the device authorization endpoint.
 */
export interface DeviceVerification {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | undefined;
  expiresIn: number;
  interval: number;
}

const extractCredentials = (json: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}): OAuthCredentials => ({
  type: "oauth",
  access: json.access_token,
  refresh: json.refresh_token,
  expires: Date.now() + json.expires_in * 1000,
  scopes: json.scope.split(" "),
});

const formPost = (
  url: string,
  body: Record<string, string>,
): Effect.Effect<Response, OAuthError> =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body).toString(),
      }),
    catch: (err) =>
      new OAuthError({
        error: "network_error",
        errorDescription: `Request to ${url} failed: ${err}`,
      }),
  });

const parseError = (
  res: Response,
): Effect.Effect<{ error: string; error_description?: string }, OAuthError> =>
  Effect.tryPromise({
    try: () =>
      res.json() as Promise<{ error: string; error_description?: string }>,
    catch: () =>
      new OAuthError({
        error: "parse_error",
        errorDescription: `Token endpoint returned ${res.status}`,
      }),
  });

const tokenRequest = (
  body: Record<string, string>,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.gen(function* () {
    const res = yield* formPost(OAUTH_ENDPOINTS.token, body);

    if (!res.ok) {
      const json = yield* parseError(res);
      return yield* new OAuthError({
        error: json.error,
        errorDescription:
          json.error_description ?? `Token endpoint returned ${res.status}`,
      });
    }

    const json = yield* Effect.tryPromise({
      try: () =>
        res.json() as Promise<{
          access_token: string;
          refresh_token: string;
          expires_in: number;
          scope: string;
        }>,
      catch: () =>
        new OAuthError({
          error: "parse_error",
          errorDescription: "Failed to parse token response",
        }),
    });
    return extractCredentials(json);
  });

/**
 * Initiates the device authorization grant. Returns the user code and
 * verification URL the user should visit, along with the device code we
 * subsequently exchange for an access token.
 */
export const requestDevice = (
  scopes: string[],
): Effect.Effect<DeviceVerification, OAuthError> =>
  Effect.gen(function* () {
    const res = yield* formPost(OAUTH_ENDPOINTS.device, {
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      scope: scopes.join(" "),
    });

    if (!res.ok) {
      const json = yield* parseError(res);
      return yield* new OAuthError({
        error: json.error ?? "device_request_failed",
        errorDescription:
          json.error_description ??
          `Device authorization returned ${res.status}`,
      });
    }

    const json = yield* Effect.tryPromise({
      try: () =>
        res.json() as Promise<{
          device_code: string;
          user_code: string;
          verification_uri: string;
          verification_uri_complete?: string;
          expires_in: number;
          interval: number;
        }>,
      catch: () =>
        new OAuthError({
          error: "parse_error",
          errorDescription: "Failed to parse device authorization response",
        }),
    });

    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri: json.verification_uri,
      verificationUriComplete: json.verification_uri_complete,
      expiresIn: json.expires_in,
      interval: json.interval,
    };
  });

/**
 * Poll the token endpoint until the user completes authorization, the device
 * code expires, or an unrecoverable error is returned.
 *
 * The PlanetScale device flow returns `authorization_pending` while we wait
 * and `slow_down` if we are polling too quickly; both are recoverable and
 * trigger another wait cycle.
 */
export const pollForToken = (
  verification: DeviceVerification,
): Effect.Effect<OAuthCredentials, OAuthError> => {
  const intervalMs = Math.max(1, verification.interval) * 1000;
  const maxAttempts = Math.ceil(verification.expiresIn / verification.interval);

  return tokenRequest({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: verification.deviceCode,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(intervalMs)),
      while: (err) =>
        err.error === "authorization_pending" || err.error === "slow_down",
      times: maxAttempts,
    }),
  );
};

export const refresh = (
  credentials: OAuthCredentials,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });

export const revoke = (
  credentials: OAuthCredentials,
): Effect.Effect<void, OAuthError> =>
  Effect.gen(function* () {
    yield* formPost(OAUTH_ENDPOINTS.revoke, {
      token: credentials.refresh,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    });
  });
