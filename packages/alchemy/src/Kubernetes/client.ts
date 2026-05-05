import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { AwsClient } from "aws4fetch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as https from "node:https";
import {
  buildKubernetesObjectPath,
  chunkByApplyRank,
  kubernetesObjectKey,
  sortRefsForDelete,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "./types.ts";

/**
 * Generic Kubernetes API error — returned for any non-2xx status the more
 * specific tagged errors below don't cover (4xx auth/validation, 5xx).
 */
export class KubernetesApiError extends Data.TaggedError("KubernetesApiError")<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {}

/**
 * The server replied 404 — the requested resource does not exist. Callers
 * decide whether that's terminal (delete is a no-op) or whether reconcile
 * should fall through to create.
 */
export class KubernetesNotFound extends Data.TaggedError("KubernetesNotFound")<{
  method: string;
  path: string;
  body: string;
}> {}

/**
 * The server replied 409 Conflict. Two common shapes:
 *   - resourceVersion changed underneath us (optimistic concurrency)
 *   - "object is being deleted" / "namespace is being terminated"
 * Both shapes are retryable in bounded fashion: the second resolves only
 * after the prior delete completes, so we cap retries to avoid looping
 * forever when the cluster genuinely refuses (e.g. namespace stuck
 * terminating).
 */
export class KubernetesConflict extends Data.TaggedError("KubernetesConflict")<{
  method: string;
  path: string;
  body: string;
}> {}

/**
 * The server replied 429 Too Many Requests. Always safe to retry with
 * backoff — the API server is asking us to slow down.
 */
export class KubernetesThrottled extends Data.TaggedError(
  "KubernetesThrottled",
)<{
  method: string;
  path: string;
  body: string;
}> {}

/**
 * Transport-level failure (TCP reset, TLS handshake, DNS, etc.) before we
 * got an HTTP status. Always retryable, since by definition the request
 * never reached the API server's decision logic.
 */
export class KubernetesNetworkError extends Data.TaggedError(
  "KubernetesNetworkError",
)<{
  method: string;
  path: string;
  cause: string;
}> {}

/**
 * Bounded wait for a `Deployment` to converge to ready. Surfaces if it
 * never does, so callers get a real failure instead of silently returning
 * before pods come up.
 */
export class KubernetesDeploymentNotReady extends Data.TaggedError(
  "KubernetesDeploymentNotReady",
)<{
  namespace: string;
  name: string;
  observedGeneration: number | undefined;
  generation: number | undefined;
  readyReplicas: number | undefined;
  updatedReplicas: number | undefined;
  desiredReplicas: number | undefined;
}> {}

/**
 * Bounded wait for a delete to fully clear (finalizers run, tombstone
 * removed). Surfaces if it doesn't.
 */
export class KubernetesDeleteNotComplete extends Data.TaggedError(
  "KubernetesDeleteNotComplete",
)<{
  apiVersion: string;
  kind: string;
  namespace: string | undefined;
  name: string;
}> {}

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
                    "Content-Type": "application/apply-patch+yaml",
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
                // Narrow the error so callers can `catchTag` precisely
                // instead of inspecting `statusCode` on a generic envelope.
                if (statusCode === 404) {
                  reject(
                    new KubernetesNotFound({
                      method,
                      path,
                      body: responseBody,
                    }),
                  );
                  return;
                }
                if (statusCode === 409) {
                  reject(
                    new KubernetesConflict({
                      method,
                      path,
                      body: responseBody,
                    }),
                  );
                  return;
                }
                if (statusCode === 429) {
                  reject(
                    new KubernetesThrottled({
                      method,
                      path,
                      body: responseBody,
                    }),
                  );
                  return;
                }
                reject(
                  new KubernetesApiError({
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
    catch: (error) => {
      // Pass typed API errors through untouched.
      if (
        error instanceof KubernetesApiError ||
        error instanceof KubernetesNotFound ||
        error instanceof KubernetesConflict ||
        error instanceof KubernetesThrottled
      ) {
        return error;
      }
      // Anything else — TLS, ECONNRESET, DNS, socket hangup — is a
      // transport-level failure that never reached the API server's
      // decision logic. Always retryable.
      return new KubernetesNetworkError({
        method,
        path,
        cause: error instanceof Error ? error.message : String(error),
      });
    },
  });
});

/**
 * 429 throttling and transport hiccups are universally retryable; cap to
 * keep CLI deploys bounded if the cluster is genuinely down.
 */
const transientRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.both(Schedule.recurs(8)),
);

const retryTransient = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.retry(effect, {
    while: (e: E) => {
      const tag = (e as { _tag?: string })._tag;
      return tag === "KubernetesThrottled" || tag === "KubernetesNetworkError";
    },
    schedule: transientRetrySchedule,
  });

/**
 * 409 retry budget for apply. Conflicts here are usually:
 *   - resourceVersion races (resolves on next read)
 *   - "namespace is being terminated" (resolves once the namespace is gone)
 * Bounded so a stuck namespace fails the deploy instead of looping forever.
 */
const conflictRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.both(Schedule.recurs(10)),
);

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
  }).pipe(retryTransient);
});

