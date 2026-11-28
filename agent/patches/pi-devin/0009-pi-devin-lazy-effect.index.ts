/**
 * Pi's entry point.
 *
 * local patch 0009: register the provider, the commands and the session hooks from this file, and import
 * the Effect-based extension (src/pi/adapters/pi/registration.ts) only when the session actually uses Devin:
 * a Devin model selected or restored, /devin, /devin-fusion, a sign-in, or a Devin stream. Before that, the
 * model list is served from Pi's own stored catalog (models-store.json) and the Effect runtime is never built.
 * The upstream file is the same registerDevinExtension(pi, productionEnvironment(...)) call at the bottom of ensureLoaded().
 *
 * The stored catalog would never change while the extension is cold, so the two network jobs Pi asks of a cold provider run
 * in a short-lived child process that exits when done (a worker thread would leave its Effect graph resident here):
 * - the catalog refresh, when Pi allows network and the stored list is older than a day, is missing, or /devin refresh forces it;
 * - the daily account check Pi runs as an OAuth refresh (pi-devin never renews the token; it re-checks the account).
 * A Pi that cannot start a Node child (a single-file build or Bun) loads the extension in-process instead.
 *
 * The real provider's list is empty until Pi's first refresh restores it, and Pi checks that list before every call, so a
 * request sent in between fails ("No API provider registered for api: devin-connect"). Until then the real provider
 * answers with the stored list (after another attached instance's list: local patch 0011).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { FUSION_CHILD_ENV } from "./src/pi/features/sidekick/prompts.ts";

/** Same values as src/pi/features/catalog/constants.ts and src/pi/features/runs/state.ts, repeated here so that
 * importing them (and Effect with them) is not what pi pays for at every start. */
const DEVIN_API = "devin-connect";
const DEVIN_STATE_ENTRY = "pi-devin.state.v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

interface StoredModel {
  id: string; name: string; api: string; provider: string; baseUrl: string;
  devin?: { version?: number; scope?: string };
}

/** The catalog Pi stored after this extension's last publication. Read-only, and only the entries of a published list. */
function storedDevinModels(): StoredModel[] {
  try {
    const store = JSON.parse(readFileSync(join(getAgentDir(), "models-store.json"), "utf8")) as Record<string, { models?: unknown }>;
    return publishedModels(store?.devin?.models);
  } catch { return []; }
}

/** The entries of a list this extension published (stored or just persisted), with the same checks for both. */
function publishedModels(models: unknown): StoredModel[] {
  try {
    if (!Array.isArray(models)) return [];
    return models.filter((model): model is StoredModel => Boolean(model) && typeof model === "object"
      && (model as StoredModel).provider === "devin" && (model as StoredModel).api === DEVIN_API
      && typeof (model as StoredModel).id === "string" && typeof (model as StoredModel).baseUrl === "string"
      && (model as StoredModel).devin?.version === 1 && typeof (model as StoredModel).devin?.scope === "string");
  } catch { return []; }
}

/** src/core/protocol/endpoint.ts without Effect: the origin of an HTTPS endpoint, or of loopback HTTP. */
function endpointOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return undefined;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return url.origin;
  } catch { return undefined; }
}

/** src/pi/features/catalog/projection.ts catalogScope() of the host credential, or undefined when it is not usable. */
function scopeOf(credential: unknown): { baseUrl: string; scope: string } | undefined {
  const value = credential as { type?: unknown; refresh?: unknown; expires?: unknown; access?: unknown; devin?: unknown } | undefined;
  if (!value || value.type !== "oauth" || value.refresh !== "" || !Number.isSafeInteger(value.expires) || (value.expires as number) < 0) return undefined;
  const metadata = value.devin as { version?: unknown; apiServerURL?: unknown } | undefined;
  if (!metadata || metadata.version !== 1 || typeof value.access !== "string" || !value.access) return undefined;
  const baseUrl = endpointOf(metadata.apiServerURL);
  if (!baseUrl) return undefined;
  return { baseUrl, scope: createHash("sha256").update(baseUrl + "\0" + value.access).digest("hex") };
}

