import { describe, it } from "node:test";
import { expectBlocks, expectAllows, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

describe("agent-config-guard", () => {
  const harness = loadHarness({ config });
  it("blocks edit of general-purpose.md", async () => {
    await expectBlocks(harness, { edit: { path: "/home/pier/.pi/agent/agents/general-purpose.md", edits: [] } });
  });
  it("blocks write of settings.json", async () => {
    await expectBlocks(harness, { write: { path: "/home/pier/.pi/agent/settings.json", content: "" } });
  });
  it("blocks sed mutating general-purpose.md", async () => {
    await expectBlocks(harness, { command: "sed -i 's/^model:.*/model: x/' /home/pier/.pi/agent/agents/general-purpose.md" });
  });
  it("allows ls of agents dir", async () => {
    await expectAllows(harness, { command: "ls /home/pier/.pi/agent/agents" });
  });
  it("allows edit of unrelated file", async () => {
    await expectAllows(harness, { edit: { path: "/tmp/foo.ts", edits: [] } });
  });
});
