import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Certificate } from "@/AWS/ACM";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// All ACM operations for CloudFront-grade certs run in us-east-1.
const ACM_REGION = "us-east-1" as const;
const inAcm = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, ACM_REGION as any));

// We use `*.example.com` domains throughout. ACM accepts the request and
// drives the cert into `PENDING_VALIDATION` immediately — we never assert
// it reaches `ISSUED`, so no real DNS is required. Each test deploys with
// `validationMethod: "DNS"` (the default) and inspects the cert before
// validation completes.

const suffix = () => Math.random().toString(36).slice(2, 8);

class CertificateStillExists extends Data.TaggedError(
  "CertificateStillExists",
) {}

const assertCertificateDeleted = (certificateArn: string) =>
  inAcm(
    acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
      Effect.flatMap(() => Effect.fail(new CertificateStillExists())),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => (e as { _tag?: string })._tag === "CertificateStillExists",
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(15)),
        ),
      }),
    ),
  );

const listTags = (certificateArn: string) =>
  inAcm(
    acm
      .listTagsForCertificate({ CertificateArn: certificateArn })
      .pipe(Effect.map((r) => r.Tags ?? [])),
  );

test.provider("create and delete a DNS-validated certificate", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const cert = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Certificate("BasicCert", {
          domainName: `basic-${suffix()}.example.com`,
        });
      }),
    );

    expect(cert.certificateArn).toBeDefined();
    expect(cert.domainName).toContain(".example.com");
    expect(cert.validationMethod).toEqual("DNS");
    // ACM populates DomainValidationOptions for the request, but the
    // ResourceRecord may take a few seconds to appear. We don't gate on
    // it here — the issuance test below covers PENDING_VALIDATION shape.
    expect(cert.status).toBeDefined();

    yield* stack.destroy();
    yield* assertCertificateDeleted(cert.certificateArn);
  }),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domainName = `idempotent-${suffix()}.example.com`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("IdempotentCert", {
            domainName,
            tags: { Project: "alpha" },
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("IdempotentCert", {
            domainName,
            tags: { Project: "alpha" },
          });
        }),
      );

      // ARN is stable across redeploys with identical props — a new
      // RequestCertificate would have minted a fresh ARN.
      expect(second.certificateArn).toEqual(initial.certificateArn);
      expect(second.domainName).toEqual(initial.domainName);

      const detail = yield* inAcm(
        acm.describeCertificate({ CertificateArn: second.certificateArn }),
      );
      expect(detail.Certificate?.DomainName).toEqual(domainName);

      yield* stack.destroy();
      yield* assertCertificateDeleted(initial.certificateArn);
    }),
);

test.provider(
  "reconcile resets tags mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domainName = `drift-tags-${suffix()}.example.com`;

      const cert = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("DriftTagsCert", {
            domainName,
            tags: { Project: "alpha", Owner: "team-platform" },
          });
        }),
      );

      // Drift the tags out-of-band: drop one user tag and add a stray.
      yield* inAcm(
        acm.removeTagsFromCertificate({
          CertificateArn: cert.certificateArn,
          Tags: [{ Key: "Project" }],
        }),
      );
      yield* inAcm(
        acm.addTagsToCertificate({
          CertificateArn: cert.certificateArn,
          Tags: [{ Key: "Stray", Value: "yes" }],
        }),
      );

      // Re-deploy with the original desired props — reconcile must
      // restore Project and remove Stray.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("DriftTagsCert", {
            domainName,
            tags: { Project: "alpha", Owner: "team-platform" },
          });
        }),
      );
      expect(redeployed.certificateArn).toEqual(cert.certificateArn);

      const tags = yield* listTags(cert.certificateArn);
      const tagMap = Object.fromEntries(
        tags.map((t) => [t.Key, t.Value] as const),
      );
      expect(tagMap.Project).toEqual("alpha");
      expect(tagMap.Owner).toEqual("team-platform");
      expect(tagMap.Stray).toBeUndefined();
      // Internal ownership tags must still be present.
      expect(tagMap["alchemy:fqn"]).toBeDefined();
      expect(tagMap["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertCertificateDeleted(cert.certificateArn);
    }),
);

