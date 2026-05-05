import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { AwsClient } from "aws4fetch";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as https from "node:https";
import {
  buildKubernetesObjectPath,
  chunkByApplyRank,
  getKubernetesKindSpec,
  kubernetesObjectKey,
  sortRefsForDelete,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "./types.ts";

/**
 * Untyped error returned for any Kubernetes API status not handled by a
 * dedicated tagged class below. Callers should treat this as non-retryable
 * unless they have explicit knowledge of the underlying status code.
 */
export class KubernetesApiError extends Data.TaggedError("KubernetesApiError")<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {}

/**
 * 404 - the object does not exist (or no longer exists). Idempotent deletes
 * swallow this; reads convert it to "missing".
 */
export class KubernetesObjectNotFound extends Data.TaggedError(
  "KubernetesObjectNotFound",
)<{
  method: string;
  path: string;
  body: string;
}> {}

/**
 * 409 - resource version conflict, or "already exists" on create races. For
 * server-side apply, this is retryable: re-fetch and re-apply.
 */
export class KubernetesConflict extends Data.TaggedError(
  "KubernetesConflict",
)<{
  method: string;
  path: string;
  body: string;
}> {}

/**
 * 410 - the requested resource version is too old / GC'd. Treated as
 * non-retryable: caller should re-list.
 */
export class KubernetesGone extends Data.TaggedError("KubernetesGone")<{
  method: string;
  path: string;
  body: string;
}> {}

/**
 * 401/403 - auth failure or RBAC denial. Non-retryable. Surfaced with the
 * full body so the operator can see which verb on which resource was denied.
 */
export class KubernetesUnauthorized extends Data.TaggedError(
  "KubernetesUnauthorized",
)<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {}

/**
 * Internal/unavailable (5xx). Treated as transient and retried with
 * exponential backoff at the call site.
 */
export class KubernetesServerError extends Data.TaggedError(
  "KubernetesServerError",
)<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {}

/**
 * Union of every typed Kubernetes API error. Useful for downstream
 * `Effect.catchTag` plumbing.
 */
export type KubernetesTypedError =
  | KubernetesApiError
  | KubernetesObjectNotFound
  | KubernetesConflict
  | KubernetesGone
  | KubernetesUnauthorized
  | KubernetesServerError;

export interface KubernetesClusterConnection {
  clusterName: string;
  endpoint: string;
  certificateAuthorityData: string;
}

const fieldManager = "alchemy";

const createBearerToken = Effect.fn(function* (clusterName: string) {
  const credentials = yield* yield* Credentials;
  const region = yield* Region;

  const client = new AwsClient({
    accessKeyId: Redacted.value(credentials.accessKeyId),
    secretAccessKey: Redacted.value(credentials.secretAccessKey),
    sessionToken: credentials.sessionToken
      ? Redacted.value(credentials.sessionToken)
      : undefined,
    service: "sts",
    region,
  });

  const presigned = yield* Effect.tryPromise(() =>
    client.sign(
      new Request(
        `https://sts.${region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Expires=60`,
        {
          headers: {
            "x-k8s-aws-id": clusterName,
          },
        },
      ),
      {
        aws: {
          signQuery: true,
          allHeaders: true,
        },
      },
    ),
  );

  return `k8s-aws-v1.${Buffer.from(presigned.url).toString("base64url")}`;
});

/**
 * Map an HTTP status to its narrowest typed error. The body is preserved so
 * downstream layers can still pattern-match on `reason` (e.g. distinguishing
 * `AlreadyExists` from `Conflict` when both surface as 409) without forcing
 * us to maintain a parallel parsed-status enum.
 */
export const classifyKubernetesStatus = (params: {
  method: string;
  path: string;
  statusCode: number;
  body: string;
}):
  | KubernetesObjectNotFound
  | KubernetesConflict
  | KubernetesGone
  | KubernetesUnauthorized
  | KubernetesServerError
  | KubernetesApiError => {
  const { method, path, statusCode, body } = params;
  if (statusCode === 404) {
    return new KubernetesObjectNotFound({ method, path, body });
  }
  if (statusCode === 409) {
    return new KubernetesConflict({ method, path, body });
  }
  if (statusCode === 410) {
    return new KubernetesGone({ method, path, body });
  }
  if (statusCode === 401 || statusCode === 403) {
    return new KubernetesUnauthorized({ method, path, statusCode, body });
  }
  if (statusCode >= 500 && statusCode < 600) {
    return new KubernetesServerError({ method, path, statusCode, body });
  }
  return new KubernetesApiError({ method, path, statusCode, body });
};

const isApplyPatch = (method: string, body: unknown) =>
  method === "PATCH" && body !== undefined;

const requestJson = Effect.fn(function* ({
  connection,
  method,
  path,
  body,
}: {
  connection: KubernetesClusterConnection;
  method: string;
  path: string;
  body?: Record<string, unknown>;
}) {
  const token = yield* createBearerToken(connection.clusterName);
  const url = new URL(path, connection.endpoint);
  const payload = body ? JSON.stringify(body) : undefined;

  return yield* Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve, reject) => {
        const request = https.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(payload
                ? {
                    "Content-Type": isApplyPatch(method, body)
                      ? "application/apply-patch+yaml"
                      : "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                  }
                : {}),
            },
            ca: Buffer.from(
              connection.certificateAuthorityData,
              "base64",
            ).toString("utf8"),
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on("end", () => {
              const responseBody = Buffer.concat(chunks).toString("utf8");
              const statusCode = response.statusCode ?? 500;

              if (statusCode < 200 || statusCode >= 300) {
                reject(
                  classifyKubernetesStatus({
                    method,
                    path,
                    statusCode,
                    body: responseBody,
                  }),
                );
                return;
              }

              if (!responseBody.trim()) {
                resolve(undefined);
                return;
              }

              try {
                resolve(JSON.parse(responseBody));
              } catch {
                resolve(responseBody);
              }
            });
          },
        );

        request.on("error", reject);
        if (payload) {
          request.write(payload);
        }
        request.end();
      }),
    catch: (error): KubernetesTypedError | Error => {
      // Anything we threw via classifyKubernetesStatus is already typed —
      // pass through unchanged. Anything else (network, TLS, JSON) becomes
      // a generic untyped error so we don't silently swallow it.
      if (
        error instanceof KubernetesApiError ||
        error instanceof KubernetesObjectNotFound ||
        error instanceof KubernetesConflict ||
        error instanceof KubernetesGone ||
        error instanceof KubernetesUnauthorized ||
        error instanceof KubernetesServerError
      ) {
        return error;
      }
      return new Error(
        `Failed Kubernetes ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
});

export const readObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
}) {
  return yield* requestJson({
    connection,
    method: "GET",
    path: buildKubernetesObjectPath(object),
  });
});

/**
 * Server-side apply. On a transient `409 Conflict` (concurrent modification
 * by another field manager) we retry with exponential backoff so we can ride
 * out controllers that mutate the object simultaneously. `5xx` server errors
 * are likewise retried. All other typed errors propagate unchanged.
 */
export const applyObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectDefinition;
}) {
  const path = `${buildKubernetesObjectPath(toKubernetesObjectRef(object))}?fieldManager=${fieldManager}&force=true`;

  return yield* requestJson({
    connection,
    method: "PATCH",
    path,
    body: object,
  }).pipe(
    Effect.retry({
      while: (e) =>
        e instanceof KubernetesConflict || e instanceof KubernetesServerError,
      schedule: Schedule.exponential(Duration.millis(250)).pipe(
        Schedule.both(Schedule.recurs(5)),
      ),
    }),
  );
});

/**
 * Idempotent delete with `propagationPolicy: Background` so the API server
 * removes dependents (e.g. Job-managed Pods) without blocking. A `404` is
 * swallowed — already-deleted is the desired terminal state.
 */
export const deleteObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
}) {
  yield* requestJson({
    connection,
    method: "DELETE",
    path: buildKubernetesObjectPath(object),
    body: {
      kind: "DeleteOptions",
      apiVersion: "meta/v1",
      propagationPolicy: "Background",
    },
  }).pipe(
    // 5xx during delete is transient — retry briefly before giving up.
    Effect.retry({
      while: (e) => e instanceof KubernetesServerError,
      schedule: Schedule.exponential(Duration.millis(250)).pipe(
        Schedule.both(Schedule.recurs(5)),
      ),
    }),
    Effect.catchIf(
      (e): e is KubernetesObjectNotFound =>
        e instanceof KubernetesObjectNotFound,
      () => Effect.void,
    ),
  );
});

export const reconcileObjects = Effect.fn(function* ({
  connection,
  previousObjects,
  desiredObjects,
}: {
  connection: KubernetesClusterConnection;
  previousObjects: ReadonlyArray<KubernetesObjectRef>;
  desiredObjects: ReadonlyArray<KubernetesObjectDefinition>;
}) {
  const desiredRefs = desiredObjects.map(toKubernetesObjectRef);
  const desiredKeys = new Set(desiredRefs.map(kubernetesObjectKey));

  const removedObjects = previousObjects.filter(
    (object) => !desiredKeys.has(kubernetesObjectKey(object)),
  );

  for (const object of sortRefsForDelete(removedObjects)) {
    yield* deleteObject({
      connection,
      object,
    });
  }

  for (const chunk of chunkByApplyRank(desiredObjects)) {
    yield* Effect.forEach(
      chunk,
      (object) =>
        applyObject({
          connection,
          object,
        }),
      {
        concurrency: "unbounded",
      },
    );
  }

  return desiredRefs;
});

export const deleteObjects = Effect.fn(function* ({
  connection,
  objects,
}: {
  connection: KubernetesClusterConnection;
  objects: ReadonlyArray<KubernetesObjectRef>;
}) {
  for (const object of sortRefsForDelete(objects)) {
    yield* deleteObject({
      connection,
      object,
    });
  }
});

/**
 * Surfaces `applyRank` for the canonical kinds. Exported so resource modules
 * can assert that a given `apiVersion`/`kind` is registered without having
 * to import the internal map.
 */
export const isKubernetesKindSupported = (
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">,
) => {
  try {
    getKubernetesKindSpec(input);
    return true;
  } catch {
    return false;
  }
};

export const createClient = (connection: KubernetesClusterConnection) => ({
  readObject: (object: KubernetesObjectRef) =>
    readObject({
      connection,
      object,
    }),
  applyObject: (object: KubernetesObjectDefinition) =>
    applyObject({
      connection,
      object,
    }),
  deleteObject: (object: KubernetesObjectRef) =>
    deleteObject({
      connection,
      object,
    }),
  reconcileObjects: ({
    previousObjects,
    desiredObjects,
  }: {
    previousObjects: ReadonlyArray<KubernetesObjectRef>;
    desiredObjects: ReadonlyArray<KubernetesObjectDefinition>;
  }) =>
    reconcileObjects({
      connection,
      previousObjects,
      desiredObjects,
    }),
  deleteObjects: (objects: ReadonlyArray<KubernetesObjectRef>) =>
    deleteObjects({
      connection,
      objects,
    }),
});
