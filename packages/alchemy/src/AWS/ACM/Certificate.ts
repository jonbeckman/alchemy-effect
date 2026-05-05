import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";

class ValidationRecordsPending extends Data.TaggedError(
  "ValidationRecordsPending",
) {}
class CertificatePendingValidation extends Data.TaggedError(
  "CertificatePendingValidation",
) {}
class Route53ChangePending extends Data.TaggedError("Route53ChangePending") {}
class CertificateInUse extends Data.TaggedError("CertificateInUse") {}

export interface CertificateProps {
  /**
   * Primary domain name for the certificate.
   */
  domainName: string;
  /**
   * Additional domain names to include on the certificate.
   */
  subjectAlternativeNames?: string[];
  /**
   * Validation method for the certificate request.
   * @default "DNS"
   */
  validationMethod?: acm.ValidationMethod;
  /**
   * Route 53 hosted zone used to auto-create DNS validation records.
   *
   * When provided together with `validationMethod: "DNS"`, the certificate
   * provider will upsert the validation records and wait for issuance.
   */
  hostedZoneId?: string;
  /**
   * Requested key algorithm.
   */
  keyAlgorithm?: acm.KeyAlgorithm;
  /**
   * Certificate transparency logging preference.
   */
  certificateTransparencyLoggingPreference?: "ENABLED" | "DISABLED" | undefined;
  /**
   * User-defined tags to apply to the certificate.
   */
  tags?: Record<string, string>;
}

