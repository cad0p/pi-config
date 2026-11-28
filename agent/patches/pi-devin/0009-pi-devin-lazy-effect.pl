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
# /devin refresh once the extension is loaded (the cold entry point handles it itself)
s{const USAGE = "Usage: /devin, /devin recommended}{const USAGE = "Usage: /devin, /devin refresh, /devin recommended};
s{(  const tokens = args\.trim\(\)\.split\(/\\s\+/\)\.filter\(Boolean\);\n)(  if \(tokens\.length\) \{)}{$1  // local patch 0009: fetch the model list now (the cold entry point refreshes it on its own at most daily).
  if (tokens.length === 1 && tokens[0] === "refresh") {
    const result = yield* Effect.tryPromise({ try: () => ctx.modelRegistry.refresh({ providers: ["devin"], allowNetwork: true, force: true }), catch: toDevinFailure });
    const failure = result.errors.get("devin") as (Error & { cause?: Error }) | undefined;
    const count = ctx.modelRegistry.getAll().filter((model) => model.provider === "devin").length;
    ctx.ui.notify(failure ? "Devin model list refresh failed: " + (failure.cause?.message ?? failure.message) : "Devin model list refreshed: " + count + " models.", failure ? "error" : "info");
    return;
  }
$2};
s{\nconst fusionCommand = \(}{\n// local patch 0009: the entry point calls this after the lazy load.
export const fusionCommand = (};
