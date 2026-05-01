import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags } from "../../Tags.ts";

import { stageArn, syncTags } from "./common.ts";

export interface StageProps {
  restApiId: Input<string>;
  stageName: string;
  deploymentId: Input<string>;
  description?: string;
  cacheClusterEnabled?: boolean;
  cacheClusterSize?: ag.CacheClusterSize;
  variables?: { [key: string]: string | undefined };
  documentationVersion?: string;
  canarySettings?: ag.CanarySettings;
  tracingEnabled?: boolean;
  /**
   * Map of resource path pattern to method settings; keys use `{resourcePath}/{httpMethod}`.
   */
  methodSettings?: { [key: string]: ag.MethodSetting | undefined };
  accessLogSettings?: ag.AccessLogSettings;
  webAclArn?: string;
  tags?: Record<string, string>;
}

export interface ApiGatewayStage extends Resource<
  "AWS.ApiGateway.Stage",
  StageProps,
  {
    restApiId: string;
    stageName: string;
    deploymentId: string;
    description: string | undefined;
    cacheClusterEnabled: boolean | undefined;
    cacheClusterSize: ag.CacheClusterSize | undefined;
    variables: { [key: string]: string | undefined } | undefined;
    documentationVersion: string | undefined;
    canarySettings: ag.CanarySettings | undefined;
    tracingEnabled: boolean | undefined;
    methodSettings: { [key: string]: ag.MethodSetting | undefined } | undefined;
    accessLogSettings: ag.AccessLogSettings | undefined;
    webAclArn: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A stage for a REST API deployment.
 *
 * @section Stages
 * @example Dev stage
 * ```typescript
 * const stage = yield* ApiGateway.Stage("Dev", {
 *   restApiId: api.restApiId,
 *   stageName: "dev",
 *   deploymentId: deployment.deploymentId,
 * });
 * ```
 */
const StageResource = Resource<ApiGatewayStage>("AWS.ApiGateway.Stage");

export { StageResource as Stage };

const toTagRecord = (tags: ag.Stage["tags"]) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );

const encodeJsonPointerSegment = (s: string) =>
  s.replace(/~/g, "~0").replace(/\//g, "~1");

const snapshotStage = (s: ag.Stage, restApiId: string, stageName: string) => ({
  restApiId,
  stageName,
  deploymentId: s.deploymentId!,
  description: s.description,
  cacheClusterEnabled: s.cacheClusterEnabled,
  cacheClusterSize: s.cacheClusterSize,
  variables: s.variables,
  documentationVersion: s.documentationVersion,
  canarySettings: s.canarySettings,
  tracingEnabled: s.tracingEnabled,
  methodSettings: s.methodSettings,
  accessLogSettings: s.accessLogSettings,
  webAclArn: s.webAclArn,
  tags: toTagRecord(s.tags),
});

const parseMethodSettingKey = (key: string) => {
  const idx = key.lastIndexOf("/");
  if (idx <= 0) {
    return { resourcePath: key, httpMethod: "*" };
  }
  return {
    resourcePath: key.slice(0, idx),
    httpMethod: key.slice(idx + 1),
  };
};

function methodSettingScalarPatch(
  base: string,
  field: keyof ag.MethodSetting,
  prev: ag.MethodSetting | undefined,
  next: ag.MethodSetting | undefined,
): ag.PatchOperation | undefined {
  if (prev?.[field] === next?.[field]) return undefined;
  const v = next?.[field];
  if (v === undefined) {
    return { op: "remove", path: `${base}/${field}` };
  }
  return {
    op: "replace",
    path: `${base}/${field}`,
    value: typeof v === "boolean" ? String(v) : String(v),
  };
}

const buildMethodSettingPatches = (
  prev: { [key: string]: ag.MethodSetting | undefined } | undefined,
  next: { [key: string]: ag.MethodSetting | undefined } | undefined,
): ag.PatchOperation[] => {
  const keys = new Set([
    ...Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]);
  const patches: ag.PatchOperation[] = [];
  const fields: (keyof ag.MethodSetting)[] = [
    "metricsEnabled",
    "loggingLevel",
    "dataTraceEnabled",
    "throttlingBurstLimit",
    "throttlingRateLimit",
    "cachingEnabled",
    "cacheTtlInSeconds",
    "cacheDataEncrypted",
    "requireAuthorizationForCacheControl",
    "unauthorizedCacheControlHeaderStrategy",
  ];
  for (const key of keys) {
    const p = prev?.[key];
    const n = next?.[key];
    if (!n && !p) continue;
    const { resourcePath, httpMethod } = parseMethodSettingKey(key);
    const rp = encodeJsonPointerSegment(resourcePath);
    const hm = encodeJsonPointerSegment(httpMethod);
    const base = `/${rp}/${hm}`;
    if (!n) {
      for (const f of fields) {
        const op = methodSettingScalarPatch(base, f, p, undefined);
        if (op) patches.push(op);
      }
      continue;
    }
    if (p && deepEqual(p, n)) continue;
    for (const f of fields) {
      const op = methodSettingScalarPatch(base, f, p, n);
      if (op) patches.push(op);
    }
  }
  return patches;
};

const buildVariablePatches = (
  prev: { [key: string]: string | undefined } | undefined,
  next: { [key: string]: string | undefined } | undefined,
): ag.PatchOperation[] => {
  const keys = new Set([
    ...Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]);
  const patches: ag.PatchOperation[] = [];
  for (const k of keys) {
    const pv = prev?.[k];
    const nv = next?.[k];
    if (pv === nv) continue;
    const enc = encodeJsonPointerSegment(k);
    if (nv === undefined) {
      patches.push({ op: "remove", path: `/variables/${enc}` });
    } else {
      patches.push({ op: "replace", path: `/variables/${enc}`, value: nv });
    }
  }
  return patches;
};

const buildAccessLogPatches = (
  prev: ag.AccessLogSettings | undefined,
  next: ag.AccessLogSettings | undefined,
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (prev?.destinationArn !== next?.destinationArn) {
    if (
      next?.destinationArn === undefined &&
      prev?.destinationArn !== undefined
    ) {
      patches.push({ op: "remove", path: "/accessLogSettings/destinationArn" });
    } else if (next?.destinationArn !== undefined) {
      patches.push({
        op: "replace",
        path: "/accessLogSettings/destinationArn",
        value: next.destinationArn,
      });
    }
  }
  if (prev?.format !== next?.format) {
    if (next?.format === undefined && prev?.format !== undefined) {
      patches.push({ op: "remove", path: "/accessLogSettings/format" });
    } else if (next?.format !== undefined) {
      patches.push({
        op: "replace",
        path: "/accessLogSettings/format",
        value: next.format,
      });
    }
  }
  return patches;
};

const buildCanaryOverridePatches = (
  prev: { [key: string]: string | undefined } | undefined,
  next: { [key: string]: string | undefined } | undefined,
): ag.PatchOperation[] => {
  const keys = new Set([
    ...Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]);
  const patches: ag.PatchOperation[] = [];
  for (const k of keys) {
    const pv = prev?.[k];
    const nv = next?.[k];
    if (pv === nv) continue;
    const enc = encodeJsonPointerSegment(k);
    if (nv === undefined) {
      patches.push({
        op: "remove",
        path: `/canarySettings/stageVariableOverrides/${enc}`,
      });
    } else {
      patches.push({
        op: "replace",
        path: `/canarySettings/stageVariableOverrides/${enc}`,
        value: nv,
      });
    }
  }
  return patches;
};

const buildCanaryPatches = (
  prev: ag.CanarySettings | undefined,
  next: ag.CanarySettings | undefined,
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (prev?.percentTraffic !== next?.percentTraffic) {
    if (
      next?.percentTraffic === undefined &&
      prev?.percentTraffic !== undefined
    ) {
      patches.push({ op: "remove", path: "/canarySettings/percentTraffic" });
    } else if (next?.percentTraffic !== undefined) {
      patches.push({
        op: "replace",
        path: "/canarySettings/percentTraffic",
        value: String(next.percentTraffic),
      });
    }
  }
  if (prev?.deploymentId !== next?.deploymentId) {
    if (next?.deploymentId === undefined && prev?.deploymentId !== undefined) {
      patches.push({ op: "remove", path: "/canarySettings/deploymentId" });
    } else if (next?.deploymentId !== undefined) {
      patches.push({
        op: "replace",
        path: "/canarySettings/deploymentId",
        value: next.deploymentId,
      });
    }
  }
  if (prev?.useStageCache !== next?.useStageCache) {
    if (next?.useStageCache === undefined) {
      patches.push({ op: "remove", path: "/canarySettings/useStageCache" });
    } else {
      patches.push({
        op: "replace",
        path: "/canarySettings/useStageCache",
        value: String(next.useStageCache),
      });
    }
  }
  patches.push(
    ...buildCanaryOverridePatches(
      prev?.stageVariableOverrides,
      next?.stageVariableOverrides,
    ),
  );
  return patches;
};

const buildStagePatches = (
  prev: ApiGatewayStage["Attributes"],
  news: Input.ResolveProps<StageProps>,
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (news.deploymentId !== prev.deploymentId) {
    patches.push({
      op: "replace",
      path: "/deploymentId",
      value: news.deploymentId as string,
    });
  }
  if (news.description !== prev.description) {
    patches.push({
      op: "replace",
      path: "/description",
      value: news.description ?? "",
    });
  }
  if (news.cacheClusterEnabled !== prev.cacheClusterEnabled) {
    patches.push({
      op: "replace",
      path: "/cacheClusterEnabled",
      value: String(news.cacheClusterEnabled ?? false),
    });
  }
  if (news.cacheClusterSize !== prev.cacheClusterSize) {
    if (news.cacheClusterSize === undefined) {
      patches.push({ op: "remove", path: "/cacheClusterSize" });
    } else {
      patches.push({
        op: "replace",
        path: "/cacheClusterSize",
        value: news.cacheClusterSize,
      });
    }
  }
  if (news.documentationVersion !== prev.documentationVersion) {
    if (news.documentationVersion === undefined) {
      patches.push({ op: "remove", path: "/documentationVersion" });
    } else {
      patches.push({
        op: "replace",
        path: "/documentationVersion",
        value: news.documentationVersion,
      });
    }
  }
  if (news.tracingEnabled !== prev.tracingEnabled) {
    patches.push({
      op: "replace",
      path: "/tracingEnabled",
      value: String(news.tracingEnabled ?? false),
    });
  }
  if (news.webAclArn !== prev.webAclArn) {
    if (news.webAclArn === undefined || news.webAclArn === "") {
      patches.push({ op: "remove", path: "/webAclArn" });
    } else {
      patches.push({
        op: "replace",
        path: "/webAclArn",
        value: news.webAclArn,
      });
    }
  }
  patches.push(...buildVariablePatches(prev.variables, news.variables));
  patches.push(
    ...buildMethodSettingPatches(prev.methodSettings, news.methodSettings),
  );
  patches.push(
    ...buildAccessLogPatches(prev.accessLogSettings, news.accessLogSettings),
  );
  if (!deepEqual(news.canarySettings, prev.canarySettings)) {
    patches.push(
      ...buildCanaryPatches(prev.canarySettings, news.canarySettings),
    );
  }
  return patches;
};

export const StageProvider = () =>
  Provider.effect(
    StageResource,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["restApiId", "stageName"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<StageProps>;
          if (
            news.restApiId !== olds.restApiId ||
            news.stageName !== olds.stageName
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const s = yield* ag
            .getStage({
              restApiId: output.restApiId,
              stageName: output.stageName,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!s?.stageName) return undefined;
          return snapshotStage(s, output.restApiId, s.stageName);
        }),
        create: Effect.fn(function* ({ id, news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Stage props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<StageProps>;
          const internalTags = yield* createInternalTags(id);
          const allTags = { ...news.tags, ...internalTags };

          yield* ag.createStage({
            restApiId: news.restApiId as string,
            stageName: news.stageName,
            deploymentId: news.deploymentId as string,
            description: news.description,
            cacheClusterEnabled: news.cacheClusterEnabled,
            cacheClusterSize: news.cacheClusterSize,
            variables: news.variables,
            documentationVersion: news.documentationVersion,
            canarySettings: news.canarySettings,
            tracingEnabled: news.tracingEnabled,
            tags: allTags,
          });

          const s0 = yield* ag.getStage({
            restApiId: news.restApiId as string,
            stageName: news.stageName,
          });
          const prev = snapshotStage(
            s0,
            news.restApiId as string,
            news.stageName,
          );
          const patches = buildStagePatches(prev, news);
          if (patches.length > 0) {
            yield* ag.updateStage({
              restApiId: news.restApiId as string,
              stageName: news.stageName,
              patchOperations: patches,
            });
          }

          yield* session.note(`Created stage ${news.stageName}`);
          const s = yield* ag.getStage({
            restApiId: news.restApiId as string,
            stageName: news.stageName,
          });
          return snapshotStage(s, news.restApiId as string, news.stageName);
        }),
        update: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Stage props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<StageProps>;
          const patches = buildStagePatches(output, news);
          if (patches.length > 0) {
            yield* ag.updateStage({
              restApiId: output.restApiId,
              stageName: output.stageName,
              patchOperations: patches,
            });
          }

          const internalTags = yield* createInternalTags(id);
          const newTags = { ...news.tags, ...internalTags };
          if (!deepEqual(output.tags, newTags)) {
            const arn = stageArn(awsRegion, output.restApiId, output.stageName);
            yield* syncTags({
              resourceArn: arn,
              oldTags: output.tags,
              newTags,
            });
          }

          yield* session.note(`Updated stage ${output.stageName}`);
          const s = yield* ag.getStage({
            restApiId: output.restApiId,
            stageName: output.stageName,
          });
          return snapshotStage(s, output.restApiId, output.stageName);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteStage({
              restApiId: output.restApiId,
              stageName: output.stageName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted stage ${output.stageName}`);
        }),
      };
    }),
  );
