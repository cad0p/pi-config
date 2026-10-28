// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Live-oracle fidelity test for the CLI trust mirror
 * (`src/bin/pi-steering.ts`): every mirror function is cross-checked
 * against pi's REAL trust machinery — `dist/core/trust-manager.js`
 * imported by absolute file URL (pi's `exports` map blocks deep
 * package imports, but not file URLs). Runs in the regular suite on
 * every CI run; the weekly drift workflow
 * (`.github/workflows/drift-check.yml`) bumps pi and files a
 * `[drift]` issue if this matrix ever fails against a new pi.
 *
 * Two deliberate divergences are asserted rather than hidden:
 * - the malformed-trust-store case (pi THROWS — pi would crash at
 *   startup; the CLI is a read-only inspector and returns null with a
 *   stderr note instead);
 * - the `dist/main.js` probe is TEXTUAL (soft) — the trust formula
 *   lives inline in `createRuntime`, and importing main.js would pull
 *   in the whole pi surface.
 *
 * Env: HOME + PI_CODING_AGENT_DIR are redirected to a scratch tree at
 * file level (both sides read them at call time) and restored after.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
  hasTrustRequiringProjectResourcesMirror,
  resolveCliProjectTrust,
  trustStoreGetMirror,
} from "./pi-steering.ts";

// ---------------------------------------------------------------------------
// pi live oracle
// ---------------------------------------------------------------------------

interface PiTrustManager {
  hasTrustRequiringProjectResources(cwd: string): boolean;
  ProjectTrustStore: new (
    agentDir: string,
  ) => {
    get(cwd: string): boolean | null;
  };
}

/** Package root of the installed pi (piEntry resolves to dist/index.js). */
function piRootUrl(): URL {
  return new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
}

/**
 * Load pi's real trust-manager by absolute file URL (bypasses pi's
 * `exports` map). Resolution or import failure FAILS this file — a
 * changed pi layout or a missing peer is itself drift worth an issue
 * (D8), never a skip.
 */
function loadPiTrustManager(): Promise<PiTrustManager> {
  try {
    return import(new URL("dist/core/trust-manager.js", piRootUrl()).href);
  } catch (err) {
    throw new Error(
      `cannot import pi's real trust-manager (${
        err instanceof Error ? err.message : String(err)
      }) — pi layout changed or the peer is missing; this is drift ` +
        "worth an issue",
    );
  }
}

const piTrustManager = await loadPiTrustManager();

// ---------------------------------------------------------------------------
// env isolation (file level — node:test runs each file in its own process)
// ---------------------------------------------------------------------------

const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let scratchHome: string;

before(() => {
  // Canonicalize the scratch root once: on macOS TMPDIR lives under
  // the `/var -> /private/var` symlink, so a raw mkdtemp path is not
  // canonical there. With a canonical root, RAW fixture paths are
  // canonical on every runner and store-key/query matching is
  // deterministic; the symlink rows still exercise canonicalization
  // parity on both sides.
  scratchHome = realpathSync(
    mkdtempSync(join(tmpdir(), "pi-steering-fidelity-")),
  );
  process.env.HOME = scratchHome;
  process.env.PI_CODING_AGENT_DIR = join(scratchHome, ".pi", "agent");
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(scratchHome, { recursive: true, force: true });
});

