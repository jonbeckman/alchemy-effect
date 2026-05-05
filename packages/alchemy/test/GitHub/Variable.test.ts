import { Octokit } from "@octokit/rest";
import { adopt } from "@/AdoptPolicy";
import * as GitHub from "@/GitHub";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const TEST_OWNER = process.env.GITHUB_TEST_OWNER;
const TEST_REPO = process.env.GITHUB_TEST_REPO;
const TEST_TOKEN =
  process.env.GITHUB_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN;

const skip = !TEST_OWNER || !TEST_REPO || !TEST_TOKEN;

const { test } = Test.make({ providers: GitHub.providers() });

const octokit = () => new Octokit({ auth: TEST_TOKEN });

const variableName = (suffix: string) =>
  `ALCHEMY_TEST_VAR_${suffix.replace(/[^A-Z0-9_]/gi, "_").toUpperCase()}`;

const cleanupVariable = Effect.fn(function* (name: string) {
  yield* Effect.tryPromise(async () => {
    try {
      await octokit().rest.actions.deleteRepoVariable({
        owner: TEST_OWNER!,
        repo: TEST_REPO!,
        name,
      });
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }
  });
});

const readVariable = (name: string) =>
  Effect.tryPromise(async () => {
    try {
      const { data } = await octokit().rest.actions.getRepoVariable({
        owner: TEST_OWNER!,
        repo: TEST_REPO!,
        name,
      });
      return data;
    } catch (e: any) {
      if (e.status === 404) return undefined;
      throw e;
    }
  });

test.provider.skipIf(skip)(
  "redeploy with same props is a no-op (updatedAt preserved)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = variableName(
        `noop_${Math.random().toString(36).slice(2, 8)}`,
      );
      yield* cleanupVariable(name);

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name,
            value: "v1",
          });
        }),
      );
      // Tiny delay so `updatedAt` would change if we hit the API again.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name,
            value: "v1",
          });
        }),
      );
      expect(second.updatedAt).toEqual(first.updatedAt);

      yield* stack.destroy();
      const after = yield* readVariable(name);
      expect(after).toBeUndefined();
    }),
);

test.provider.skipIf(skip)(
  "reconcile resets value mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = variableName(
        `drift_${Math.random().toString(36).slice(2, 8)}`,
      );
      yield* cleanupVariable(name);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name,
            value: "desired",
          });
        }),
      );

      // Mutate out-of-band via the raw SDK.
      yield* Effect.tryPromise(() =>
        octokit().rest.actions.updateRepoVariable({
          owner: TEST_OWNER!,
          repo: TEST_REPO!,
          name,
          value: "drifted",
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name,
            value: "desired",
          });
        }),
      );

      const observed = yield* readVariable(name);
      expect(observed?.value).toEqual("desired");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "reconcile re-creates a variable deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = variableName(
        `recreate_${Math.random().toString(36).slice(2, 8)}`,
      );
      yield* cleanupVariable(name);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name,
            value: "v1",
          });
        }),
      );

      // Delete out-of-band.
      yield* cleanupVariable(name);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name,
            value: "v2",
          });
        }),
      );

      const observed = yield* readVariable(name);
      expect(observed?.value).toEqual("v2");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "changing variable name triggers replace (old deleted, new created)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const oldName = variableName(
        `old_${Math.random().toString(36).slice(2, 8)}`,
      );
      const newName = variableName(
        `new_${Math.random().toString(36).slice(2, 8)}`,
      );
      yield* cleanupVariable(oldName);
      yield* cleanupVariable(newName);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name: oldName,
            value: "v",
          });
        }),
      );
      expect((yield* readVariable(oldName))?.value).toEqual("v");

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name: newName,
            value: "v",
          });
        }),
      );

      expect(yield* readVariable(oldName)).toBeUndefined();
      expect((yield* readVariable(newName))?.value).toEqual("v");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "destroying an already-deleted variable is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = variableName(
        `gone_${Math.random().toString(36).slice(2, 8)}`,
      );
      yield* cleanupVariable(name);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Variable("Var", {
            owner: TEST_OWNER!,
            repository: TEST_REPO!,
            name,
            value: "v",
          });
        }),
      );

      // Delete out-of-band, then ask the engine to destroy.
      yield* cleanupVariable(name);
      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "adopt(true) re-claims a foreign variable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = variableName(
        `adopt_${Math.random().toString(36).slice(2, 8)}`,
      );
      yield* cleanupVariable(name);

      // Create a foreign variable directly via the SDK.
      yield* Effect.tryPromise(() =>
        octokit().rest.actions.createRepoVariable({
          owner: TEST_OWNER!,
          repo: TEST_REPO!,
          name,
          value: "foreign",
        }),
      );

      const adopted = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* GitHub.Variable("Var", {
              owner: TEST_OWNER!,
              repository: TEST_REPO!,
              name,
              value: "owned",
            });
          }),
        )
        .pipe(adopt(true));
      expect(adopted.updatedAt).toBeDefined();

      const observed = yield* readVariable(name);
      expect(observed?.value).toEqual("owned");

      // Wipe state — variable stays in GitHub.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Var",
        });
      }).pipe(Effect.provide(stack.state));

      yield* cleanupVariable(name);
    }),
);