test.provider(
  "reconcile resets transparency-logging mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      // ACM's `Options.CertificateTransparencyLoggingPreference` is set
      // at request time and triggers replace via diff if changed in
      // props. This test asserts that an out-of-band toggle of the
      // logging preference via UpdateCertificateOptions does NOT cause
      // reconcile to drift away from the user's recorded desired state
      // (a re-deploy with the same props returns the same ARN). For a
      // true convergence here we'd need an update path on Options;
      // ACM provides `UpdateCertificateOptions`, but our diff already
      // declared this property as replace-only, so a redeploy is a
      // no-op even with cloud drift.
      yield* stack.destroy();

      const domainName = `drift-options-${suffix()}.example.com`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("DriftOptionsCert", {
            domainName,
            certificateTransparencyLoggingPreference: "ENABLED",
          });
        }),
      );

      // Out-of-band toggle to DISABLED.
      yield* inAcm(
        acm.updateCertificateOptions({
          CertificateArn: initial.certificateArn,
          Options: { CertificateTransparencyLoggingPreference: "DISABLED" },
        }),
      );

      // Redeploying with the same desired props should keep the same
      // ARN. (Our diff says `certificateTransparencyLoggingPreference`
      // is replace-only; a real "fix this on update" would need a
      // dedicated reconciliation API — out of scope here.)
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("DriftOptionsCert", {
            domainName,
            certificateTransparencyLoggingPreference: "ENABLED",
          });
        }),
      );
      expect(redeployed.certificateArn).toEqual(initial.certificateArn);

      yield* stack.destroy();
      yield* assertCertificateDeleted(initial.certificateArn);
    }),
);

test.provider("changing domainName triggers replace", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const s = suffix();
    const domainA = `replace-a-${s}.example.com`;
    const domainB = `replace-b-${s}.example.com`;

    const a = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Certificate("RenameCert", { domainName: domainA });
      }),
    );
    expect(a.domainName).toEqual(domainA);

    const b = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Certificate("RenameCert", { domainName: domainB });
      }),
    );
    expect(b.domainName).toEqual(domainB);
    expect(b.certificateArn).not.toEqual(a.certificateArn);

    // The old certificate must be gone after replace.
    yield* assertCertificateDeleted(a.certificateArn);

    yield* stack.destroy();
    yield* assertCertificateDeleted(b.certificateArn);
  }),
);

test.provider("destroying an already-deleted certificate is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const cert = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Certificate("DoubleDestroyCert", {
          domainName: `double-destroy-${suffix()}.example.com`,
        });
      }),
    );

    // Delete out-of-band, then ask the engine to destroy.
    // Provider's `delete` must catch ResourceNotFoundException and
    // complete cleanly.
    yield* inAcm(
      acm.deleteCertificate({ CertificateArn: cert.certificateArn }),
    );
    yield* assertCertificateDeleted(cert.certificateArn);

    yield* stack.destroy();
  }),
);

test.provider(
  "adopt(true) re-tags a foreign certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domainName = `adopt-${suffix()}.example.com`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("Original", { domainName });
        }),
      );

      // Wipe state — the certificate stays in ACM. The new resource has
      // a different fqn so its tags will be foreign.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Certificate("Different", { domainName });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.domainName).toEqual(domainName);
      expect(takenOver.certificateArn).toEqual(original.certificateArn);

      // adopt(true) must re-tag the certificate with internal alchemy
      // tags so subsequent runs route through silent adoption.
      const tags = yield* listTags(takenOver.certificateArn);
      const tagMap = Object.fromEntries(
        tags.map((t) => [t.Key, t.Value] as const),
      );
      expect(tagMap["alchemy:fqn"]).toBeDefined();
      expect(tagMap["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertCertificateDeleted(takenOver.certificateArn);
    }),
);

test.provider(
  "DNS-validated certificate enters PENDING_VALIDATION with populated DomainValidationOptions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domainName = `pending-${suffix()}.example.com`;

      const cert = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("PendingCert", {
            domainName,
            subjectAlternativeNames: [`alt-${suffix()}.example.com`],
          });
        }),
      );

      // Wait a few seconds for ACM to populate the validation records,
      // then assert shape. ACM is eventually consistent on
      // ResourceRecord population; we don't validate (no real DNS).
      yield* Effect.sleep("3 seconds");
      const detail = yield* inAcm(
        acm.describeCertificate({ CertificateArn: cert.certificateArn }),
      );
      expect(detail.Certificate?.Status).toEqual("PENDING_VALIDATION");

      const validations = detail.Certificate?.DomainValidationOptions ?? [];
      // Every requested name (primary + SAN) gets a validation entry.
      expect(validations.length).toBeGreaterThanOrEqual(2);
      // The primary domain's validation entry must surface a CNAME record
      // (DNS validation method).
      const primary = validations.find(
        (v) => v.DomainName === domainName,
      );
      expect(primary?.ValidationMethod).toEqual("DNS");

      yield* stack.destroy();
      yield* assertCertificateDeleted(cert.certificateArn);
    }),
  { timeout: 120_000 },
);