// Fresh scratch tree per test.
afterEach(() => {
  rmSync(scratchHome, { recursive: true, force: true });
  mkdirSync(scratchHome, { recursive: true });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function agentDir(): string {
  return join(scratchHome, ".pi", "agent");
}

/** Create a fresh project dir under the scratch home. */
function newProj(name: string): string {
  const dir = join(scratchHome, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create `<dir>/.pi/<resource>` — a file for dotted names
 * (`settings.json`), a directory otherwise (`extensions`, `skills`).
 */
function withResources(dir: string, resource: string): void {
  const p = join(dir, ".pi", resource);
  if (resource.includes(".")) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{}", "utf8");
  } else {
    mkdirSync(p, { recursive: true });
  }
}

/** Write `<agentDir>/trust.json` with RAW scratch-path keys (both sides canonicalize). */
function writeTrustStore(entries: Record<string, true | false | null>): void {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(
    join(agentDir(), "trust.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
    "utf8",
  );
}

/** Run `fn` with stderr captured; returns everything written to stderr. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Matrix A — resources parity (raw fixture paths fed to both sides)
// ---------------------------------------------------------------------------

describe("fidelity: hasTrustRequiringProjectResourcesMirror vs pi's real one", () => {
  /** Assert parity AND the expected value; both sides' values in every message. */
  function assertResourcesParity(
    cwd: string,
    expected: boolean,
    label: string,
  ): void {
    const mirror = hasTrustRequiringProjectResourcesMirror(cwd);
    const real = piTrustManager.hasTrustRequiringProjectResources(cwd);
    assert.equal(
      mirror,
      real,
      `[A] ${label}: MIRROR/PI DIVERGENCE — mirror=${mirror} ` +
        `pi=${real} (cwd=${cwd})`,
    );
    assert.equal(
      mirror,
      expected,
      `[A] ${label}: mirror=${mirror} pi=${real} — expected ${expected} ` +
        `(cwd=${cwd})`,
    );
  }

  it("bare dir -> false", () => {
    const proj = newProj("bare");
    assertResourcesParity(proj, false, "bare dir");
  });

  it(".pi/settings.json -> true", () => {
    const proj = newProj("res-settings");
    withResources(proj, "settings.json");
    assertResourcesParity(proj, true, ".pi/settings.json");
  });

  it(".pi/extensions/ (directory) -> true", () => {
    const proj = newProj("res-extensions");
    withResources(proj, "extensions");
    assertResourcesParity(proj, true, ".pi/extensions/");
  });

  it(".pi/skills/ (directory) -> true", () => {
    const proj = newProj("res-skills");
    withResources(proj, "skills");
    assertResourcesParity(proj, true, ".pi/skills/");
  });

  it("cwd-level .agents/skills -> true", () => {
    // Skills dir at the query path itself — NOT the excluded
    // $HOME/.agents/skills.
    const proj = newProj("ancestor-skills");
    mkdirSync(join(proj, ".agents", "skills"), { recursive: true });
    assertResourcesParity(proj, true, "cwd-level .agents/skills");
  });

  it("ancestor .agents/skills (parent holds it, query child) -> true", () => {
    // Pins the parent-loop of the resources walk: the skills dir sits
    // at an ANCESTOR of the queried cwd.
    const parent = newProj("ancestor-skills-parent");
    mkdirSync(join(parent, ".agents", "skills"), { recursive: true });
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    assertResourcesParity(child, true, "ancestor .agents/skills");
  });

  it("$HOME/.agents/skills own -> false (excluded)", () => {
    mkdirSync(join(scratchHome, ".agents", "skills"), { recursive: true });
    assertResourcesParity(scratchHome, false, "$HOME/.agents/skills own");
  });

  it("symlinked cwd -> true (canonicalization parity)", () => {
    const target = newProj("res-target");
    withResources(target, "settings.json");
    const link = join(scratchHome, "res-link");
    symlinkSync(target, link);
    assertResourcesParity(link, true, "symlinked cwd");
  });
});

// ---------------------------------------------------------------------------
// Matrix B — store parity (raw scratch-path keys; both sides canonicalize)
// ---------------------------------------------------------------------------

describe("fidelity: trustStoreGetMirror vs pi's ProjectTrustStore.get", () => {
  /** Assert parity AND the expected value; both sides' values in every message. */
  function assertStoreParity(
    cwd: string,
    expected: boolean | null,
    label: string,
  ): void {
    const piStore = new piTrustManager.ProjectTrustStore(agentDir());
    const real = piStore.get(cwd);
    const mirror = trustStoreGetMirror(cwd);
    assert.equal(
      mirror,
      real,
      `[B] ${label}: MIRROR/PI DIVERGENCE — mirror=${mirror} ` +
        `pi=${real} (cwd=${cwd})`,
    );
    assert.equal(
      mirror,
      expected,
      `[B] ${label}: mirror=${mirror} pi=${real} — expected ${expected} ` +
        `(cwd=${cwd})`,
    );
  }

  it("true entry -> both true", () => {
    const proj = newProj("store-true");
    writeTrustStore({ [proj]: true });
    assertStoreParity(proj, true, "true entry");
  });

  it("false entry -> both false", () => {
    const proj = newProj("store-false");
    writeTrustStore({ [proj]: false });
    assertStoreParity(proj, false, "false entry");
  });

  it("null entry -> both null (skipped in the walk)", () => {
    const proj = newProj("store-null");
    writeTrustStore({ [proj]: null });
    assertStoreParity(proj, null, "null entry");
  });

  it("null skipped: parent true + child null, query child -> true", () => {
    // Pins the null-skip semantics: a null entry must NOT stop the
    // ancestor walk, otherwise this row would return null.
    const parent = newProj("store-nullskip");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    writeTrustStore({ [parent]: true, [child]: null });
    assertStoreParity(child, true, "null-skip");
  });

  it("parent-walk: entry at parent dir, query child -> parent's value", () => {
    const parent = newProj("store-parent");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    writeTrustStore({ [parent]: true });
    assertStoreParity(child, true, "parent-walk");
  });

  it("first-wins: nearest entry wins — parent true + child false, query child -> false", () => {
    // pi's findNearestTrustEntry starts the walk AT the query path, so
    // the child's own false entry wins over the parent's true.
    const parent = newProj("store-firstwins");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    writeTrustStore({ [parent]: true, [child]: false });
    assertStoreParity(child, false, "first-wins");
  });

  it("symlink cwd: entry at the canonicalized target key, query the LINK -> both true", () => {
    const target = newProj("store-target");
    const link = join(scratchHome, "store-link");
    symlinkSync(target, link);
    writeTrustStore({ [target]: true });
    assertStoreParity(link, true, "symlink cwd");
  });

  it("missing store -> both null", () => {
    const proj = newProj("store-missing");
    assertStoreParity(proj, null, "missing store");
  });

  it("malformed store: pi THROWS, mirror -> null + stderr note (documented O3 divergence)", () => {
    const proj = newProj("store-malformed");
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(join(agentDir(), "trust.json"), "{ not json", "utf8");
    const piStore = new piTrustManager.ProjectTrustStore(agentDir());
    assert.throws(
      () => piStore.get(proj),
      /Failed to read trust store/,
      "[B] malformed store: pi's get must throw (pi crashes at startup)",
    );
    let mirror: boolean | null = null;
    const stderr = captureStderr(() => {
      mirror = trustStoreGetMirror(proj);
    });
    assert.equal(
      mirror,
      null,
      "[B] malformed store: mirror must return null (read-only inspector)",
    );
    assert.match(
      stderr,
      /pi-steering: trust store .*unreadable; ignoring/,
      "[B] malformed store: mirror must note the unreadable store on stderr",
    );
  });
});

// ---------------------------------------------------------------------------
// Matrix C — formula parity
// ---------------------------------------------------------------------------

describe("fidelity: resolveCliProjectTrust vs pi's real formula", () => {
  /** pi's main.js formula: `!hasTrustRequiringResources || trustStore.get(cwd) === true`. */
  function piFormula(cwd: string): boolean {
    const piStore = new piTrustManager.ProjectTrustStore(agentDir());
    return (
      !piTrustManager.hasTrustRequiringProjectResources(cwd) ||
      piStore.get(cwd) === true
    );
  }

  /** Assert parity AND the expected value; both sides' values in every message. */
  function assertFormulaParity(
    cwd: string,
    expected: boolean,
    label: string,
  ): void {
    const mirror = resolveCliProjectTrust(cwd);
    const real = piFormula(cwd);
    assert.equal(
      mirror,
      real,
      `[C] ${label}: MIRROR/PI DIVERGENCE — mirror=${mirror} ` +
        `pi=${real} (cwd=${cwd})`,
    );
    assert.equal(
      mirror,
      expected,
      `[C] ${label}: mirror=${mirror} pi=${real} — expected ${expected} ` +
        `(cwd=${cwd})`,
    );
  }

  it("no resources + no store -> true", () => {
    const proj = newProj("formula-none");
    assertFormulaParity(proj, true, "no resources, no store");
  });

  it("resources present (.pi/settings.json) + no entry -> false", () => {
    const proj = newProj("formula-untrusted");
    withResources(proj, "settings.json");
    assertFormulaParity(proj, false, "resources, no entry");
  });

  it("resources + store true -> true", () => {
    const proj = newProj("formula-trusted");
    withResources(proj, "settings.json");
    writeTrustStore({ [proj]: true });
    assertFormulaParity(proj, true, "resources + true");
  });

  it("resources + store false -> false", () => {
    const proj = newProj("formula-denied");
    withResources(proj, "settings.json");
    writeTrustStore({ [proj]: false });
    assertFormulaParity(proj, false, "resources + false");
  });
});

// ---------------------------------------------------------------------------
// Textual main.js probe (soft)
// ---------------------------------------------------------------------------

describe("fidelity: pi dist/main.js textual probe (soft)", () => {
  it("still imports the trust-manager pair and wires the formula", () => {
    const mainJs = readFileSync(new URL("dist/main.js", piRootUrl()), "utf8");
    assert.match(
      mainJs,
      /import \{[^}]*hasTrustRequiringProjectResources[^}]*ProjectTrustStore[^}]*\} from "\.\/core\/trust-manager\.js"/,
      "pi changed the trust-manager import shape in dist/main.js — verify " +
        "the mirror and update this literal (the live-oracle matrix above " +
        "is the hard gate)",
    );
    assert.ok(
      mainJs.includes(
        "!hasTrustRequiringResources || trustStore.get(cwd) === true",
      ),
      "pi changed its trust formula in dist/main.js — verify the mirror and " +
        "update this literal (the live-oracle matrix above is the hard gate)",
    );
  });
});
