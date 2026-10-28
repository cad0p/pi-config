import { describe, expect, test } from "vitest";
import { Napkin } from "../sdk.js";
import { DEFAULT_CONFIG, saveConfig } from "../utils/config.js";
import { createTempVault } from "../utils/test-helpers.js";
import { overview } from "./overview.js";

async function runOverviewJson(
  vault: string,
  opts: Partial<Parameters<typeof overview>[0]> = {},
): Promise<unknown> {
  const captured: unknown[] = [];
  const origLog = console.log;

  try {
    console.log = (...args: unknown[]) => captured.push(...args);
    await overview({
      vault,
      json: true,
      quiet: false,
      copy: false,
      ...opts,
    });
  } finally {
    console.log = origLog;
  }

  return JSON.parse(captured[0] as string);
}

// six near-identical converted-contract subfolders — heavy shared
// boilerplate, rotated so no sentence is in every folder
function documentsFan(parent: string): Record<string, string> {
  const files: Record<string, string> = {};
  const boilerplate = [
    "Lease agreement between landlord and tenant with signature page attached.",
    "Rent schedule and lease term apply as stated in the appendix.",
    "Bank guarantee and insurance certificate are required before occupancy.",
  ];
  for (let i = 0; i < 6; i++) {
    const shared = boilerplate.filter((_, j) => j !== i % 3).join("\n");
    files[`${parent}/tenant-${i}/contract.md`] =
      `# Converted document ${i}\n${shared}\nSuite ${100 + i} on floor ${i}.`;
  }
  return files;
}

function documentsFixture(): Record<string, string> {
  return {
    "procedures/deploy.md":
      "# Deploy checklist\nRun the smoke tests, then promote the build.",
    ...documentsFan("imports/documents"),
  };
}

// amazon/ is a curated depth-1 namespace with a direct note, five depth-2
// children (each with its own direct note), and five homogeneous depth-3
// report folders under each child. Without collapseDepth, each depth-3 fan
// merges into its depth-2 parent and the near-identical depth-2 parents then
// cascade up into amazon; collapseDepth 2 stops after the first hop so the
// depth-2 rows survive with their own fans rolled in.
function amazonCascadeFixture(): Record<string, string> {
  const files: Record<string, string> = {
    "amazon/overview.md": "# Amazon namespace\nCurated top-level namespace.",
  };
  const children = [
    "architecture",
    "changelog",
    "decisions",
    "features",
    "guides",
  ];
  for (const child of children) {
    files[`amazon/${child}/readme.md`] =
      `# ${child} namespace\nCurated ${child} notes.`;
  }
  const boilerplate = [
    "Quarterly report covering the regional office with attached budget summary.",
    "Annual headcount plan with hiring forecasts for the coming year.",
    "Monthly compliance audit with a sign-off checklist appended.",
  ];
  for (const child of children) {
    for (let i = 0; i < 5; i++) {
      const shared = boilerplate.filter((_, j) => j !== i % 3).join("\n");
      files[`amazon/${child}/report-${i}/note.md`] =
        `# Report ${i}\n${shared}\nSuite ${100 + i} on floor ${i}.`;
    }
  }
  return files;
}

// 110 heterogeneous top-level folders; the last three hold 3 notes each.
// Parents are the vault root (depth 0), which is never a collapse target.
function topicFanFixture(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 110; i++) {
    const count = i >= 107 ? 3 : 1;
    for (let n = 0; n < count; n++) {
      files[`topic-${String(i).padStart(3, "0")}/note-${n}.md`] =
        `# Topic ${i}\nNotes about topic number ${i}.`;
    }
  }
  return files;
}