export interface Certificate extends Resource<
  "AWS.ACM.Certificate",
  CertificateProps,
  {
    /**
     * ARN of the certificate.
     */
    certificateArn: string;
    /**
     * Primary domain name of the certificate.
     */
    domainName: string;
    /**
     * Additional subject alternative names on the certificate.
     */
    subjectAlternativeNames: string[];
    /**
     * Current ACM certificate status.
     */
    status: acm.CertificateStatus | undefined;
    /**
     * ACM-managed domain validation details, including DNS validation records.
     */
    domainValidationOptions: acm.DomainValidation[];
    /**
     * Requested validation method.
     */
    validationMethod: acm.ValidationMethod | undefined;
    /**
     * Requested key algorithm.
     */
    keyAlgorithm: acm.KeyAlgorithm | undefined;
    /**
     * Route 53 hosted zone used for automatic DNS validation, when configured.
     */
    hostedZoneId: string | undefined;
    /**
     * Current tags on the certificate.
     */
    tags: Record<string, string>;
    /**
     * Certificate issue timestamp, when issued.
     */
    issuedAt: Date | undefined;
    /**
     * Certificate expiration timestamp, when issued.
     */
    notAfter: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * An ACM certificate for CloudFront and other AWS endpoints.
 *
 * `Certificate` requests an ACM certificate in `us-east-1`, which is the
 * region required for CloudFront viewer certificates. When `hostedZoneId` is
 * provided for DNS validation, the provider creates or updates the Route 53
 * validation records and waits for the certificate to be issued.
 *
 * @section Requesting Certificates
 * @example DNS-Validated Certificate
 * ```typescript
 * const cert = yield* Certificate("WebsiteCertificate", {
 *   domainName: "www.example.com",
 *   hostedZoneId: "Z1234567890",
 * });
 * ```
 *
 * @example Certificate With SANs
 * ```typescript
 * const cert = yield* Certificate("WebsiteCertificate", {
 *   domainName: "example.com",
 *   subjectAlternativeNames: ["www.example.com"],
 *   hostedZoneId: "Z1234567890",
 * });
 * ```
 */
export const Certificate = Resource<Certificate>("AWS.ACM.Certificate");

export const CertificateProvider = () =>
  Provider.effect(
    Certificate,
    Effect.gen(function* () {
      const describeCertificate = Effect.fn(function* (certificateArn: string) {
        return yield* withAcmRegion(
          acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
            Effect.map((response) => response.Certificate),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          ),
        );
      });

      const listCertificateTags = Effect.fn(function* (certificateArn: string) {
        return yield* withAcmRegion(
          acm.listTagsForCertificate({ CertificateArn: certificateArn }).pipe(
            Effect.map((response) => toTagRecord(response.Tags)),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({}),
            ),
          ),
        );
      });

      // Find any certificate matching the desired domain + SAN combo.
      // Returns the first match plus a flag indicating whether it carries
      // our alchemy ownership tags. Callers branch on `owned` to decide
      // between silent adoption (owned), `Unowned(attrs)` gating, or a
      // greenfield request.
      const findCertificateByDomain = Effect.fn(function* (
        id: string,
        props: CertificateProps,
      ) {
        const listed = yield* withAcmRegion(
          acm.listCertificates({
            Includes: {
              keyTypes: props.keyAlgorithm ? [props.keyAlgorithm] : undefined,
            },
          } as any),
        );

        const summaries =
          listed.CertificateSummaryList?.filter(
            (summary) => summary.DomainName === props.domainName,
          ) ?? [];

        let firstMatch:
          | { detail: acm.CertificateDetail; tags: Record<string, string> }
          | undefined;

        for (const summary of summaries) {
          if (!summary.CertificateArn) {
            continue;
          }
          const detail = yield* describeCertificate(summary.CertificateArn);
          if (!detail?.CertificateArn) {
            continue;
          }
          if (
            detail.DomainName !== props.domainName ||
            JSON.stringify(normalizeSanList(detail.SubjectAlternativeNames)) !==
              JSON.stringify(normalizeSanList(props.subjectAlternativeNames))
          ) {
            continue;
          }
          const tags = yield* listCertificateTags(detail.CertificateArn);
          if (yield* hasAlchemyTags(id, tags)) {
            // Owned match — prefer it over any foreign match we may have
            // recorded earlier.
            return { detail, tags, owned: true as const };
          }
          firstMatch ??= { detail, tags };
        }

        return firstMatch
          ? { ...firstMatch, owned: false as const }
          : undefined;
      });

      // Wait until ACM has populated `ResourceRecord` on every domain
      // validation option. ACM does this asynchronously after
      // `RequestCertificate` returns. Bounded so we don't loop forever
      // if ACM never produces records (would surface as a hard fail).
      const waitForValidationRecords = Effect.fn(function* (
        certificateArn: string,
      ) {
        return yield* describeCertificate(certificateArn).pipe(
          Effect.flatMap((detail) => {
            const validations = detail?.DomainValidationOptions ?? [];
            if (
              validations.length === 0 ||
              validations.some((option) => option.ResourceRecord === undefined)
            ) {
              return Effect.fail(new ValidationRecordsPending());
            }
            return Effect.succeed(detail!);
          }),
          Effect.retry({
            while: (error) => error._tag === "ValidationRecordsPending",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      // Wait for ACM to mark the certificate ISSUED. Only retry while the
      // status is `PENDING_VALIDATION`; terminal failures (`FAILED`,
      // `VALIDATION_TIMED_OUT`) surface immediately. Capped at 10 minutes
      // (60 * 10s) — DNS validation typically completes in under a minute,
      // but we leave headroom for slow Route 53 propagation.
      const waitForIssued = Effect.fn(function* (certificateArn: string) {
        return yield* describeCertificate(certificateArn).pipe(
          Effect.flatMap((detail) => {
            if (!detail?.CertificateArn) {
              return Effect.fail(
                new Error(
                  `Certificate ${certificateArn} disappeared while waiting for issuance`,
                ),
              );
            }
            if (detail.Status === "ISSUED") {
              return Effect.succeed(detail);
            }
            if (isTerminalFailure(detail.Status)) {
              return Effect.fail(
                new Error(
                  `Certificate issuance failed with status ${detail.Status}${detail.FailureReason ? ` (${detail.FailureReason})` : ""}`,
                ),
              );
            }
            return Effect.fail(new CertificatePendingValidation());
          }),
          Effect.retry({
            while: (error) =>
              (error as { _tag?: string })._tag ===
              "CertificatePendingValidation",
            schedule: Schedule.fixed("10 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      // Wait for the Route 53 change to reach INSYNC across all edge
      // locations. Capped at 2 minutes (60 * 2s) — typically takes <30s.
      const waitForChange = Effect.fn(function* (changeId: string) {
        return yield* route53.getChange({ Id: changeId }).pipe(
          Effect.map((response) => response.ChangeInfo),
          Effect.flatMap((changeInfo) =>
            changeInfo.Status === "INSYNC"
              ? Effect.succeed(changeInfo)
              : Effect.fail(new Route53ChangePending()),
          ),
          Effect.retry({
            while: (error) => error._tag === "Route53ChangePending",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      const upsertValidationRecords = Effect.fn(function* (
        hostedZoneId: string,
        certificate: acm.CertificateDetail,
      ) {
        const changes = (certificate.DomainValidationOptions ?? [])
          .flatMap((option) =>
            option.ResourceRecord ? [option.ResourceRecord] : [],
          )
          .map((record) => ({
            Action: "UPSERT" as const,
            ResourceRecordSet: {
              Name: record.Name,
              Type: record.Type,
              TTL: 60,
              ResourceRecords: [{ Value: record.Value }],
            },
          }));

        if (changes.length === 0) {
          return;
        }

        const response = yield* route53.changeResourceRecordSets({
          HostedZoneId: normalizeHostedZoneId(hostedZoneId),
          ChangeBatch: {
            Comment: "Alchemy ACM DNS validation",
            Changes: changes,
          },
        });

        yield* waitForChange(response.ChangeInfo.Id);
      });

      return {
        stables: ["certificateArn"],
        diff: Effect.fn(function* ({ olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          if (
            olds.domainName !== news.domainName ||
            !deepEqual(
              normalizeSanList(olds.subjectAlternativeNames),
              normalizeSanList(news.subjectAlternativeNames),
            ) ||
            (olds.validationMethod ?? defaultValidationMethod) !==
              (news.validationMethod ?? defaultValidationMethod) ||
            olds.hostedZoneId !== news.hostedZoneId ||
            olds.keyAlgorithm !== news.keyAlgorithm ||
            olds.certificateTransparencyLoggingPreference !==
              news.certificateTransparencyLoggingPreference
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // Fast path: cached ARN. We trust output.certificateArn (a stable
          // ID) and just refresh attributes from cloud — no ownership check
          // because the engine recorded this ARN itself.
          if (output?.certificateArn) {
            const detail = yield* describeCertificate(output.certificateArn);
            if (!detail?.CertificateArn) {
              return undefined;
            }
            const tags = yield* listCertificateTags(detail.CertificateArn);
            return toAttrs(olds ?? ({} as CertificateProps), detail, tags);
          }

          // Slow path: state was lost. Search by domain + SAN. If we find
          // a match without our ownership tags, return Unowned(attrs) so
          // the engine gates on `--adopt`/`adopt(true)`.
          if (!olds) return undefined;
          const found = yield* findCertificateByDomain(id, olds);
          if (!found) return undefined;
          const attrs = toAttrs(olds, found.detail, found.tags);
          return found.owned ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          output,
          session,
        }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — find the live certificate. Domain + SAN combo plus
          // alchemy-owned tags identify a certificate uniquely; if we have
          // a cached ARN, prefer that as the fast path. ACM certificates
          // can't be renamed, and most fields trigger replace via diff,
          // so the only real ensure path is "request if no managed
          // certificate exists".
          //
          // We accept any matching cert here (including foreign-tagged):
          // the engine has already passed the adopt gate by this point if
          // `read` returned `Unowned`, so reconciling is safe and the
          // tag-sync block below will reassert ownership.
          let certificate = output?.certificateArn
            ? yield* describeCertificate(output.certificateArn)
            : undefined;
          if (!certificate?.CertificateArn) {
            const found = yield* findCertificateByDomain(id, news);
            certificate = found?.detail;
          }

          // Ensure — request a new certificate if none exists. The
          // `IdempotencyToken` (derived from `instanceId`) makes the
          // request safe to retry.
          if (!certificate?.CertificateArn) {
            certificate = yield* withAcmRegion(
              acm
                .requestCertificate({
                  DomainName: news.domainName,
                  SubjectAlternativeNames: news.subjectAlternativeNames,
                  ValidationMethod:
                    news.validationMethod ?? defaultValidationMethod,
                  KeyAlgorithm: news.keyAlgorithm,
                  Options: news.certificateTransparencyLoggingPreference
                    ? {
                        CertificateTransparencyLoggingPreference:
                          news.certificateTransparencyLoggingPreference,
                      }
                    : undefined,
                  IdempotencyToken: instanceId
                    .replaceAll(/[^a-zA-Z0-9]/g, "")
                    .slice(0, 32),
                  Tags: createTagsList(desiredTags),
                })
                .pipe(
                  Effect.flatMap((response) =>
                    response.CertificateArn
                      ? describeCertificate(response.CertificateArn).pipe(
                          Effect.map((detail) => detail!),
                        )
                      : Effect.fail(
                          new Error(
                            "requestCertificate returned no certificate ARN",
                          ),
                        ),
                  ),
                ),
            );
          }

          if (!certificate?.CertificateArn) {
            return yield* Effect.fail(
              new Error("Failed to obtain ACM certificate"),
            );
          }

          const certificateArn = certificate.CertificateArn;
          yield* session.note(certificateArn);

          // Sync DNS validation. If the user wired a hostedZoneId, ensure
          // validation records are upserted and the cert reaches `ISSUED`.
          // For an already-issued cert this is mostly a fast-path: we only
          // wait for validation records when the cert isn't already issued.
          const shouldAutoValidate =
            (news.validationMethod ?? defaultValidationMethod) === "DNS" &&
            news.hostedZoneId !== undefined;

          if (shouldAutoValidate && certificate.Status !== "ISSUED") {
            const withRecords = yield* waitForValidationRecords(certificateArn);
            yield* upsertValidationRecords(news.hostedZoneId!, withRecords);
            certificate = yield* waitForIssued(certificateArn);
          }

          // Sync tags — diff observed cloud tags against desired so
          // adoption rewrites ownership tags correctly.
          const observedTags = yield* listCertificateTags(certificateArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (upsert.length > 0) {
            yield* withAcmRegion(
              acm.addTagsToCertificate({
                CertificateArn: certificateArn,
                Tags: upsert,
              }),
            );
          }
          if (removed.length > 0) {
            yield* withAcmRegion(
              acm.removeTagsFromCertificate({
                CertificateArn: certificateArn,
                Tags: removed.map((Key) => ({ Key })),
              }),
            );
          }

          // Re-read so the returned attributes reflect any tag mutation.
          const finalTags = yield* listCertificateTags(certificateArn);
          return toAttrs(news, certificate, finalTags);
        }),
        delete: Effect.fn(function* ({ output }) {
          // ACM forbids deleting a certificate that's still attached to
          // an integrated service (CloudFront, ELB, API Gateway, etc.).
          // Detachment is eventually consistent — even after the user
          // removes the association, ACM may continue to surface
          // `ResourceInUseException` for tens of seconds. Bounded retry
          // (5 minutes total) rides this out so a destroy that immediately
          // follows an unwiring of dependencies still converges, while
          // capping us so a cert that's genuinely still in use surfaces
          // a clear error instead of looping forever.
          yield* withAcmRegion(
            acm
              .deleteCertificate({
                CertificateArn: output.certificateArn,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
                Effect.catchTag("ResourceInUseException", () =>
                  Effect.fail(new CertificateInUse()),
                ),
                Effect.retry({
                  while: (e) => e._tag === "CertificateInUse",
                  schedule: Schedule.fixed("5 seconds").pipe(
                    Schedule.both(Schedule.recurs(60)),
                  ),
                }),
              ),
          );
        }),
      };
    }),
  );

const ACM_REGION = "us-east-1" as const;
const defaultValidationMethod = "DNS" as const;

const withAcmRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, ACM_REGION as any));

const normalizeHostedZoneId = (hostedZoneId: string) =>
  hostedZoneId.replace(/^\/hostedzone\//, "");

const normalizeSanList = (names: string[] | undefined) =>
  [...(names ?? [])].sort((a, b) => a.localeCompare(b));

const toTagRecord = (tags: acm.Tag[] | undefined) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = (
  props: CertificateProps,
  detail: acm.CertificateDetail,
  tags: Record<string, string>,
) => ({
  certificateArn: detail.CertificateArn!,
  domainName: detail.DomainName ?? props.domainName,
  subjectAlternativeNames: detail.SubjectAlternativeNames ?? [],
  status: detail.Status,
  domainValidationOptions: detail.DomainValidationOptions ?? [],
  validationMethod: props.validationMethod ?? defaultValidationMethod,
  keyAlgorithm: detail.KeyAlgorithm ?? props.keyAlgorithm,
  hostedZoneId: props.hostedZoneId
    ? normalizeHostedZoneId(props.hostedZoneId)
    : undefined,
  tags,
  issuedAt: detail.IssuedAt,
  notAfter: detail.NotAfter,
});

const isTerminalFailure = (status: acm.CertificateStatus | undefined) =>
  status === "FAILED" || status === "VALIDATION_TIMED_OUT";
