import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTemplate } from "../core/init.js";
import { NAPKIN_MARKER } from "../utils/vault.js";
import { init } from "./init.js";

let tmpDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-init-test-"));
  // Isolate the global config: init may register the created vault as the
  // default in $XDG_CONFIG_HOME/napkin/config.json — never touch the
  // real user's config.
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg");
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("init command", () => {
  test("creates .napkin/ with config and .obsidian/ as sibling", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(true);

    // .napkin/ holds config
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "config.json"))).toBe(
      true,
    );

    // Config has vault.root pointing to parent
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, NAPKIN_MARKER, "config.json"), "utf-8"),
    );
    expect(config.vault.root).toBe("..");
    expect(config.vault.obsidian).toBe("../.obsidian");

    // .obsidian/ is sibling to .napkin/
    expect(fs.existsSync(path.join(tmpDir, ".obsidian"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".obsidian", "app.json"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(tmpDir, ".obsidian", "daily-notes.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".obsidian", "templates.json")),
    ).toBe(true);

    // No .obsidian/ inside .napkin/
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, ".obsidian"))).toBe(
      false,
    );
  });

  test("reports not created when already initialized", async () => {
    await init({ quiet: true, path: tmpDir });

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(false);
  });

  test("creates config when only .napkin/ dir exists", async () => {
    fs.mkdirSync(path.join(tmpDir, NAPKIN_MARKER));

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(false);

    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "config.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmpDir, ".obsidian"))).toBe(true);
  });

  test("scaffolds template with dirs, files, and NAPKIN.md in project dir", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir, template: "coding" });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(true);
    expect(data.template).toBe("coding");
    expect(data.files).toContain("NAPKIN.md");
    expect(data.files).toContain("decisions/");
    expect(data.files).toContain("guides/");

    // Content in project dir, not .napkin/
    expect(fs.existsSync(path.join(tmpDir, "NAPKIN.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "guides/_about.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Templates/Decision.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmpDir, "Templates/Guide.md"))).toBe(true);

    // NOT inside .napkin/
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "NAPKIN.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "decisions"))).toBe(
      false,
    );
  });

  test("template on existing vault adds template files", async () => {
    await init({ quiet: true, path: tmpDir });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir, template: "company" });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.template).toBe("company");
    expect(fs.existsSync(path.join(tmpDir, "runbooks"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "NAPKIN.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Templates/Runbook.md"))).toBe(true);
  });

  test("scaffolds all 5 templates", async () => {
    const templates = ["coding", "personal", "research", "company", "product"];
    for (const tmpl of templates) {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), `napkin-tmpl-${tmpl}-`),
      );
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) =>
        logs.push(args.map(String).join(" "));
      await init({ json: true, path: dir, template: tmpl });
      console.log = orig;

      const data = JSON.parse(logs.join(""));
      expect(data.created).toBe(true);
      expect(data.template).toBe(tmpl);
      expect(data.files).toContain("NAPKIN.md");
      expect(data.files.length).toBeGreaterThan(3);

      // Content in project dir
      expect(fs.existsSync(path.join(dir, "NAPKIN.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "Templates"))).toBe(true);

      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves existing .obsidian/ content", async () => {
    fs.mkdirSync(path.join(tmpDir, ".obsidian"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".obsidian", "app.json"),
      JSON.stringify({ customSetting: true }),
    );

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "config.json"))).toBe(
      true,
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, NAPKIN_MARKER, "config.json"), "utf-8"),
    );
    expect(config.vault.root).toBe("..");
    expect(config.vault.obsidian).toBe("../.obsidian");

    // Synced napkin config into existing .obsidian/
    expect(
      fs.existsSync(path.join(tmpDir, ".obsidian", "daily-notes.json")),
    ).toBe(true);

    // Original content preserved
    const appJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".obsidian", "app.json"), "utf-8"),
    );
    expect(appJson.customSetting).toBe(true);
    expect(appJson.alwaysUpdateLinks).toBe(true);

    // No .obsidian/ inside .napkin/
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, ".obsidian"))).toBe(
      false,
    );
  });

  test("registers the vault as global default when none is configured", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(true);
    expect(data.defaultVault.set).toBe(true);
    expect(data.defaultVault.configPath).toBe(
      path.join(tmpDir, "xdg", "napkin", "config.json"),
    );

    const globalConfig = JSON.parse(
      fs.readFileSync(data.defaultVault.configPath, "utf-8"),
    );
    expect(globalConfig.vault).toBe(tmpDir);

    // Commands outside the vault now resolve it via the global fallback
    const { findVault } = await import("../utils/vault.js");
    const outside = path.join(tmpDir, "elsewhere");
    fs.mkdirSync(outside);
    expect(findVault(outside).contentPath).toBe(tmpDir);
  });

  test("does not overwrite an existing valid global default", async () => {
    // A pre-existing default vault (e.g. the user's long-term vault)
    const defaultDir = path.join(tmpDir, "default-vault");
    fs.mkdirSync(path.join(defaultDir, NAPKIN_MARKER), { recursive: true });
    fs.writeFileSync(
      path.join(defaultDir, NAPKIN_MARKER, "config.json"),
      JSON.stringify({ vault: { root: ".." } }),
    );
    const configDir = path.join(tmpDir, "xdg", "napkin");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ vault: defaultDir, otherKey: "keep" }),
    );

    await init({ quiet: true, path: tmpDir });

    const globalConfig = JSON.parse(
      fs.readFileSync(path.join(configDir, "config.json"), "utf-8"),
    );
    // Untouched: still points at the pre-existing default, other keys kept
    expect(globalConfig.vault).toBe(defaultDir);
    expect(globalConfig.otherKey).toBe("keep");
  });

  test("replaces a stale global default whose vault no longer exists", async () => {
    const configDir = path.join(tmpDir, "xdg", "napkin");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ vault: path.join(tmpDir, "gone-vault") }),
    );

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.defaultVault.set).toBe(true);
    const globalConfig = JSON.parse(
      fs.readFileSync(path.join(configDir, "config.json"), "utf-8"),
    );
    expect(globalConfig.vault).toBe(tmpDir);
  });

  test("replaces a global config that is invalid JSON", async () => {
    const configDir = path.join(tmpDir, "xdg", "napkin");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{ not json !");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.defaultVault.set).toBe(true);
    const globalConfig = JSON.parse(
      fs.readFileSync(path.join(configDir, "config.json"), "utf-8"),
    );
    expect(globalConfig.vault).toBe(tmpDir);
  });

  test("adds vault field to a global config without one, keeping other keys", async () => {
    const configDir = path.join(tmpDir, "xdg", "napkin");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ theme: "dark" }),
    );

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.defaultVault.set).toBe(true);
    const globalConfig = JSON.parse(
      fs.readFileSync(path.join(configDir, "config.json"), "utf-8"),
    );
    expect(globalConfig.vault).toBe(tmpDir);
    expect(globalConfig.theme).toBe("dark");
  });

  test("reports set:false when a valid default exists elsewhere", async () => {
    const defaultDir = path.join(tmpDir, "default-vault");
    fs.mkdirSync(path.join(defaultDir, NAPKIN_MARKER), { recursive: true });
    fs.writeFileSync(
      path.join(defaultDir, NAPKIN_MARKER, "config.json"),
      JSON.stringify({ vault: { root: ".." } }),
    );
    const configDir = path.join(tmpDir, "xdg", "napkin");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ vault: defaultDir }),
    );

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(true);
    expect(data.defaultVault).toEqual({
      set: false,
      configPath: path.join(configDir, "config.json"),
    });
  });

  test("refuses to initialize inside an existing vault tree", async () => {
    const outer = path.join(tmpDir, "outer");
    fs.mkdirSync(outer, { recursive: true });
    await init({ quiet: true, path: outer });

    const configPath = path.join(tmpDir, "xdg", "napkin", "config.json");
    const before = fs.readFileSync(configPath, "utf-8");

    const subdir = path.join(outer, "subdir");
    fs.mkdirSync(subdir, { recursive: true });

    const orig = process.exit;
    let exitCode: number | undefined;
    const origError = console.error;
    let errMsg = "";
    console.error = (...args: unknown[]) => {
      errMsg = args.map(String).join(" ");
    };
    (process as any).exit = (code: number) => {
      exitCode = code;
      throw new Error("exit");
    };
    try {
      await init({ json: true, path: subdir });
    } catch {
      // expected
    }
    (process as any).exit = orig;
    console.error = origError;

    expect(exitCode).toBe(1);
    expect(errMsg).toContain("Refusing to initialize");
    expect(errMsg).toContain(outer);
    // No nested .napkin/ was created
    expect(fs.existsSync(path.join(subdir, NAPKIN_MARKER))).toBe(false);
    // Global config untouched — still points at the outer vault
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("does not write when the vault already existed", async () => {
    const configDir = path.join(tmpDir, "xdg", "napkin");
    await init({ quiet: true, path: tmpDir });
    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf-8");

    // Second init on the same dir: not created, global config untouched
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(false);
    expect(data.defaultVault).toBeNull();
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("registers as default even with a template on a fresh dir", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await init({ json: true, path: tmpDir, template: "personal" });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.created).toBe(true);
    expect(data.defaultVault.set).toBe(true);
    expect(data.template).toBe("personal");
  });

  test("rejects invalid template name", async () => {
    const orig = process.exit;
    let exitCode: number | undefined;
    (process as any).exit = (code: number) => {
      exitCode = code;
      throw new Error("exit");
    };
    try {
      await init({ json: true, path: tmpDir, template: "doesnotexist" });
    } catch {
      // expected
    }
    (process as any).exit = orig;
    expect(exitCode).toBe(1);
  });

  test("addTemplate on existing vault adds dirs and files", async () => {
    await init({ quiet: true, path: tmpDir });

    const result = addTemplate(tmpDir, "coding");
    expect(result.template).toBe("coding");
    expect(result.files).toContain("decisions/");
    expect(result.files).toContain("NAPKIN.md");
    expect(fs.existsSync(path.join(tmpDir, "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Templates/Decision.md"))).toBe(
      true,
    );
  });

  test("addTemplate composes multiple templates", async () => {
    await init({ quiet: true, path: tmpDir, template: "coding" });

    const result = addTemplate(tmpDir, "company");
    expect(result.template).toBe("company");
    expect(result.files).toContain("runbooks/");
    expect(result.files).not.toContain("NAPKIN.md"); // already exists, skipped
    expect(fs.existsSync(path.join(tmpDir, "runbooks"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Templates/Runbook.md"))).toBe(true);
    // Original coding template files still there
    expect(fs.existsSync(path.join(tmpDir, "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Templates/Decision.md"))).toBe(
      true,
    );
  });

  test("addTemplate throws on uninitialized vault", () => {
    expect(() => addTemplate(tmpDir, "coding")).toThrow(
      "Vault not initialized",
    );
  });

  test("addTemplate throws on unknown template", async () => {
    await init({ quiet: true, path: tmpDir });
    expect(() => addTemplate(tmpDir, "doesnotexist")).toThrow(
      "Unknown template",
    );
  });

  test("sibling layout is default", async () => {
    await init({ quiet: true, path: tmpDir, template: "coding" });

    // .napkin/ holds config only
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "config.json"))).toBe(
      true,
    );

    // .obsidian/ is sibling
    expect(fs.existsSync(path.join(tmpDir, ".obsidian"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".obsidian", "app.json"))).toBe(
      true,
    );

    // Content in project dir
    expect(fs.existsSync(path.join(tmpDir, "NAPKIN.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Templates"))).toBe(true);

    // Nothing inside .napkin/ except config
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "NAPKIN.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, "decisions"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, NAPKIN_MARKER, ".obsidian"))).toBe(
      false,
    );
  });
});
