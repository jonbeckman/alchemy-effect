import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { diffTags, normalizeTags } from "../../Tags.ts";

export const restApiArn = (region: string, restApiId: string) =>
  `arn:aws:apigateway:${region}::/restapis/${restApiId}`;

export const stageArn = (
  region: string,
  restApiId: string,
  stageName: string,
) => `arn:aws:apigateway:${region}::/restapis/${restApiId}/stages/${stageName}`;

export const apiKeyArn = (region: string, apiKeyId: string) =>
  `arn:aws:apigateway:${region}::/apikeys/${apiKeyId}`;

export const usagePlanArn = (region: string, usagePlanId: string) =>
  `arn:aws:apigateway:${region}::/usageplans/${usagePlanId}`;

export const domainNameArn = (region: string, domainName: string) =>
  `arn:aws:apigateway:${region}::/domainnames/${domainName}`;

export const vpcLinkArn = (region: string, vpcLinkId: string) =>
  `arn:aws:apigateway:${region}::/vpclinks/${vpcLinkId}`;

export const syncTags = Effect.fn(function* ({
  resourceArn,
  oldTags,
  newTags,
}: {
  resourceArn: string;
  oldTags: Record<string, string>;
  newTags: Record<string, string>;
}) {
  const { removed, upsert } = diffTags(oldTags, newTags);
  if (removed.length > 0) {
    yield* ag
      .untagResource({
        resourceArn,
        tagKeys: removed,
      })
      .pipe(
        Effect.catchTag("NotFoundException", () => Effect.void),
        Effect.catchTag("BadRequestException", () => Effect.void),
      );
  }
  if (upsert.length > 0) {
    yield* ag.tagResource({
      resourceArn,
      tags: normalizeTags(upsert),
    });
  }
});
