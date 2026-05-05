import { describe, expect, test } from "@effect/vitest";
import {
  classifyKubernetesStatus,
  isKubernetesKindSupported,
  KubernetesApiError,
  KubernetesConflict,
  KubernetesGone,
  KubernetesObjectNotFound,
  KubernetesServerError,
  KubernetesUnauthorized,
} from "../../src/Kubernetes/client";
import {
  buildKubernetesObjectPath,
  chunkByApplyRank,
  sortRefsForDelete,
  type KubernetesObjectDefinition,
} from "../../src/Kubernetes/types";

const params = (statusCode: number, body = "{}") => ({
  method: "GET",
  path: "/api/v1/configmaps/foo",
  statusCode,
  body,
});

describe("classifyKubernetesStatus", () => {
  test("404 -> KubernetesObjectNotFound", () => {
    const err = classifyKubernetesStatus(params(404));
    expect(err).toBeInstanceOf(KubernetesObjectNotFound);
    expect(err._tag).toBe("KubernetesObjectNotFound");
  });

  test("409 -> KubernetesConflict (retryable on apply, not on create)", () => {
    const err = classifyKubernetesStatus(params(409));
    expect(err).toBeInstanceOf(KubernetesConflict);
  });

  test("410 -> KubernetesGone (non-retryable)", () => {
    const err = classifyKubernetesStatus(params(410));
    expect(err).toBeInstanceOf(KubernetesGone);
  });

  test.each([401, 403])(
    "%i -> KubernetesUnauthorized (non-retryable)",
    (code) => {
      const err = classifyKubernetesStatus(params(code));
      expect(err).toBeInstanceOf(KubernetesUnauthorized);
      expect((err as KubernetesUnauthorized).statusCode).toBe(code);
    },
  );

  test.each([500, 502, 503, 504])(
    "%i -> KubernetesServerError (retryable)",
    (code) => {
      const err = classifyKubernetesStatus(params(code));
      expect(err).toBeInstanceOf(KubernetesServerError);
    },
  );

  test("422 (Invalid) -> generic KubernetesApiError (NOT retryable)", () => {
    // Invalid spec mutations on Job are surfaced as 422 — they're context-
    // dependent (the operator must replace the resource), so they fall
    // through to the untyped `KubernetesApiError` and are not auto-retried.
    const err = classifyKubernetesStatus(params(422));
    expect(err).toBeInstanceOf(KubernetesApiError);
    expect((err as KubernetesApiError).statusCode).toBe(422);
  });

  test("preserves body for downstream reason matching", () => {
    const err = classifyKubernetesStatus(params(409, '{"reason":"AlreadyExists"}'));
    expect(err.body).toBe('{"reason":"AlreadyExists"}');
  });
});

describe("isKubernetesKindSupported", () => {
  test.each([
    ["v1", "Namespace"],
    ["v1", "ServiceAccount"],
    ["v1", "ConfigMap"],
    ["v1", "Service"],
    ["apps/v1", "Deployment"],
    ["batch/v1", "Job"],
  ] as const)("recognizes canonical kind %s/%s", (apiVersion, kind) => {
    expect(isKubernetesKindSupported({ apiVersion, kind })).toBe(true);
  });

  test("rejects unknown kind without throwing", () => {
    expect(
      isKubernetesKindSupported({
        apiVersion: "example.com/v1",
        kind: "Widget",
      }),
    ).toBe(false);
  });
});

describe("buildKubernetesObjectPath", () => {
  test("namespaced core resource uses /api/v1", () => {
    expect(
      buildKubernetesObjectPath({
        apiVersion: "v1",
        kind: "ConfigMap",
        name: "demo",
        namespace: "default",
      }),
    ).toBe("/api/v1/namespaces/default/configmaps/demo");
  });

  test("namespaced grouped resource uses /apis/<group>/<version>", () => {
    expect(
      buildKubernetesObjectPath({
        apiVersion: "batch/v1",
        kind: "Job",
        name: "seed",
        namespace: "default",
      }),
    ).toBe("/apis/batch/v1/namespaces/default/jobs/seed");
  });

  test("cluster-scoped resource omits /namespaces/...", () => {
    expect(
      buildKubernetesObjectPath({
        apiVersion: "v1",
        kind: "Namespace",
        name: "team-a",
      }),
    ).toBe("/api/v1/namespaces/team-a");
  });

  test("namespaced resource without namespace throws", () => {
    expect(() =>
      buildKubernetesObjectPath({
        apiVersion: "v1",
        kind: "ConfigMap",
        name: "demo",
      }),
    ).toThrow(/requires a namespace/);
  });
});

describe("chunkByApplyRank + sortRefsForDelete", () => {
  const ns: KubernetesObjectDefinition = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "team-a" },
  };
  const sa: KubernetesObjectDefinition = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: "api", namespace: "team-a" },
  };
  const cm: KubernetesObjectDefinition = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "app", namespace: "team-a" },
  };
  const job: KubernetesObjectDefinition = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "seed", namespace: "team-a" },
  };

  test("apply order: Namespace -> ServiceAccount -> ConfigMap -> Job", () => {
    const chunks = chunkByApplyRank([job, cm, sa, ns]);
    expect(chunks.map((c) => c.map((o) => o.kind))).toEqual([
      ["Namespace"],
      ["ServiceAccount"],
      ["ConfigMap"],
      ["Job"],
    ]);
  });

  test("delete order is the reverse of apply (highest applyRank first)", () => {
    const refs = [ns, sa, cm, job].map((o) => ({
      apiVersion: o.apiVersion,
      kind: o.kind,
      name: o.metadata.name,
      namespace: o.metadata.namespace,
    }));
    expect(sortRefsForDelete(refs).map((r) => r.kind)).toEqual([
      "Job",
      "ConfigMap",
      "ServiceAccount",
      "Namespace",
    ]);
  });
});
