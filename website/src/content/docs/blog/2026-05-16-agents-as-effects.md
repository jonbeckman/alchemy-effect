---
title: Agents as Effects — the third layer
date: 2026-05-16
draft: true
excerpt: Infrastructure-as-Code converges state. Infrastructure-as-Effects unifies runtime and infra. Agents-as-Effects describes systems of agents in the same typed graph — and lets the agents modify themselves the only safe way: by editing code.
---

Alchemy is built in three layers, each one
strictly above the last.

The first is the IaC engine — a reconcile
loop that converges cloud state to whatever
your code says it should be. The second is
Infrastructure-as-Effects: the same program
that *describes* the Worker also *is* the
Worker, so a bucket reference at deploy time
and a bucket call at runtime come from the
same `.bind(...)` ([why](/blog/2026-04-30-bindings)).

The third is what this post is about. We
think of it as Agents-as-Effects: agents and
their prompts living inside the same typed
graph as the resources they touch. And
because the graph is just code, the agents
modify themselves by editing it — not by
issuing imperative API calls.

That last sentence is the whole pitch. The
rest of this post unpacks it.

## What you can write today

You can already build an agent in Alchemy.
The shape, from
[PR #293](https://github.com/alchemy-run/alchemy-effect/pull/293):

```typescript
export const Gateway = Cloudflare.AiGateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});

export default class ChatAgent extends Cloudflare.DurableObjectNamespace<ChatAgent>()(
  "ChatAgent",
  Effect.gen(function* () {
    const ai = yield* Cloudflare.AiGateway.bind(Gateway);
    const model = ai.model({
      client: ai,
      model: "@cf/moonshotai/kimi-k2.6",
      parameters: { temperature: 0.3, maxTokens: 1024 },
    });

    return Effect.gen(function* () {
      const persistence = yield* Chat.Persistence;
      const chat = yield* persistence.getOrCreate("session");
      return {
        send: (prompt: string) =>
          chat.generateText({ prompt }).pipe(Effect.orDie),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          model,
          Chat.layerPersisted({ storeId: "chat" }).pipe(
            Layer.provideMerge(Cloudflare.DurableObjectChatPersistence),
          ),
        ),
      ),
    );
  }),
) {}
```

A Durable Object whose `state.storage` backs
Effect's `Chat.Persistence`, a language
model coming out of an AI Gateway resource,
a `send` RPC method. One program. The
gateway is a resource, the DO is a resource,
the chat history lives in a resource, and
the runtime code that talks to all of them
sits in the same file as the declarations.

## The next layer: prompts that reference resources

The natural next step — what we mean by
"Agents-as-Effects" — is to let the prompt
itself participate in the graph. Alchemy
already has a tagged-template form for
splicing typed `Output<…>` values into
strings:

```typescript
Resource: [Output.interpolate`${bucket.bucketArn}/*`]
```

Lift that into agent prompts and the system
message becomes a node in the graph too:

```typescript
const system = Output.interpolate`
  You are the on-call assistant for ${app.name}.
  When a user asks about an order, look it up in
  the table at ${OrdersTable.tableName}. The
  customer search endpoint is ${SearchWorker.url}.
  Persist conversation summaries to ${Memory.bucketArn}.
`;
```

The interesting part isn't the prompt string —
it's that *every reference inside the
backticks is a typed `Output`*. If `OrdersTable`
is renamed, the prompt's type breaks. If the
table is removed from the stack, the agent
node has no upstream and the planner refuses
the deploy. The prompt is no longer a free-form
string you keep in sync by hand; it's a value
in the same graph as the IAM policies, the
env vars, and the bindings.

Same story for tools: a tool the agent can
call is just a capability binding
([`Binding.Service` + `Binding.Policy`](/blog/2026-04-30-bindings))
that participates in the dependency graph
exactly like `S3.GetObject` does.

The whole thing — model, gateway, tools,
prompt, history store, the Worker that fronts
it — type-checks as a single Effect program.
There is no "agent config" sitting in a YAML
file pretending it doesn't depend on the
infrastructure it actually depends on.

## Code is the only state

Here is the move that makes this more than
just "nice infrastructure for agents."

When agents are normally given the ability
to "manage infrastructure," they get an
imperative tool surface — `create_table`,
`delete_worker`, `update_dns`. The agent
holds a model of what's deployed, decides
what to change, calls a tool, watches for
errors, retries, polls for state, and tries
to keep its mental picture in sync with the
cloud's actual state. That picture drifts.
Recovery is hard. Auditing is harder.

Alchemy already solved that problem for
humans. We don't ask you to call CRUD APIs
in the right order — you declare the desired
state, the reconciler converges to it
([why](/blog/2026-05-04-reconcile)). The
source code *is* the desired state. State
management is the engine's job, not yours.

Apply the same move to agents.

An agent in this system has exactly one tool
that touches infrastructure: **edit the
code**. Compile it. Run the tests. If both
pass, deploy it. If the deploy succeeds, the
cloud now matches the new code.

```text
agent → edit *.ts → tsc → vitest → alchemy deploy → cloud
```

The agent does not track external state. It
does not poll. It does not decide which API
to call in which order to migrate from
"current shape" to "desired shape." It edits
the file, and the IaC engine does the rest.

Three things drop out of this for free.

**Type checking is the agent's first
feedback signal.** `tsc -b` runs on every
change. Half of the failure modes an
imperative agent has to reason about
post-hoc — wrong ARN shape, missing binding,
stale env var — become compile errors before
the agent ever calls a tool.

**Tests run on the same program.** Because
infra and runtime are the same Effect graph,
the agent's vitest run exercises the actual
handler against the actual bindings (in
their `BackingMemory` form). "Did my change
break the chat agent?" stops being a vibes
question.

**Preview environments are free.** Alchemy
already supports per-stage deploys. The
agent works on a branch, deploys to a fresh
stage, you click a URL, you approve or
reject. The graph that produces production
is the same graph that produces the preview;
the only thing that changes is the stage
name.

## The bootstrap

Now compose these pieces into the actual
product.

`bun alchemy create chat-server` deploys a
Slack-shaped service: a Worker fronting an
HTTP and WebSocket API, a DO per channel
holding message history, a DO per session
holding chat state, an AI Gateway in front of
the model, an R2 bucket for attachments.
Standard Alchemy stack — every node visible
in the plan, every binding type-checked.

The first agent you add is a coding agent.
Its prompt references the stack itself —
the GitHub repo containing this `alchemy.run.ts`,
the test command, the deploy command:

```typescript
const Coder = Cloudflare.DurableObjectNamespace<Coder>()(
  "Coder",
  Effect.gen(function* () {
    const ai = yield* Cloudflare.AiGateway.bind(Gateway);
    const repo = yield* GitHub.Repo.bind(SelfRepo);
    // …
    const system = Output.interpolate`
      You are a coding agent working on ${SelfRepo.fullName}.
      Source of truth is the repository — every change to
      the running service is a code change you author and
      land via a pull request.

      Workflow:
        1. Read the file you need with ${repo.getContents.name}.
        2. Propose a diff via ${repo.createOrUpdateFile.name}.
        3. Open a PR; CI runs tsc + vitest + a preview deploy.
        4. Wait for the human in #${Channel.name} to merge.

      Never call infrastructure APIs directly. You don't have any.
    `;
    // … bind the model, expose a `send` method, etc.
  }),
);
```

The Slack-shaped service has channels and
people, and now it has agents. The agents
have access to the same things people do —
they post in channels, they get pinged, they
read history. The coding agent's "tools" are
GitHub bindings, not infrastructure
bindings. The infrastructure changes
*because the code changes*, not because the
agent decided to call `CreateTable`.

You can iterate from inside the product. Tell
the coding agent in a channel: "add a
moderation agent that watches #general and
flags messages with PII." It opens a PR
adding the new DO, the new prompt, the new
toolkit, the new bindings. CI passes. A
preview link appears in the channel. You
open it, send a test message, see the
moderation agent reply. Merge. Production
deploys.

The whole organization — channels, members,
agents, the policies that govern them — is
one Effect program. Adding an agent is
adding a node. Removing one is deleting
the file. Rerouting one is editing the
prompt's tagged template. Reasoning about
the system is reading the source.

## Why this is the third layer, not the first

You couldn't do this on top of plain
Terraform. The infra would be there but the
runtime wouldn't — the agent's prompt
references resources, but those references
would have to be smuggled in as env vars
and rehydrated at runtime, and the type
checker wouldn't connect the two halves. The
prompt would drift from the schema. The
tools would be defined twice.

You couldn't do this on top of bare Effect
either. Effect would give you the
composition story but not the
cloud-converging engine. You'd be back to
"the agent edits code, then a human runs
`terraform apply`."

You need both: a reconciler underneath
(so the agent doesn't have to manage state),
plus a single typed program above (so the
agent's prompts, tools, and runtime live in
the same graph as the cloud). That's the
shape Alchemy has been climbing toward —
[bindings](/blog/2026-04-30-bindings),
[the unified reconciler](/blog/2026-05-04-reconcile),
[circular references](/blog/2026-04-25-circular-references),
[actions](/blog/2026-05-13-actions) — every
piece in service of being able to put this
layer on top.

That's the announcement. The first two
floors are load-bearing. The third is what
we're building on them, and the building is
an autonomous organization that describes
itself in a single program.

## Where to go next

- [What is Alchemy?](/what-is-alchemy) — the
  framework in two minutes.
- [Bindings — one line, two phases](/blog/2026-04-30-bindings) —
  how the deploy/runtime split that agents
  also use already works for IAM and SDK
  clients.
- [One reconcile, no create vs. update](/blog/2026-05-04-reconcile) —
  why the engine converges state so the
  agent doesn't have to.
- [PR #293](https://github.com/alchemy-run/alchemy-effect/pull/293) —
  the AI Gateway + DO-backed chat
  persistence the first agent is built on.
