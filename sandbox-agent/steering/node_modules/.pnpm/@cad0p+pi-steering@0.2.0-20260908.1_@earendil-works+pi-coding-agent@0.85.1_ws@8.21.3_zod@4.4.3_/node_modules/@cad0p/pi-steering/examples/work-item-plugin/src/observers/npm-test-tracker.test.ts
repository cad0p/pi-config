// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Unit tests for the `npm-test-tracker` observer.
 *
 * Exercises the watch-filter + write-on-match contract via
 * `testObserver`, which captures `appendEntry` calls for inspection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testObserver } from "@cad0p/pi-steering/testing";
import { npmTestTracker, TEST_PASSED_EVENT } from "./npm-test-tracker.ts";

describe("npm-test-tracker observer", () => {
  it("records a TEST_PASSED_EVENT entry on successful `npm test`", async () => {
    const { entries, watchMatched } = await testObserver(npmTestTracker, {
      toolName: "bash",
      input: { command: "npm test" },
      output: {},
      exitCode: 0,
    });

    assert.equal(watchMatched, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.customType, TEST_PASSED_EVENT);
    assert.deepEqual(entries[0]?.data, {
      command: "npm test",
      // The dispatcher auto-tags plain-object payloads with
      // `_agentLoopIndex` — default mockObserverContext has index
      // 0.
      _agentLoopIndex: 0,
    });
  });

  it("does NOT fire on a failed `npm test` (exitCode non-zero)", async () => {
    const { entries, watchMatched } = await testObserver(npmTestTracker, {
      toolName: "bash",
      input: { command: "npm test" },
      output: {},
      exitCode: 1,
    });
    assert.equal(watchMatched, false);
    assert.equal(entries.length, 0);
  });

  it("does NOT fire on an unrelated command", async () => {
    const { entries, watchMatched } = await testObserver(npmTestTracker, {
      toolName: "bash",
      input: { command: "npm install" },
      output: {},
      exitCode: 0,
    });
    assert.equal(watchMatched, false);
    assert.equal(entries.length, 0);
  });

  it("fires on `npm test -- --grep foo` (watch regex unanchored to suffix)", async () => {
    const { entries, watchMatched } = await testObserver(npmTestTracker, {
      toolName: "bash",
      input: { command: "npm test -- --grep foo" },
      output: {},
      exitCode: 0,
    });
    assert.equal(watchMatched, true);
    assert.equal(entries.length, 1);
  });

  it("records the original command in the payload", async () => {
    const { entries } = await testObserver(npmTestTracker, {
      toolName: "bash",
      input: { command: "npm test -- --reporter dot" },
      output: {},
      exitCode: 0,
    });
    const data = entries[0]?.data as { command: string };
    assert.equal(data.command, "npm test -- --reporter dot");
  });

  it("tags writes with the agent-loop index from ctx", async () => {
    const { entries } = await testObserver(
      npmTestTracker,
      {
        toolName: "bash",
        input: { command: "npm test" },
        output: {},
        exitCode: 0,
      },
      { agentLoopIndex: 42 },
    );
    const data = entries[0]?.data as { _agentLoopIndex: number };
    assert.equal(data._agentLoopIndex, 42);
  });
});
