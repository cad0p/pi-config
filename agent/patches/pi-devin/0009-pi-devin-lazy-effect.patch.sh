#!/bin/sh
# @buyong/pi-devin builds a ManagedRuntime and runSync()s ExtensionConfig, ModelCatalog, Runs, Sidekicks and
# UsageStatus while Pi loads the extension (src/pi/adapters/pi/registration.ts registerDevinExtension), so every
# Pi process carries effect (+30 MB RSS), its own Effect-typed module graph (+30 MB) and protobufjs (+4 MB) even
# when Devin is never used. Pi also calls provider.refreshModels() during the load phase (registerNativeProvider
# -> refresh({ allowNetwork: false })), so "load on first use" only works if the entry point serves the model
# list itself.
#
# Fix: index.ts registers the provider, /devin, /devin-fusion and the two session hooks from plain code: the
# model list is Pi's own stored catalog (models-store.json, the list this extension published last), and the
# Effect extension is imported when the session starts on a Devin model, selects one, carries a Devin run state,
# runs /devin, /devin-fusion, signs in, or streams. registration.ts hands its session-start body back as
# startSession so the session that triggered the load gets attached; the two command bodies are exported for the
# same reason. Behaviour for a session that uses Devin is unchanged; behaviour for a session that never does is
# "nothing happens", as before, minus the imports.
PATCH_ID="0009-pi-devin-lazy-effect"
PATCH_TITLE="pi-devin: load Effect, protobufjs and the runtime only when the session uses Devin"
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/91 (present in @buyong/pi-devin 0.1.16)"
PATCH_REMOVE_WHEN="upstream registers the provider, commands and session hooks from a non-Effect entry point with a cached model list and imports the runtime on first use; or the author rejects the change and the package is dropped from enabledModels"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="index.ts src/pi/adapters/pi/registration.ts src/pi/adapters/pi/devin-command.ts src/pi/adapters/pi/fusion-command.ts"

UNPATCHED_RE="Pi's entry point\\.|pi\\.on\\(\"session_start\", \\(_event, context\\)|^const devinCommand = \\(|^const fusionCommand = \\("
PATCHED_RE="local patch 0009"

# The replacement entry point. Kept in its own variable because PATCH_PERL only substitutes; a whole-file
# replacement of a 12-line file is the smallest edit that keeps every Pi-facing registration synchronous.
NEW_DEVIN_INDEX=$(cat <<'DEVIN_INDEX_EOF'
/**
 * Pi's entry point.
 *
 * local patch 0009: register the provider, the commands and the session hooks from this file, and import
 * the Effect-based extension (src/pi/adapters/pi/registration.ts) only when the session actually uses Devin:
 * a Devin model selected or restored, /devin, /devin-fusion, a sign-in, or a Devin stream. Before that, the
 * model list is served from Pi's own stored catalog (models-store.json) and the Effect runtime is never built.
 * The upstream file is the same registerDevinExtension(pi, productionEnvironment(...)) call at the bottom of ensureLoaded().
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const models = store?.devin?.models;
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

type LoadedExtension = {
  provider: {
    auth: { oauth: { login(...args: never[]): Promise<unknown>; refresh(...args: never[]): Promise<unknown>; toAuth(...args: never[]): Promise<unknown> } };
    stream(model: Model<any>, context: never, options?: never): AssistantMessageEventStream;
    streamSimple(model: Model<any>, context: never, options?: never): AssistantMessageEventStream;
  };
  runtime: unknown;
  startSession?: (event: unknown, context: ExtensionContext) => void;
};

/** Pi's entry point. */
export default function devinExtension(pi: ExtensionAPI): void {
  const isFusionChild = process.env[FUSION_CHILD_ENV] === "1";
  const isLead = !isFusionChild;
  let models = storedDevinModels();
  let loaded: LoadedExtension | undefined;
  let loading: Promise<LoadedExtension> | undefined;
  const disposers: (() => void)[] = [];

  const ensureLoaded = (): Promise<LoadedExtension> => {
    loading ??= (async () => {
      const registration = await import("./src/pi/adapters/pi/registration.ts");
      const environment = await import("./src/pi/app/environment.ts");
      // Hand over before the real registration installs its own handlers: one handler per event, never two.
      for (const dispose of disposers.splice(0)) dispose();
      loaded = registration.registerDevinExtension(pi, environment.productionEnvironment({ isFusionChild })) as unknown as LoadedExtension;
      return loaded;
    })().catch((error: unknown) => { loading = undefined; throw error; });
    return loading;
  };

  /** Starts loading and, when the session needs its run state, attaches it once the runtime exists. */
  const warm = (context: ExtensionContext | undefined) => {
    void ensureLoaded().then((extension) => extension.startSession?.(undefined, context as ExtensionContext)).catch(() => {});
  };

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
    refresh: async (...args: never[]) => (await ensureLoaded()).provider.auth.oauth.refresh(...args),
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
    // No publication: getModels() is the list, and the refresh that would fetch the catalog runs once the runtime exists.
    refreshModels: async () => { models = storedDevinModels(); },
    stream: (model: Model<any>, context: never, options?: never) => streamThrough("stream", model, context, options),
    streamSimple: (model: Model<any>, context: never, options?: never) => streamThrough("streamSimple", model, context, options),
  } as never);

  const on = (event: string, handler: (event: never, context: ExtensionContext) => void) => {
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
    if (context?.model?.provider === "devin" || models.length === 0 || hasDevinState(context)) warm(context);
  });
  on("model_select", (event, context) => {
    if ((event as unknown as { model?: Model<any> }).model?.provider === "devin") warm(context);
  });
  if (isLead) {
    pi.registerCommand("devin", {
      description: "Show Devin usage and change display settings (recommended models only, usage in the status line); saved globally",
      handler: async (args, context) => {
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
DEVIN_INDEX_EOF
)
export NEW_DEVIN_INDEX

PATCH_PERL=$(cat <<'DEVIN_PERL_EOF'
# index.ts -> the lazy entry point (anchor: the upstream file, exactly)
s{\Aimport type \{ ExtensionAPI \} from "\@earendil-works/pi-coding-agent";
import \{ registerDevinExtension \}.*?registerDevinExtension\(pi, productionEnvironment\(\{ isFusionChild \}\)\);\n\}\n\z}{$ENV{NEW_DEVIN_INDEX}."\n"}se;
# registration.ts -> the session-start body as a named function, so a lazy instance can replay it
s{import type \{ ExtensionAPI \} from "\@earendil-works/pi-coding-agent";}{// local patch 0009: the session-start body is a named function, so a lazily loaded instance can replay it for the session that triggered the load.
import type { ExtensionAPI, ExtensionContext } from "\@earendil-works/pi-coding-agent";};
s!\n  pi\.on\("session_start", \(_event, context\) => \{!\n  const startSession = (_event: unknown, context: ExtensionContext) => \{!;
s!    run\(Effect\.andThen\(status\.bind\(context\), status\.update\(context\)\)\);\n  \}\);\n!    run(Effect.andThen(status.bind(context), status.update(context)));
  }
  pi.on("session_start", startSession);
!;
s!  return \{ provider, runtime \};!  return { provider, runtime, startSession };!;
# the two command bodies the entry point calls after the load
s{\nconst devinCommand = \(}{\n// local patch 0009: the entry point calls this after the lazy load.
export const devinCommand = (};
s{\nconst fusionCommand = \(}{\n// local patch 0009: the entry point calls this after the lazy load.
export const fusionCommand = (};
DEVIN_PERL_EOF
)