export const applyObject = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectDefinition;
}) {
  const path = `${buildKubernetesObjectPath(toKubernetesObjectRef(object))}?fieldManager=${fieldManager}&force=true`;

  const result = yield* requestJson({
    connection,
    method: "PATCH",
    path,
    body: object,
  }).pipe(
    retryTransient,
    // 409 on apply means a concurrent writer or a namespace mid-delete.
    // Both resolve on retry; we cap so a permanently-stuck namespace
    // surfaces instead of looping forever.
    Effect.retry({
      while: (e) => (e as { _tag?: string })._tag === "KubernetesConflict",
      schedule: conflictRetrySchedule,
    }),
  );

  // For Deployments specifically, wait until the rollout converges so
  // downstream resources don't see a half-deployed app. We compare
  // status.observedGeneration against metadata.generation and check
  // readyReplicas — the canonical kubectl rollout-status check.
  if (object.apiVersion === "apps/v1" && object.kind === "Deployment") {
    yield* waitForDeploymentReady({
      connection,
      object: toKubernetesObjectRef(object),
    });
  }

  return result;
});

export interface DeploymentLike {
  metadata?: {
    generation?: number;
  };
  spec?: {
    replicas?: number;
  };
  status?: {
    observedGeneration?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    replicas?: number;
  };
}

export const isDeploymentReady = (deployment: DeploymentLike): boolean => {
  const generation = deployment.metadata?.generation;
  const observed = deployment.status?.observedGeneration;
  // Controller hasn't seen our update yet.
  if (generation !== undefined && observed !== undefined && observed < generation) {
    return false;
  }
  const desired = deployment.spec?.replicas ?? 1;
  const ready = deployment.status?.readyReplicas ?? 0;
  const updated = deployment.status?.updatedReplicas ?? 0;
  return ready >= desired && updated >= desired;
};

/**
 * Bounded poll for `availableReplicas`/`readyReplicas` to catch up to
 * `spec.replicas` after an apply. We give the rollout 5 minutes (enough
 * for an image pull on a cold node, well short of a hung deploy).
 */
const waitForDeploymentReady = Effect.fn(function* ({
  connection,
  object,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
}) {
  const deployment = yield* readObject({
    connection,
    object,
  }).pipe(
    Effect.flatMap((d) => {
      const dep = d as DeploymentLike;
      if (isDeploymentReady(dep)) {
        return Effect.succeed(dep);
      }
      return Effect.fail(
        new KubernetesDeploymentNotReady({
          namespace: object.namespace ?? "",
          name: object.name,
          observedGeneration: dep.status?.observedGeneration,
          generation: dep.metadata?.generation,
          readyReplicas: dep.status?.readyReplicas,
          updatedReplicas: dep.status?.updatedReplicas,
          desiredReplicas: dep.spec?.replicas,
        }),
      );
    }),
    Effect.retry({
      while: (e) =>
        (e as { _tag?: string })._tag === "KubernetesDeploymentNotReady",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(150)),
      ),
    }),
  );
  return deployment;
});

export const deleteObject = Effect.fn(function* ({
  connection,
  object,
  waitForRemoval = false,
}: {
  connection: KubernetesClusterConnection;
  object: KubernetesObjectRef;
  /**
   * If true, poll until the object returns 404 (finalizers complete).
   * Useful for namespaces and other finalizer-heavy resources where the
   * server returns 200 immediately but the object lingers with a
   * deletionTimestamp until controllers run.
   */
  waitForRemoval?: boolean;
}) {
  // The DELETE itself is idempotent on 404 (already gone) and bounded-
  // retryable on 409 (conflicts during finalization).
  yield* requestJson({
    connection,
    method: "DELETE",
    path: buildKubernetesObjectPath(object),
  }).pipe(
    retryTransient,
    Effect.catchTag("KubernetesNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => (e as { _tag?: string })._tag === "KubernetesConflict",
      schedule: conflictRetrySchedule,
    }),
  );

  if (!waitForRemoval) {
    return;
  }

  // Poll GET until we get a 404. Bounded — a hung namespace finalizer
  // surfaces as KubernetesDeleteNotComplete instead of a silent timeout.
  yield* readObject({
    connection,
    object,
  }).pipe(
    Effect.flatMap(() =>
      Effect.fail(
        new KubernetesDeleteNotComplete({
          apiVersion: object.apiVersion,
          kind: object.kind,
          namespace: object.namespace,
          name: object.name,
        }),
      ),
    ),
    Effect.catchTag("KubernetesNotFound", () => Effect.void),
    Effect.retry({
      while: (e) =>
        (e as { _tag?: string })._tag === "KubernetesDeleteNotComplete",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(150)),
      ),
    }),
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
    // Wait for namespaces to finish terminating before we move on, so a
    // subsequent apply that recreates an object in that namespace doesn't
    // race with the namespace's finalizer and 409.
    const waitForRemoval = object.kind === "Namespace";
    yield* deleteObject({
      connection,
      object,
      waitForRemoval,
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
    const waitForRemoval = object.kind === "Namespace";
    yield* deleteObject({
      connection,
      object,
      waitForRemoval,
    });
  }
});

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