/** How old the stored catalog may get before a cold provider fetches it again. The loaded catalog keeps its own 5 minutes. */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHILD_TIMEOUT_MS = 60_000;
const PACKAGE_ROOT = new URL("./", import.meta.url).href;

/**
 * The child's program. It loads this package's TypeScript with Node's own type stripper (Node does not strip types under
 * node_modules by itself), refuses any runtime import of Pi's packages, builds the catalog and sign-in services of
 * ProviderLive without inference, answers one request over IPC and exits. Plain JS on purpose: no template literals.
 */
const CHILD_SOURCE = String.raw`
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
const root = process.argv[1];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@earendil-works/")) throw new Error("pi-devin refresh process: runtime import of " + specifier + " from " + context.parentURL);
    const fromEval = !context.parentURL || /\[eval\d*\]$/.test(context.parentURL);
    return next(specifier, fromEval ? { ...context, parentURL: new URL("index.ts", root).href } : context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts")) return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true };
    return next(url, context);
  },
});
process.on("disconnect", () => process.exit(0));
const load = (path) => import(new URL(path, root).href);
async function run(request) {
  const { Layer, ManagedRuntime } = await import("effect");
  const [device, http, platform, files, accounts, guard, login, auth, remote, catalog, clients, lifetime, runs, changes, config] = await Promise.all([
    "src/core/services/device-identity.ts", "src/core/services/http-transport.ts", "src/core/services/platform.ts",
    "src/pi/adapters/storage/files.ts", "src/pi/features/accounts/service.ts", "src/pi/features/auth/guard.ts",
    "src/pi/features/auth/login.ts", "src/pi/features/auth/state.ts", "src/pi/features/catalog/remote.ts",
    "src/pi/features/catalog/service.ts", "src/pi/features/clients/service.ts", "src/pi/features/lifetime/service.ts",
    "src/pi/features/runs/service.ts", "src/pi/features/usage/changes.ts", "src/pi/app/config.ts",
  ].map(load));
  const agentDir = request.agentDir;
  const environment = Layer.mergeAll(
    Layer.succeed(config.ExtensionConfig, { isFusionChild: request.isFusionChild, now: Date.now, login: {}, agentDir: () => agentDir }),
    http.NodeHttpTransport(),
    Layer.succeed(login.LoginTransport, http.nodeTransport()),
    files.FusionSettingsFile(files.fusionSettingsPath(agentDir)),
    files.DisplaySettingsFile(files.devinSettingsPath(agentDir)),
    files.UsageStoreFile(files.accountUsagePath(agentDir)),
  ).pipe(Layer.provideMerge(Layer.mergeAll(device.NodeDeviceIdentitySource.pipe(Layer.provide(platform.NodePlatformLayer)), platform.NodePlatformLayer)));
  const state = Layer.mergeAll(lifetime.ProviderLifetimeLive, auth.AuthStateLive, changes.UsageChangesLive, runs.RunsLive);
  const services = login.AccountLoginLive.pipe(
    Layer.provideMerge(catalog.ModelCatalogLive), Layer.provideMerge(remote.RemoteCatalogLive), Layer.provideMerge(guard.CredentialGuardLive),
    Layer.provideMerge(accounts.AccountsLive), Layer.provideMerge(clients.DevinClientsLive), Layer.provideMerge(state),
  );
  const runtime = ManagedRuntime.make(services.pipe(Layer.provideMerge(environment)));
  try {
    if (request.kind === "oauth-refresh") {
      const accountLogin = await runtime.runPromise(login.AccountLogin);
      return { credential: await runtime.runPromise(accountLogin.refresh(request.credential, new AbortController().signal)) };
    }
    const models = await runtime.runPromise(catalog.ModelCatalog);
    let persist;
    await runtime.runPromise(models.refresh({
      credential: request.credential, stored: request.stored, baseUrl: request.baseUrl, allowNetwork: true, force: request.force,
      signal: new AbortController().signal,
      publish: async (publication) => { if (publication.persist) persist = publication.persist; publication.update?.(); return true; },
    }));
    return { persist };
  } finally {
    await runtime.dispose();
  }
}
process.once("message", async (request) => {
  let reply;
  try { reply = { ok: true, value: await run(request) }; }
  catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  process.send(reply, () => process.exit(0));
});
`;

