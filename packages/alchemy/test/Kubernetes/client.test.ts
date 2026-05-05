import { describe, expect, test } from "@effect/vitest";
import {
  isDeploymentReady,
  type DeploymentLike,
} from "../../src/Kubernetes/client.ts";
import {
  buildKubernetesObjectPath,
  chunkByApplyRank,
  kubernetesObjectKey,
  sortRefsForDelete,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
} from "../../src/Kubernetes/types.ts";

describe("Kubernetes/types", () => {
  describe("buildKubernetesObjectPath", () => {
    test("namespaced core resource uses /api/v1 prefix", () => {
      expect(
        buildKubernetesObjectPath({
          apiVersion: "v1",
          kind: "ConfigMap",
          name: "cfg",
          namespace: "demo",
        }),
      ).toBe("/api/v1/namespaces/demo/configmaps/cfg");
    });

    test("namespaced apps/v1 Deployment uses /apis prefix", () => {
      expect(
        buildKubernetesObjectPath({
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "api",
          namespace: "demo",
        }),
      ).toBe("/apis/apps/v1/namespaces/demo/deployments/api");
    });

    test("cluster-scoped Namespace omits /namespaces/ segment", () => {
      expect(
        buildKubernetesObjectPath({
          apiVersion: "v1",
          kind: "Namespace",
          name: "demo",
        }),
      ).toBe("/api/v1/namespaces/demo");
    });

    test("namespaced kind without namespace throws", () => {
      expect(() =>
        buildKubernetesObjectPath({
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "api",
        }),
      ).toThrow(/requires a namespace/);
    });
  });

  describe("kubernetesObjectKey", () => {
    test("encodes apiVersion/kind/namespace/name", () => {
      expect(
        kubernetesObjectKey({
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "api",
          namespace: "demo",
        }),
      ).toBe("apps/v1/Deployment/demo/api");
    });

    test("uses _cluster sentinel for cluster-scoped objects", () => {
      expect(
        kubernetesObjectKey({
          apiVersion: "v1",
          kind: "Namespace",
          name: "demo",
        }),
      ).toBe("v1/Namespace/_cluster/demo");
    });
  });

  describe("chunkByApplyRank", () => {
    const make = (
      apiVersion: string,
      kind: string,
      name: string,
      namespace?: string,
    ): KubernetesObjectDefinition => ({
      apiVersion,
      kind,
      metadata: { name, namespace },
    });

    test("groups objects by applyRank so namespaces apply before deps", () => {
      const objs = [
        make("apps/v1", "Deployment", "api", "demo"),
        make("v1", "Namespace", "demo"),
        make("v1", "ConfigMap", "cfg", "demo"),
      ];
      const chunks = chunkByApplyRank(objs);
      expect(chunks.length).toBe(3);
      expect(chunks[0]?.[0]?.kind).toBe("Namespace");
      expect(chunks[1]?.[0]?.kind).toBe("ConfigMap");
      expect(chunks[2]?.[0]?.kind).toBe("Deployment");
    });

    test("collapses same-rank kinds into a single concurrent chunk", () => {
      const objs = [
        make("v1", "ConfigMap", "a", "demo"),
        make("v1", "ConfigMap", "b", "demo"),
      ];
      const chunks = chunkByApplyRank(objs);
      expect(chunks.length).toBe(1);
      expect(chunks[0]?.length).toBe(2);
    });
  });

  describe("sortRefsForDelete", () => {
    test("deletes in reverse apply order (Deployment before Namespace)", () => {
      const refs = [
        { apiVersion: "v1", kind: "Namespace", name: "demo" },
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "api",
          namespace: "demo",
        },
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          name: "cfg",
          namespace: "demo",
        },
      ];
      const sorted = sortRefsForDelete(refs);
      expect(sorted.map((r) => r.kind)).toEqual([
        "Deployment",
        "ConfigMap",
        "Namespace",
      ]);
    });
  });

  describe("toKubernetesObjectRef", () => {
    test("strips body and keeps only identity fields", () => {
      const obj: KubernetesObjectDefinition = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "api", namespace: "demo", labels: { a: "b" } },
        spec: { replicas: 3 },
      };
      expect(toKubernetesObjectRef(obj)).toEqual({
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: "api",
        namespace: "demo",
      });
    });
  });
});

describe("isDeploymentReady", () => {
  const dep = (overrides: DeploymentLike): DeploymentLike => overrides;

  test("ready when observedGeneration === generation and replicas converged", () => {
    expect(
      isDeploymentReady(
        dep({
          metadata: { generation: 3 },
          spec: { replicas: 2 },
          status: {
            observedGeneration: 3,
            readyReplicas: 2,
            updatedReplicas: 2,
          },
        }),
      ),
    ).toBe(true);
  });

  test("not ready when controller hasn't observed latest generation", () => {
    expect(
      isDeploymentReady(
        dep({
          metadata: { generation: 4 },
          spec: { replicas: 2 },
          status: {
            observedGeneration: 3,
            readyReplicas: 2,
            updatedReplicas: 2,
          },
        }),
      ),
    ).toBe(false);
  });

  test("not ready when readyReplicas lags desired", () => {
    expect(
      isDeploymentReady(
        dep({
          metadata: { generation: 1 },
          spec: { replicas: 3 },
          status: {
            observedGeneration: 1,
            readyReplicas: 1,
            updatedReplicas: 3,
          },
        }),
      ),
    ).toBe(false);
  });

  test("not ready when updatedReplicas lags desired (rolling)", () => {
    expect(
      isDeploymentReady(
        dep({
          metadata: { generation: 2 },
          spec: { replicas: 3 },
          status: {
            observedGeneration: 2,
            readyReplicas: 3,
            updatedReplicas: 1,
          },
        }),
      ),
    ).toBe(false);
  });

  test("not ready on a fresh deployment with empty status", () => {
    expect(
      isDeploymentReady(
        dep({
          metadata: { generation: 1 },
          spec: { replicas: 1 },
          status: {},
        }),
      ),
    ).toBe(false);
  });

  test("defaults to replicas=1 when spec omits replicas", () => {
    expect(
      isDeploymentReady(
        dep({
          metadata: { generation: 1 },
          spec: {},
          status: {
            observedGeneration: 1,
            readyReplicas: 1,
            updatedReplicas: 1,
          },
        }),
      ),
    ).toBe(true);
  });
});

// Live-cluster lifecycle tests. These exercise the reconcile flow against a
// real EKS cluster — redeploy no-op, OOB drift recovery, OOB delete recovery,
// rename-triggers-replace, and double-destroy idempotency. Skipped by default
// because there is no kind/minikube fixture in this repo; flip the suite on
// once an EKS test cluster is provisioned.
describe.skip("Deployment lifecycle (requires EKS cluster)", () => {
  test("redeploy with same spec is a no-op", () => {});
  test("reconcile resets replicas mutated out-of-band", () => {});
  test("reconcile resets image mutated out-of-band", () => {});
  test("reconcile resets env mutated out-of-band", () => {});
  test("reconcile re-creates a deployment deleted out-of-band", () => {});
  test("changing name triggers replace", () => {});
  test("destroying an already-deleted deployment is a no-op", () => {});
});

describe.skip("Namespace lifecycle (requires EKS cluster)", () => {
  test("redeploy is a no-op", () => {});
  test("recreate after OOB delete", () => {});
  test("rename triggers replace", () => {});
  test("double-destroy is idempotent", () => {});
});