describe("overview", () => {
  test("generates overview for vault with folders", async () => {
    const vault = createTempVault({
      "projects/roadmap.md":
        "---\ntags: [active]\n---\n# Roadmap\nLaunch the product in Q2",
      "projects/design.md": "# Design\nUI mockups and #wireframes",
      "notes/meeting.md": "# Meeting Notes\nDiscussed #hiring timeline",
      "readme.md": "# Welcome\nThis is the vault root",
    });

    const result = (await runOverviewJson(vault.path)) as {
      root: string;
      overview: Array<{ path: string; notes: number; tags: string[] }>;
    };
    // contentPath resolves to the .napkin/ dir (embedded layout fixture)
    expect(result.root).toBe(vault.vaultPath);
    expect(Array.isArray(result.overview)).toBe(true);
    expect(result.overview.length).toBeGreaterThanOrEqual(3);

    const projectsFolder = result.overview.find((f) => f.path === "projects");
    expect(projectsFolder).toBeDefined();
    expect(projectsFolder?.notes).toBe(2);
    expect(projectsFolder?.tags).toContain("active");

    vault.cleanup();
  });

  test("respects depth limit", async () => {
    const vault = createTempVault({
      "a/b/c/deep.md": "# Deep note",
      "top.md": "# Top",
    });

    const result = (await runOverviewJson(vault.path, { depth: "1" })) as {
      overview: Array<{ path: string }>;
    };
    const paths = result.overview.map((f) => f.path);
    expect(paths).not.toContain("a/b/c");

    vault.cleanup();
  });

  test("skips files with malformed YAML frontmatter", async () => {
    const vault = createTempVault({
      "notes/good.md": "---\ntags: [valid]\n---\n# Good note\nHello",
      "notes/bad.md":
        "---\ntags: [#foo, #bar]\n---\n# Bad YAML\nBroken frontmatter",
      "notes/also-good.md": "# No frontmatter\nJust content",
    });

    const warnings: string[] = [];
    const captured: unknown[] = [];
    const origLog = console.log;
    const origError = console.error;

    try {
      // Warnings go to stderr so they never corrupt --json output on stdout.
      console.error = (...args: unknown[]) => {
        const msg = args.map(String).join(" ");
        if (msg.includes("⚠")) warnings.push(msg);
      };
      console.log = (...args: unknown[]) => {
        captured.push(...args);
      };
      await overview({
        vault: vault.path,
        json: true,
        quiet: false,
        copy: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    const result = JSON.parse(captured[0] as string) as {
      overview: Array<{ path: string; notes: number }>;
    };
    const notesFolder = result.overview.find((f) => f.path === "notes");
    expect(notesFolder).toBeDefined();
    // bad.md is skipped for keywords/tags but still counted
    expect(notesFolder?.notes).toBe(3);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("bad.md");

    vault.cleanup();
  });

  test("warns for every file with identical malformed frontmatter", async () => {
    // Regression: gray-matter's parse cache is poisoned by a failed parse,
    // so a second file with byte-identical malformed frontmatter used to
    // silently parse as empty data — no warning, wrong tags/keywords.
    const badContent =
      "---\ntags: [#twin, #copies]\n---\n# Twin\nIdentical broken note.";
    const vault = createTempVault({
      "a/bad.md": badContent,
      "b/bad.md": badContent,
    });

    const warnings: string[] = [];
    const captured: unknown[] = [];
    const origLog = console.log;
    const origError = console.error;

    try {
      console.error = (...args: unknown[]) => {
        const msg = args.map(String).join(" ");
        if (msg.includes("⚠")) warnings.push(msg);
      };
      console.log = (...args: unknown[]) => {
        captured.push(...args);
      };
      await overview({
        vault: vault.path,
        json: true,
        quiet: false,
        copy: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    expect(warnings.length).toBe(2);
    expect(warnings.join("\n")).toContain("a/bad.md");
    expect(warnings.join("\n")).toContain("b/bad.md");

    // and neither file leaks tags from the unparsed frontmatter
    const result = JSON.parse(captured[0] as string) as {
      overview: Array<{ path: string; tags: string[] }>;
    };
    for (const folder of result.overview) {
      expect(folder.tags).not.toContain("twin");
      expect(folder.tags).not.toContain("copies");
    }

    vault.cleanup();
  });

  test("empty vault", async () => {
    const vault = createTempVault({});

    const result = (await runOverviewJson(vault.path)) as {
      overview: unknown[];
    };
    expect(result.overview).toEqual([]);

    vault.cleanup();
  });

  test("excludes scaffold files and folders from overview", async () => {
    const vault = createTempVault({
      "NAPKIN.md": "# Project context\nAlways shown separately as context.",
      "Templates/Decision.md": "# {{title}}\n## Context\n## Decision",
      "decisions/_about.md": "# Decisions\nArchitecture Decision Records.",
      "decisions/postgres.md":
        "# Use PostgreSQL\nPostgreSQL stores ledger entries and merchant balances.",
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; notes: number; keywords: string[] }>;
    };
    const paths = result.overview.map((f) => f.path);
    expect(paths).toEqual(["decisions"]);

    const decisionsFolder = result.overview[0];
    expect(decisionsFolder.notes).toBe(1);
    expect(decisionsFolder.keywords).toContain("postgresql");
    expect(decisionsFolder.keywords).not.toContain("template");
    expect(decisionsFolder.keywords).not.toContain("decisions");

    vault.cleanup();
  });

  test("suppresses repeated structural headings", async () => {
    const vault = createTempVault({
      "decisions/postgres.md": `# Use PostgreSQL
## Context
Ledger writes need transactional storage.
## Decision
Use PostgreSQL for balances.
## Consequences
We operate backups.`,
      "decisions/outbox.md": `# Adopt transactional outbox
## Context
Kafka dual writes lost events.
## Decision
Write outbox events in the database transaction.
## Consequences
Relay latency increases slightly.`,
      "decisions/braintree.md": `# Deprecate Braintree
## Context
Braintree maintenance cost is high.
## Decision
Migrate merchants to Adyen.
## Consequences
Two merchants need migration plans.`,
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; keywords: string[] }>;
    };
    const decisionsFolder = result.overview.find((f) => f.path === "decisions");
    expect(decisionsFolder?.keywords).toContain("postgresql");
    expect(decisionsFolder?.keywords).toContain("outbox");
    expect(decisionsFolder?.keywords).toContain("braintree");
    expect(decisionsFolder?.keywords).not.toContain("context");
    expect(decisionsFolder?.keywords).not.toContain("decision");
    expect(decisionsFolder?.keywords).not.toContain("consequences");

    vault.cleanup();
  });

  test("strips structured noise from converted documents", async () => {
    const vault = createTempVault({
      "contracts/lease.md": `# Lease agreement
DocuSign Envelope ID: AAAA1111-2222-4333-ADAB-BCF123456789
<div align="center">&nbsp;</div>
Tenant leases the third floor. Envelope ID: BBBB2222-3333-4444-EAEC-DEF987654321
Sublease requires landlord approval and a bank guarantee.`,
      "contracts/parking.md": `# Parking addendum
DocuSign Envelope ID: CCCC3333-4444-4555-FADE-CAB456789012
<div align="center">&nbsp;</div>
Reserved parking slots on level B2. Guarantee covers parking fees.`,
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; keywords: string[] }>;
    };
    const folder = result.overview.find((f) => f.path === "contracts");
    expect(folder).toBeDefined();
    const tokens = folder?.keywords.flatMap((k) => k.split(" ")) ?? [];
    // GUID shrapnel ("adeb", "f25", ...) and HTML residue never become keywords
    for (const t of tokens) {
      expect(t).not.toMatch(/^[a-f0-9]{3,8}$/);
      expect(t).not.toBe("div");
      expect(t).not.toBe("align");
      expect(t).not.toBe("nbsp");
    }
    expect(tokens).toContain("guarantee");

    vault.cleanup();
  });

  test("collapses numerous homogeneous sibling folders", async () => {
    const files: Record<string, string> = {
      "procedures/deploy.md":
        "# Deploy checklist\nRun the smoke tests, then promote the build.",
    };
    // six near-identical converted-contract subfolders under imports/ —
    // heavy shared boilerplate, rotated so no sentence is in every folder
    const boilerplate = [
      "Lease agreement between landlord and tenant with signature page attached.",
      "Rent schedule and lease term apply as stated in the appendix.",
      "Bank guarantee and insurance certificate are required before occupancy.",
    ];
    for (let i = 0; i < 6; i++) {
      const shared = boilerplate.filter((_, j) => j !== i % 3).join("\n");
      files[`imports/tenant-${i}/contract.md`] =
        `# Converted document ${i}\n${shared}\nSuite ${100 + i} on floor ${i}.`;
    }
    const vault = createTempVault(files);

    // collapseDepth 1 = upstream-equivalent collapse semantics: this test pins
    // the collapse MECHANISM; the fork's default (collapseDepth 2) protects
    // depth-1 folders and is pinned by the golden snapshot + the defaults test.
    const result = (await runOverviewJson(vault.path, {
      collapseDepth: 1,
    })) as {
      overview: Array<{
        path: string;
        notes: number;
        collapsedFolders?: number;
      }>;
    };
    const paths = result.overview.map((f) => f.path);
    expect(paths).toContain("imports");
    expect(paths).not.toContain("imports/tenant-0");
    const imports = result.overview.find((f) => f.path === "imports");
    expect(imports?.collapsedFolders).toBe(6);
    expect(imports?.notes).toBe(6);
    // curated folder untouched
    expect(paths).toContain("procedures");

    // top-level folders are never collapsed into the root
    expect(paths).not.toContain("/");

    // --no-collapse restores the full listing
    const flat = (await runOverviewJson(vault.path, { collapse: false })) as {
      overview: Array<{ path: string }>;
    };
    expect(flat.overview.map((f) => f.path)).toContain("imports/tenant-0");

    vault.cleanup();
  });

  test("collapses homogeneous siblings under a depth-2 parent", async () => {
    const vault = createTempVault(documentsFixture());

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{
        path: string;
        notes: number;
        collapsedFolders?: number;
      }>;
    };
    const paths = result.overview.map((f) => f.path);
    expect(paths).toContain("imports/documents");
    expect(paths).not.toContain("imports/documents/tenant-0");
    const imports = result.overview.find((f) => f.path === "imports/documents");
    expect(imports?.collapsedFolders).toBe(6);
    expect(imports?.notes).toBe(6);
    // curated folder untouched
    expect(paths).toContain("procedures");

    vault.cleanup();
  });

  test("does not collapse depth-1 parents when collapseDepth is 2", async () => {
    const files: Record<string, string> = {
      "top/overview.md": "# Top namespace\nCurated top-level namespace.",
    };
    // five identical-content subfolders — enough to collapse (>= 5 children,
    // cosine ~1) if depth-1 parents were allowed as merge targets
    for (let i = 0; i < 5; i++) {
      files[`top/a-${i}/note.md`] =
        "# Report\nQuarterly report for the regional office with attached budget summary.";
    }
    const vault = createTempVault(files);

    const result = (await runOverviewJson(vault.path, {
      collapseDepth: 2,
    })) as {
      overview: Array<{ path: string; collapsedFolders?: number }>;
    };
    const paths = result.overview.map((f) => f.path);
    for (let i = 0; i < 5; i++) {
      expect(paths).toContain(`top/a-${i}`);
    }
    const top = result.overview.find((f) => f.path === "top");
    expect(top).toBeDefined();
    expect(top?.collapsedFolders).toBeUndefined();

    vault.cleanup();
  });

  test("collapseDepth 2: depth-2 fans merge, cascade stops at depth 1", async () => {
    const vault = createTempVault(amazonCascadeFixture());

    const result = (await runOverviewJson(vault.path, {
      collapseDepth: 2,
    })) as {
      overview: Array<{
        path: string;
        notes: number;
        collapsedFolders?: number;
      }>;
    };
    const paths = result.overview.map((f) => f.path);

    // each depth-2 child survives as its own row, its depth-3 fan merged in
    for (const child of [
      "architecture",
      "changelog",
      "decisions",
      "features",
      "guides",
    ]) {
      const row = result.overview.find((f) => f.path === `amazon/${child}`);
      expect(row).toBeDefined();
      expect(row?.notes).toBe(6);
      expect(row?.collapsedFolders).toBe(5);
      expect(paths).not.toContain(`amazon/${child}/report-0`);
    }

    // the depth-1 parent never collapses: children stay out of its row
    const amazon = result.overview.find((f) => f.path === "amazon");
    expect(amazon).toBeDefined();
    expect(amazon?.collapsedFolders).toBeUndefined();
    expect(amazon?.notes).toBe(1);

    vault.cleanup();
  });

  test("fork defaults: maxRows 100 caps + collapseDepth 2 protects depth-1 (config contract)", async () => {
    // The fork ships collapseDepth 2 / maxRows 100 as DEFAULT_CONFIG (restored
    // in 0.12.3). The golden "default options" snapshot pins the rendering;
    // this test pins the contract consumers rely on: pi-napkin's session
    // context bloat protection (100-row cap) and the curated top-level
    // taxonomy protection. Upstream-identical behavior (1/0) must be opt-in.
    const cascade = createTempVault(amazonCascadeFixture());
    const def = new Napkin(cascade.path).overview();
    const paths = def.overview.map((f) => f.path);
    // depth-1 amazon survives as a listed row and is NOT a collapse target at
    // the default collapseDepth 2 (cascade stops at depth 1); its depth-2
    // children keep their own rows with their depth-3 fans merged in:
    expect(paths).toContain("amazon");
    const amazon = def.overview.find((f) => f.path === "amazon");
    expect(amazon?.collapsedFolders).toBeUndefined();
    expect(amazon?.notes).toBe(1);
    const arch = def.overview.find((f) => f.path === "amazon/architecture");
    expect(arch).toBeDefined();
    expect(arch?.collapsedFolders).toBe(5);
    expect(arch?.notes).toBe(6);
    cascade.cleanup();

    const fan = createTempVault(topicFanFixture());
    const capped = (await runOverviewJson(fan.path, {})) as {
      overview: unknown[];
      truncated?: { rows: number; notes: number };
    };
    // topicFanFixture has 110 single-note folders (3 of them with 3 notes):
    // default maxRows 100 caps the listing and reports the dropped tail (the
    // 10 path-last 1-note folders).
    expect(capped.overview.length).toBe(100);
    expect(capped.truncated).toEqual({ rows: 10, notes: 10 });
    fan.cleanup();
  });

  test("overview opts override config for collapseDepth and maxRows", async () => {
    // SDK wiring: collapseDepth 1 restores the depth-1 cascade collapse
    const cascade = createTempVault(amazonCascadeFixture());
    const collapsed = new Napkin(cascade.path).overview({ collapseDepth: 1 });
    const amazon = collapsed.overview.find((f) => f.path === "amazon");
    expect(amazon).toBeDefined();
    // 5 depth-2 children, each carrying 5 collapsed depth-3 subfolders
    expect(amazon?.collapsedFolders).toBe(30);
    expect(amazon?.notes).toBe(31);
    expect(collapsed.overview.map((f) => f.path)).not.toContain(
      "amazon/architecture",
    );
    cascade.cleanup();

    // command wiring: maxRows passthrough caps the listing
    const fan = createTempVault(topicFanFixture());
    const capped = (await runOverviewJson(fan.path, { maxRows: 50 })) as {
      overview: unknown[];
      truncated?: { rows: number; notes: number };
    };
    expect(capped.overview.length).toBe(50);
    expect(capped.truncated).toEqual({ rows: 60, notes: 60 });
    fan.cleanup();
  });

  test("sorts by depth then notes desc when capped", async () => {
    const vault = createTempVault({
      "readme.md": "# Welcome\nRoot note.",
      "big/01.md":
        "# Kubernetes\nIngress routing and pod autoscaling policies.",
      "big/02.md": "# Service mesh\nMutual TLS and traffic splitting.",
      "big/03.md": "# Cluster ops\nNode draining and backup schedules.",
      "big/04.md": "# Observability\nPrometheus scraping and alert rules.",
      "big/05.md": "# Storage\nPersistent volumes and snapshots.",
      "medium/01.md": "# Payroll\nTax withholding tables for contractors.",
      "medium/02.md": "# Benefits\nHealth insurance enrollment windows.",
      "medium/03.md": "# Compliance\nLabor law reporting requirements.",
      "small/01.md":
        "# Sourdough\nFermentation schedules and hydration ratios.",
      "nested/deep/01.md":
        "# Telescope\nCollimation steps for reflector optics.",
      "nested/deep/02.md": "# Mount\nPolar alignment and tracking calibration.",
    });

    const result = (await runOverviewJson(vault.path, {
      maxRows: 100,
    })) as {
      overview: Array<{ path: string; notes: number }>;
    };
    expect(result.overview.map((f) => `${f.path}:${f.notes}`)).toEqual([
      "/:1",
      "big:5",
      "medium:3",
      "small:1",
      "nested/deep:2",
    ]);

    vault.cleanup();
  });

  test("caps rows and reports truncation", async () => {
    const vault = createTempVault(topicFanFixture());
    saveConfig(vault.vaultPath, {
      ...DEFAULT_CONFIG,
      overview: { ...DEFAULT_CONFIG.overview, maxRows: 100 },
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; notes: number }>;
      truncated?: { rows: number; notes: number };
    };
    expect(result.overview.length).toBe(100);
    expect(result.truncated).toEqual({ rows: 10, notes: 10 });
    const paths = result.overview.map((f) => f.path);
    // notes-desc beats alphabetical: the 3-note folders sort first despite
    // being alphabetically last, and one-note folders like topic-097 drop
    expect(paths).toContain("topic-107");
    expect(paths).toContain("topic-109");
    expect(paths).not.toContain("topic-097");

    vault.cleanup();
  });

  test("maxRows 0 disables the cap", async () => {
    const vault = createTempVault(topicFanFixture());
    saveConfig(vault.vaultPath, {
      ...DEFAULT_CONFIG,
      overview: { ...DEFAULT_CONFIG.overview, maxRows: 0 },
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; notes: number }>;
      truncated?: { rows: number; notes: number };
    };
    expect(result.overview.length).toBe(110);
    expect(result.truncated).toBeUndefined();

    vault.cleanup();
  });

  test("maxRows counts collapsed rows once and drops after the cut", async () => {
    // two identical 6-child fans collapse into imports/documents and
    // vendor/documents; eight heterogeneous one-note depth-2 rows follow.
    // With maxRows 2 the lexically-earlier fan survives the cut as a single
    // row while the second fan drops with all six of its merged children's
    // notes counted exactly once in truncated.notes.
    const files: Record<string, string> = {
      ...documentsFixture(),
      ...documentsFan("vendor/documents"),
    };
    const topics = [
      "Kubernetes ingress routing and pod autoscaling policies.",
      "Payroll tax withholding tables for hourly contractors.",
      "Sourdough fermentation schedules and hydration ratios.",
      "Telescope collimation steps for reflector optics.",
      "Beehive winterization and varroa mite treatment.",
      "Marathon training splits and lactate threshold pacing.",
      "Canal lock maintenance and water level monitoring.",
      "Greenhouse climate control and irrigation scheduling.",
    ];
    for (let i = 0; i < topics.length; i++) {
      files[`filler-${i}/area/note.md`] = `# Area ${i}\n${topics[i]}`;
    }
    const vault = createTempVault(files);

    const result = (await runOverviewJson(vault.path, { maxRows: 2 })) as {
      overview: Array<{
        path: string;
        notes: number;
        collapsedFolders?: number;
      }>;
      truncated?: { rows: number; notes: number };
    };
    const paths = result.overview.map((f) => f.path);
    // the merged fan occupies one row toward the cap and sorts before the
    // lexically-later vendor fan, so it survives the cut
    expect(result.overview.length).toBe(2);
    expect(paths).toContain("imports/documents");
    const docs = result.overview.find((f) => f.path === "imports/documents");
    expect(docs?.collapsedFolders).toBe(6);
    expect(docs?.notes).toBe(6);
    // dropped: vendor/documents (6 merged children notes) + 8 fillers
    expect(paths).not.toContain("vendor/documents");
    expect(result.truncated).toEqual({ rows: 9, notes: 14 });

    vault.cleanup();
  });

  test("keeps heterogeneous sibling folders separate", async () => {
    const files: Record<string, string> = {};
    const topics = [
      ["alpha", "Kubernetes ingress routing and pod autoscaling policies."],
      ["beta", "Payroll tax withholding tables for hourly contractors."],
      ["gamma", "Sourdough fermentation schedules and hydration ratios."],
      ["delta", "Telescope collimation steps for reflector optics."],
      ["epsilon", "Beehive winterization and varroa mite treatment."],
      ["zeta", "Marathon training splits and lactate threshold pacing."],
    ] as const;
    for (const [name, body] of topics) {
      files[`areas/${name}/note.md`] = `# ${name} notes\n${body}`;
    }
    const vault = createTempVault(files);

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string }>;
    };
    const paths = result.overview.map((f) => f.path);
    for (const [name] of topics) {
      expect(paths).toContain(`areas/${name}`);
    }

    vault.cleanup();
  });

  test("indexes frontmatter values without exposing folder-name keywords", async () => {
    const vault = createTempVault({
      "people/asha.md":
        "---\nrole: VP Engineering\nlocation: Boston\n---\n# Asha Mehta\nOwns platform strategy.",
      "people/lukas.md":
        "---\nrole: Staff Engineer\nlocation: Berlin\n---\n# Lukas Weber\nOwns fleet dispatch.",
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; keywords: string[] }>;
    };
    const peopleFolder = result.overview.find((f) => f.path === "people");
    expect(peopleFolder?.keywords).toContain("engineering");
    expect(peopleFolder?.keywords).toContain("boston");
    expect(peopleFolder?.keywords).not.toContain("people");
    expect(peopleFolder?.keywords).not.toContain("person");

    vault.cleanup();
  });
});