/** A child needs a Node executable: not a single-file build (its execPath is Pi itself) and not Bun. */
function canStartChild(): boolean {
  return !("bun" in process.versions) && /^node(js)?(\.exe)?$/i.test(basename(process.execPath));
}

type ChildRequest = { kind: "catalog"; credential: unknown; stored?: unknown; baseUrl?: string; force?: boolean } | { kind: "oauth-refresh"; credential: unknown };

/** Runs one request in a fresh child. Rejects on its error, a timeout, an exit without a reply, or `signal`. */
function runInChild(request: ChildRequest, isFusionChild: boolean, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", CHILD_SOURCE, PACKAGE_ROOT], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", windowsHide: true,
    });
    let stderr = "", settled = false;
    child.stderr?.on("data", (chunk) => { if (stderr.length < 4096) stderr += String(chunk); });
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => { child.kill(); finish(() => reject(signal!.reason)); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error("The Devin refresh process timed out."))); }, CHILD_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("message", (reply: { ok: boolean; value?: unknown; error?: string }) =>
      finish(() => reply.ok ? resolve(reply.value) : reject(new Error(reply.error))));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => reject(new Error(`The Devin refresh process exited (${code}) without a reply. ${stderr.trim()}`.trim()))));
    child.send({ ...request, agentDir: getAgentDir(), isFusionChild });
  });
}

/** Resolves with `promise`, or rejects as soon as `signal` aborts; the shared work keeps running for the other callers. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

interface RefreshContext {
  credential?: unknown; stored?: { checkedAt?: unknown }; baseUrl?: string; allowNetwork?: boolean; force?: boolean; signal?: AbortSignal;
  publish(publication: { persist?: { models: unknown[]; checkedAt: number }; update?: () => void }): Promise<boolean>;
}

type LoadedExtension = {
  provider: {
    refreshModels(context: RefreshContext): Promise<void>;
    auth: { oauth: { login(...args: never[]): Promise<unknown>; refresh(...args: never[]): Promise<unknown>; toAuth(...args: never[]): Promise<unknown> } };
    stream(model: Model<any>, context: never, options?: never): AssistantMessageEventStream;
    streamSimple(model: Model<any>, context: never, options?: never): AssistantMessageEventStream;
  };
  runtime: unknown;
  startSession?: (event: unknown, context: ExtensionContext) => void;
};

/** Runs process-wide loads one after another, whichever copy of this module asks. */
function oneLoadAtATime<T>(load: () => Promise<T>): Promise<T> {
  const key = Symbol.for("@buyong/pi-devin/local-patch-0009/load-queue");
  const host = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;
  const next = (host[key] ?? Promise.resolve()).then(load, load);
  host[key] = next.catch(() => undefined);
  return next;
}

