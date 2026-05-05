import * as route53 from "@distilled.cloud/aws/route-53";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface RecordAliasTarget {
  /**
   * Hosted zone ID for the alias target.
   */
  hostedZoneId: Input<string>;
  /**
   * DNS name for the alias target.
   */
  dnsName: Input<string>;
  /**
   * Whether Route 53 should evaluate target health for the alias.
   * @default false
   */
  evaluateTargetHealth?: boolean;
}

export interface ResolvedRecordAliasTarget {
  hostedZoneId: string;
  dnsName: string;
  evaluateTargetHealth?: boolean;
}

export interface RecordProps {
  /**
   * Hosted zone that owns the record.
   */
  hostedZoneId: string;
  /**
   * Record name.
   */
  name: string;
  /**
   * Record type.
   */
  type: route53.RRType;
  /**
   * TTL in seconds for non-alias records.
   */
  ttl?: number;
  /**
   * Record values for non-alias records.
   */
  records?: string[];
  /**
   * Alias target for alias records.
   */
  aliasTarget?: RecordAliasTarget;
  /**
   * Optional set identifier for weighted, latency, failover, and other routing
   * policies that require unique record identities.
   */
  setIdentifier?: string;
}

export interface Record extends Resource<
  "AWS.Route53.Record",
  RecordProps,
  {
    /**
     * Hosted zone that owns the record.
     */
    hostedZoneId: string;
    /**
     * Fully qualified record name.
     */
    name: string;
    /**
     * Record type.
     */
    type: route53.RRType;
    /**
     * Current TTL for non-alias records.
     */
    ttl: number | undefined;
    /**
     * Current non-alias record values.
     */
    records: string[] | undefined;
    /**
     * Current alias target, when this record is an alias.
     */
    aliasTarget: ResolvedRecordAliasTarget | undefined;
    /**
     * Optional routing set identifier.
     */
    setIdentifier: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Route 53 DNS record set.
 *
 * `Record` manages a single Route 53 record set using `UPSERT` for create and
 * update operations, and waits for Route 53 change propagation before
 * returning.
 *
 * @section Creating Records
 * @example A Record Alias To CloudFront
 * ```typescript
 * const record = yield* Record("WebsiteAlias", {
 *   hostedZoneId: "Z1234567890",
 *   name: "www.example.com",
 *   type: "A",
 *   aliasTarget: {
 *     hostedZoneId: distribution.hostedZoneId,
 *     dnsName: distribution.domainName,
 *   },
 * });
 * ```
 *
 * @example TXT Record
 * ```typescript
 * const record = yield* Record("VerificationRecord", {
 *   hostedZoneId: "Z1234567890",
 *   name: "_acme-challenge.example.com",
 *   type: "TXT",
 *   ttl: 60,
 *   records: ["\"value\""],
 * });
 * ```
 */
export const Record = Resource<Record>("AWS.Route53.Record");

const normalizeHostedZoneId = (hostedZoneId: string) =>
  hostedZoneId.replace(/^\/hostedzone\//, "");

const normalizeName = (name: string) =>
  name.endsWith(".") ? name : `${name}.`;

const toAliasTarget = (
  aliasTarget: route53.AliasTarget | undefined,
): ResolvedRecordAliasTarget | undefined =>
  aliasTarget
    ? {
        hostedZoneId: aliasTarget.HostedZoneId,
        dnsName: aliasTarget.DNSName,
        evaluateTargetHealth: aliasTarget.EvaluateTargetHealth,
      }
    : undefined;

const toRecordSet = (props: RecordProps): route53.ResourceRecordSet => ({
  Name: normalizeName(props.name),
  Type: props.type,
  SetIdentifier: props.setIdentifier,
  TTL: props.aliasTarget ? undefined : props.ttl,
  ResourceRecords: props.aliasTarget
    ? undefined
    : (props.records ?? []).map((Value) => ({ Value })),
  AliasTarget: props.aliasTarget
    ? {
        HostedZoneId: normalizeHostedZoneId(
          props.aliasTarget.hostedZoneId as string,
        ),
        DNSName: normalizeName(props.aliasTarget.dnsName as string),
        EvaluateTargetHealth: props.aliasTarget.evaluateTargetHealth ?? false,
      }
    : undefined,
});

const toAttrs = (
  recordSet: route53.ResourceRecordSet,
  hostedZoneId: string,
) => ({
  hostedZoneId: normalizeHostedZoneId(hostedZoneId),
  name: recordSet.Name,
  type: recordSet.Type,
  ttl: recordSet.TTL,
  records: recordSet.ResourceRecords?.map((record) => record.Value),
  aliasTarget: toAliasTarget(recordSet.AliasTarget),
  setIdentifier: recordSet.SetIdentifier,
});

const recordSetMatches = (
  observed: route53.ResourceRecordSet,
  desired: route53.ResourceRecordSet,
) => {
  if (observed.Name !== desired.Name) return false;
  if (observed.Type !== desired.Type) return false;
  if ((observed.SetIdentifier ?? undefined) !== desired.SetIdentifier)
    return false;
  if ((observed.TTL ?? undefined) !== desired.TTL) return false;
  const observedValues = (observed.ResourceRecords ?? [])
    .map((r) => r.Value)
    .sort();
  const desiredValues = (desired.ResourceRecords ?? [])
    .map((r) => r.Value)
    .sort();
  if (observedValues.length !== desiredValues.length) return false;
  if (observedValues.some((v, i) => v !== desiredValues[i])) return false;
  if ((observed.AliasTarget ?? undefined) === undefined) {
    if ((desired.AliasTarget ?? undefined) !== undefined) return false;
  } else {
    if ((desired.AliasTarget ?? undefined) === undefined) return false;
    const a = observed.AliasTarget!;
    const b = desired.AliasTarget!;
    if (normalizeHostedZoneId(a.HostedZoneId) !== b.HostedZoneId) return false;
    if (normalizeName(a.DNSName) !== b.DNSName) return false;
    if ((a.EvaluateTargetHealth ?? false) !== (b.EvaluateTargetHealth ?? false))
      return false;
  }
  return true;
};

class Route53ChangePending extends Data.TaggedError(
  "Route53ChangePending",
)<{
  changeId: string;
}> {}

class Route53RecordNotVisible extends Data.TaggedError(
  "Route53RecordNotVisible",
)<{
  hostedZoneId: string;
  name: string;
  type: string;
}> {}

export const RecordProvider = () =>
  Provider.effect(
    Record,
    Effect.gen(function* () {
      // PriorRequestNotComplete is thrown when concurrent change batches
      // target the same hosted zone. AWS classifies it as a BadRequestError
      // in the Smithy model, so it's not auto-retried by the AWS retry layer.
      // Wrap each mutating call to retry explicitly with bounded backoff.
      const retryOnConcurrentChange = <A, E, R>(
        eff: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        eff.pipe(
          Effect.retry({
            while: (e) =>
              (e as { _tag?: string })._tag === "PriorRequestNotComplete",
            schedule: Schedule.exponential("250 millis", 2).pipe(
              Schedule.either(Schedule.spaced("4 seconds")),
              Schedule.both(Schedule.recurs(20)),
            ),
          }),
        );

      const waitForChange = Effect.fn("Route53.waitForChange")(function* (
        changeId: string,
      ) {
        return yield* route53.getChange({ Id: changeId }).pipe(
          retryOnConcurrentChange,
          Effect.map((response) => response.ChangeInfo),
          Effect.flatMap((changeInfo) =>
            changeInfo.Status === "INSYNC"
              ? Effect.succeed(changeInfo)
              : Effect.fail(new Route53ChangePending({ changeId })),
          ),
          Effect.retry({
            while: (error) =>
              (error as { _tag?: string })._tag === "Route53ChangePending",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(150)),
            ),
          }),
        );
      });

      const findRecord = Effect.fn("Route53.findRecord")(function* (
        hostedZoneId: string,
        props: Pick<RecordProps, "name" | "type" | "setIdentifier">,
      ) {
        const targetName = normalizeName(props.name);
        const response = yield* route53
          .listResourceRecordSets({
            HostedZoneId: normalizeHostedZoneId(hostedZoneId),
            StartRecordName: targetName,
            StartRecordType: props.type,
            StartRecordIdentifier: props.setIdentifier,
            MaxItems: 100,
          })
          .pipe(
            retryOnConcurrentChange,
            // The hosted zone may have raced away between read and find;
            // treat that the same as a missing record.
            Effect.catchTag("NoSuchHostedZone", () =>
              Effect.succeed(undefined),
            ),
          );

        return response?.ResourceRecordSets.find(
          (recordSet) =>
            recordSet.Name === targetName &&
            recordSet.Type === props.type &&
            (recordSet.SetIdentifier ?? undefined) === props.setIdentifier,
        );
      });

      const upsertRecord = Effect.fn("Route53.upsertRecord")(function* (
        props: RecordProps,
      ) {
        const response = yield* route53
          .changeResourceRecordSets({
            HostedZoneId: normalizeHostedZoneId(props.hostedZoneId),
            ChangeBatch: {
              Comment: "Alchemy Route53 record upsert",
              Changes: [
                {
                  Action: "UPSERT",
                  ResourceRecordSet: toRecordSet(props),
                },
              ],
            },
          })
          .pipe(retryOnConcurrentChange);

        yield* waitForChange(response.ChangeInfo.Id);
      });

      return {
        stables: ["hostedZoneId", "name", "type", "setIdentifier"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            normalizeHostedZoneId(olds.hostedZoneId) !==
              normalizeHostedZoneId(news.hostedZoneId) ||
            normalizeName(olds.name) !== normalizeName(news.name) ||
            olds.type !== news.type ||
            olds.setIdentifier !== news.setIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const recordSet = yield* findRecord(
            output?.hostedZoneId ?? olds!.hostedZoneId,
            {
              name: output?.name ?? olds!.name,
              type: output?.type ?? olds!.type,
              setIdentifier: output?.setIdentifier ?? olds!.setIdentifier,
            },
          );

          if (!recordSet) {
            return undefined;
          }

          return toAttrs(recordSet, output?.hostedZoneId ?? olds!.hostedZoneId);
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe — read the record's current cloud state, then only
          // upsert if it diverges from desired. Skipping the no-op API
          // call avoids racking up `PriorRequestNotComplete` retries
          // when many records share a hosted zone and are deployed in
          // a single pass with no actual changes.
          const desired = toRecordSet(news);
          const observed = yield* findRecord(news.hostedZoneId, news);

          if (observed === undefined || !recordSetMatches(observed, desired)) {
            yield* upsertRecord(news);
          }

          // Re-read so the returned attributes reflect the actual current
          // record (including server-applied defaults) regardless of
          // whether we just wrote. Route53 reads can briefly miss a
          // freshly INSYNC change against a different name server, so
          // retry on a short bounded schedule before declaring failure.
          const finalRecord = yield* findRecord(news.hostedZoneId, news).pipe(
            Effect.flatMap((r) =>
              r
                ? Effect.succeed(r)
                : Effect.fail(
                    new Route53RecordNotVisible({
                      hostedZoneId: news.hostedZoneId,
                      name: normalizeName(news.name),
                      type: news.type,
                    }),
                  ),
            ),
            Effect.retry({
              while: (e) =>
                (e as { _tag?: string })._tag === "Route53RecordNotVisible",
              schedule: Schedule.fixed("2 seconds").pipe(
                Schedule.both(Schedule.recurs(5)),
              ),
            }),
          );

          yield* session.note(`${news.type} ${normalizeName(news.name)}`);
          return toAttrs(finalRecord, news.hostedZoneId);
        }),
        delete: Effect.fn(function* ({ output }) {
          // The record may have been removed out-of-band, or the hosted
          // zone itself may be gone. Both are no-ops for delete.
          //
          // We deliberately do NOT swallow `InvalidChangeBatch` blanket-
          // wide — it covers a spectrum of validation failures (bad TTL,
          // malformed alias target, etc.) and silently dropping those
          // would let a broken delete look successful. Instead, observe
          // the record first; if it's gone, exit cleanly without
          // submitting a change batch at all.
          // `findRecord` already swallows `NoSuchHostedZone` and returns
          // `undefined`, so we don't need to handle it here.
          const observed = yield* findRecord(output.hostedZoneId, {
            name: output.name,
            type: output.type,
            setIdentifier: output.setIdentifier,
          });

          if (!observed) {
            return;
          }

          yield* route53
            .changeResourceRecordSets({
              HostedZoneId: normalizeHostedZoneId(output.hostedZoneId),
              ChangeBatch: {
                Comment: "Alchemy Route53 record delete",
                Changes: [
                  {
                    Action: "DELETE",
                    // Delete must echo the *observed* record exactly,
                    // not the cached `output` shape. Out-of-band drift
                    // (e.g. someone bumped the TTL) would otherwise make
                    // the delete fail with InvalidChangeBatch.
                    ResourceRecordSet: observed,
                  },
                ],
              },
            })
            .pipe(
              retryOnConcurrentChange,
              Effect.flatMap((response) =>
                waitForChange(response.ChangeInfo.Id),
              ),
              Effect.catchTag("NoSuchHostedZone", () => Effect.void),
              // A concurrent delete may have removed the record between
              // our find and our DELETE call — InvalidChangeBatch with
              // "not found" is the only `InvalidChangeBatch` we tolerate.
              Effect.catchTag("InvalidChangeBatch", (error) => {
                const messages = [
                  ...(error.messages ?? []),
                  error.message ?? "",
                ].join(" ");
                if (/not found|but it was not found/i.test(messages)) {
                  return Effect.void;
                }
                return Effect.fail(error);
              }),
            );
        }),
      };
    }),
  );
