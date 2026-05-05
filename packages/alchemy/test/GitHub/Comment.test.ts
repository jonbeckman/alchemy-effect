import { Octokit } from "@octokit/rest";
import * as GitHub from "@/GitHub";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const TEST_OWNER = process.env.GITHUB_TEST_OWNER;
const TEST_REPO = process.env.GITHUB_TEST_REPO;
const TEST_ISSUE = process.env.GITHUB_TEST_ISSUE_NUMBER
  ? Number(process.env.GITHUB_TEST_ISSUE_NUMBER)
  : undefined;
const TEST_ISSUE_2 = process.env.GITHUB_TEST_ISSUE_NUMBER_2
  ? Number(process.env.GITHUB_TEST_ISSUE_NUMBER_2)
  : undefined;
const TEST_TOKEN =
  process.env.GITHUB_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN;

const skip = !TEST_OWNER || !TEST_REPO || !TEST_ISSUE || !TEST_TOKEN;
const skipReplace = skip || !TEST_ISSUE_2;

const { test } = Test.make({ providers: GitHub.providers() });

const octokit = () => new Octokit({ auth: TEST_TOKEN });

const tag = (suffix: string) =>
  `<!-- alchemy-test ${suffix} ${Math.random()
    .toString(36)
    .slice(2, 8)} -->`;

const readComment = (commentId: number) =>
  Effect.tryPromise(async () => {
    try {
      const { data } = await octokit().rest.issues.getComment({
        owner: TEST_OWNER!,
        repo: TEST_REPO!,
        comment_id: commentId,
      });
      return data;
    } catch (e: any) {
      if (e.status === 404) return undefined;
      throw e;
    }
  });

const deleteComment = (commentId: number) =>
  Effect.tryPromise(async () => {
    try {
      await octokit().rest.issues.deleteComment({
        owner: TEST_OWNER!,
        repo: TEST_REPO!,
        comment_id: commentId,
      });
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }
  });

test.provider.skipIf(skip)(
  "redeploy with same props is a no-op (updatedAt preserved)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const body = `${tag("noop")} hello`;

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body,
            allowDelete: true,
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body,
            allowDelete: true,
          });
        }),
      );
      expect(second.commentId).toEqual(first.commentId);
      expect(second.updatedAt).toEqual(first.updatedAt);

      yield* stack.destroy();
      const after = yield* readComment(first.commentId);
      expect(after).toBeUndefined();
    }),
);

test.provider.skipIf(skip)(
  "reconcile resets body mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const marker = tag("drift");
      const desired = `${marker} desired`;

      const c = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body: desired,
            allowDelete: true,
          });
        }),
      );

      // Mutate out-of-band.
      yield* Effect.tryPromise(() =>
        octokit().rest.issues.updateComment({
          owner: TEST_OWNER!,
          repo: TEST_REPO!,
          comment_id: c.commentId,
          body: `${marker} drifted`,
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body: desired,
            allowDelete: true,
          });
        }),
      );

      const observed = yield* readComment(c.commentId);
      expect(observed?.body).toContain("desired");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "reconcile re-creates a comment deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const body = `${tag("recreate")} hello`;

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body,
            allowDelete: true,
          });
        }),
      );
      yield* deleteComment(first.commentId);

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body,
            allowDelete: true,
          });
        }),
      );
      expect(second.commentId).not.toEqual(first.commentId);
      const observed = yield* readComment(second.commentId);
      expect(observed?.id).toEqual(second.commentId);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skipReplace)(
  "changing issueNumber (target) triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const body = `${tag("replace")} hello`;

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body,
            allowDelete: true,
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE_2!,
            body,
            allowDelete: true,
          });
        }),
      );
      expect(second.commentId).not.toEqual(first.commentId);
      // Old comment was destroyed as part of replace.
      const oldCheck = yield* readComment(first.commentId);
      expect(oldCheck).toBeUndefined();

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "destroying an already-deleted comment is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const body = `${tag("gone")} hello`;

      const c = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Comment("C", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            issueNumber: TEST_ISSUE!,
            body,
            allowDelete: true,
          });
        }),
      );

      yield* deleteComment(c.commentId);
      yield* stack.destroy();
    }),
);