/** Pi's entry point. */
export default function devinExtension(pi: ExtensionAPI): void {
  const isFusionChild = process.env[FUSION_CHILD_ENV] === "1";
  const isLead = !isFusionChild;
  let models = storedDevinModels();
  let loaded: LoadedExtension | undefined;
  let loading: Promise<LoadedExtension> | undefined;
  let catalogFetch: Promise<{ persist?: unknown } | undefined> | undefined;
  const disposers: (() => void)[] = [];

  // Pi as the real extension sees it: the provider it registers answers with the stored list while its own is empty.
  const withStoredModels = new Proxy(pi, {
    get: (target, key) => {
      if (key === "registerProvider") return (provider: { getModels(): StoredModel[] }) => {
        const own = provider.getModels;
        // In place: a copy would drop the routing marker the next instance checks for.
        provider.getModels = () => { const list = own(); return list.length > 0 ? list : models; };
        return target.registerProvider(provider as never);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const ensureLoaded = (): Promise<LoadedExtension> => {
    // One load at a time in the process: sessions that load together (subagents switching to Devin at once) raced the
    // module loader, and one of them got a half-initialized module ("reading 'makeExtensionRuntime'").
    loading ??= oneLoadAtATime(async () => {
      const registration = await import("./src/pi/adapters/pi/registration.ts");
      const environment = await import("./src/pi/app/environment.ts");
      // Hand over before the real registration installs its own handlers: one handler per event, never two.
      for (const dispose of disposers.splice(0)) dispose();
      loaded = registration.registerDevinExtension(withStoredModels, environment.productionEnvironment({ isFusionChild })) as unknown as LoadedExtension;
      return loaded;
    }).catch((error: unknown) => { loading = undefined; throw error; });
    return loading;
  };

  /**
   * Loads and, when the session needs its run state, attaches it once the runtime exists. Pi awaits the session_start and
   * model_select handlers that return this, so the session's own instance is attached before its first Devin request:
   * a request that comes earlier reaches the instance another session registered last.
   */
  const warm = (context: ExtensionContext | undefined): Promise<void> =>
    ensureLoaded().then((extension) => extension.startSession?.(undefined, context as ExtensionContext)).catch(() => {});

  /** The message Pi sees when the extension itself cannot load. */
  const errorMessage = (error: unknown): AssistantMessage => ({
    role: "assistant", content: [], api: DEVIN_API, provider: "devin", model: "devin", stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  }) as unknown as AssistantMessage;
  const failedStream = (error: unknown): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream(), message = errorMessage(error);
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
    return stream;
  };

  /** Pi's provider calls return the stream synchronously; until the extension is loaded the events are forwarded. */
  const streamThrough = (kind: "stream" | "streamSimple", model: Model<any>, context: never, options?: never): AssistantMessageEventStream => {
    if (loaded) return loaded.provider[kind](model, context, options);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const extension = await ensureLoaded();
        const inner = extension.provider[kind](model, context, options);
        for await (const event of inner) stream.push(event);
        stream.end(await inner.result().catch(() => undefined));
      } catch (error) {
        const message = errorMessage(error);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    })();
    return stream;
  };

  const oauth = {
    name: "Devin account",
    login: async (...args: never[]) => (await ensureLoaded()).provider.auth.oauth.login(...args),
    // The daily account check. Cold, it runs in a child; loaded, the extension does it itself.
    refresh: async (current: unknown, signal?: AbortSignal) => {
      if (loaded || !canStartChild()) return (await ensureLoaded()).provider.auth.oauth.refresh(current as never, signal as never);
      return (await runInChild({ kind: "oauth-refresh", credential: current }, isFusionChild, signal)).credential;
    },
    toAuth: async (...args: never[]) => (await ensureLoaded()).provider.auth.oauth.toAuth(...args),
  };

  // Registering the same shape registerDevinExtension() registers, so Pi's model registry composes the same provider:
  // the same id, name and OAuth contract, the stored catalog in place of the Effect-owned list, and the same callbacks.
  pi.registerProvider({
    id: "devin", name: "Devin", auth: { oauth },
    getModels: () => models as never,
    filterModels: (candidates: StoredModel[], credential: unknown) => {
      const target = scopeOf(credential);
      if (!target) return [];
      return candidates.filter((model) => model.provider === "devin" && model.api === DEVIN_API
        && model.baseUrl === target.baseUrl && model.devin?.scope === target.scope);
    },
    // Offline, the stored list is the list. With network, a missing, day-old or forced list is fetched in a child and published.
    refreshModels: async (context?: RefreshContext) => {
      models = storedDevinModels();
      if (!context?.allowNetwork || context.signal?.aborted || !scopeOf(context.credential)) return;
      const checkedAt = context.stored?.checkedAt;
      const isFresh = models.length > 0 && typeof checkedAt === "number" && Date.now() - checkedAt < CATALOG_MAX_AGE_MS;
      if (isFresh && !context.force) return;
      if (loaded || !canStartChild()) return (await ensureLoaded()).provider.refreshModels(context);
      catalogFetch ??= runInChild({ kind: "catalog", credential: context.credential, stored: context.stored, baseUrl: context.baseUrl, force: context.force }, isFusionChild)
        .finally(() => { catalogFetch = undefined; });
      const persist = (await untilAborted(catalogFetch, context.signal))?.persist as { models: unknown[]; checkedAt: number } | undefined;
      if (persist) await context.publish({ persist, update: () => { models = publishedModels(persist.models); } });
    },
    stream: (model: Model<any>, context: never, options?: never) => streamThrough("stream", model, context, options),
    streamSimple: (model: Model<any>, context: never, options?: never) => streamThrough("streamSimple", model, context, options),
  } as never);

  const on = (event: string, handler: (event: never, context: ExtensionContext) => void | Promise<void>) => {
    const dispose = (pi as unknown as { on(name: string, handler: unknown): unknown }).on(event, handler);
    if (typeof dispose === "function") disposers.push(dispose as () => void);
  };

  const hasDevinState = (context: ExtensionContext | undefined) => {
    try { return Boolean(context?.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY)); }
    catch { return false; }
  };

  // A session that starts on a Devin model, that carries a Devin run, or whose stored catalog is missing (nothing to
  // list until the real catalog refresh runs) needs the runtime now. Any other session stays cold.
  on("session_start", (_event, context) => {
    if (context?.model?.provider === "devin" || models.length === 0 || hasDevinState(context)) return warm(context);
  });
  on("model_select", (event, context) => {
    if ((event as unknown as { model?: Model<any> }).model?.provider === "devin") return warm(context);
  });
  /** /devin refresh: Pi's own forced refresh of this provider, with the result as a notification. */
  const refreshCommand = async (context: ExtensionContext) => {
    const registry = context.modelRegistry as unknown as {
      refresh(options: object): Promise<{ errors?: Map<string, Error & { cause?: unknown }> }>; getAll(): { provider: string }[];
    };
    const result = await registry.refresh({ providers: ["devin"], allowNetwork: true, force: true });
    const failure = result?.errors?.get("devin");
    const count = registry.getAll().filter((model) => model.provider === "devin").length;
    context.ui.notify(failure ? `Devin model list refresh failed: ${(failure.cause as Error | undefined)?.message ?? failure.message}`
      : `Devin model list refreshed: ${count} models.`, failure ? "error" : "info");
  };

  if (isLead) {
    pi.registerCommand("devin", {
      description: "Show Devin usage and change display settings (recommended models only, usage in the status line); saved globally",
      handler: async (args, context) => {
        // Cold: Pi's refresh reaches refreshModels above, which fetches in a child. Loaded: the same branch in devinCommand.
        if (!loaded && args.trim() === "refresh") return refreshCommand(context as ExtensionContext);
        const extension = await ensureLoaded();
        const command = await import("./src/pi/adapters/pi/devin-command.ts");
        const runtime = extension.runtime as { runPromise<A>(effect: A): Promise<unknown> };
        return runtime.runPromise(command.devinCommand(args, context as never, runtime as never));
      },
    });
    pi.registerCommand("devin-fusion", {
      description: "Choose the lead and sidekick models for Devin Fusion (saved globally)",
      handler: async (args, context) => {
        const extension = await ensureLoaded();
        const command = await import("./src/pi/adapters/pi/fusion-command.ts");
        const runtime = extension.runtime as { runPromise<A>(effect: A): Promise<unknown> };
        return runtime.runPromise(command.fusionCommand(args, context as never, pi));
      },
    });
  }
}
