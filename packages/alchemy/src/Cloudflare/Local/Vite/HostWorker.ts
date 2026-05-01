/**
 * Source of the workerd-side host worker that backs Cloudflare.Vite in dev.
 *
 * The host runs as a long-lived worker. On each request it asks alchemy
 * (via the CONTROL service binding) for the current Vite-transformed module
 * snapshot, loads it through the worker_loader binding (cached by generation),
 * and forwards the request to the loaded user worker. When alchemy bumps the
 * generation in response to a Vite HMR invalidation, the next request loads a
 * fresh isolate — no workerd restart.
 */
export const hostWorkerSource = /* js */ `
const ENTRYPOINT_HEADER = "x-alchemy-vite-entrypoint";

let cachedStub = null;
let cachedGeneration = null;

async function getStub(env) {
  const snapshotResponse = await env.CONTROL.fetch(
    "http://control.alchemy/__alchemy/vite/snapshot",
  );
  if (!snapshotResponse.ok) {
    throw new Error(
      "alchemy vite control returned " + snapshotResponse.status,
    );
  }
  const snapshot = await snapshotResponse.json();
  if (cachedGeneration === snapshot.generation && cachedStub) {
    return cachedStub;
  }
  const stub = env.LOADER.get("alchemy-vite-user-v" + snapshot.generation, async () => ({
    compatibilityDate: snapshot.compatibilityDate,
    compatibilityFlags: snapshot.compatibilityFlags,
    mainModule: snapshot.mainModule,
    modules: snapshot.modules,
    env: snapshot.env,
    globalOutbound: null,
  }));
  cachedStub = stub;
  cachedGeneration = snapshot.generation;
  return stub;
}

function getEntrypoint(stub, request) {
  const name = request.headers.get(ENTRYPOINT_HEADER);
  return name ? stub.getEntrypoint(name) : stub.getEntrypoint();
}

export default {
  async fetch(request, env, ctx) {
    const stub = await getStub(env);
    const entrypoint = getEntrypoint(stub, request);
    return entrypoint.fetch(request);
  },
  async scheduled(event, env, ctx) {
    const stub = await getStub(env);
    const entrypoint = stub.getEntrypoint();
    if (typeof entrypoint.scheduled === "function") {
      return entrypoint.scheduled(event);
    }
  },
  async queue(batch, env, ctx) {
    const stub = await getStub(env);
    const entrypoint = stub.getEntrypoint();
    if (typeof entrypoint.queue === "function") {
      return entrypoint.queue(batch);
    }
  },
};
`;

export const HOST_WORKER_MODULE_NAME = "host.js";
