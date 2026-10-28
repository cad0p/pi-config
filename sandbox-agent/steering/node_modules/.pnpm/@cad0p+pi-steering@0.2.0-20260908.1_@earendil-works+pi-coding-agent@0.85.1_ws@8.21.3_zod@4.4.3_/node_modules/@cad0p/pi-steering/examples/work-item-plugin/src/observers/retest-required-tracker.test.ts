// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Unit tests for the `retest-required-tracker` observer.
 *
 * Mirrors the structure of `npm-test-tracker.test.ts` — exercises
 * the watch-filter + write-on-match contract via `testObserver`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testObserver } from "@cad0p/pi-steering/testing";
import {
  RETEST_REQUIRED_EVENT,
  retestRequiredTracker,
} from "./retest-required-tracker.ts";

describe("retest-required-tracker observer", () => {
  it("records a RETEST_REQUIRED_EVENT entry on successful `git pull`", async () => {
    const { entries, watchMatched } = await testObserver(
      retestRequiredTracker,
      {
        toolName: "bash",
        input: { command: "git pull" },
        output: {},
        exitCode: 0,
      },
    );

    assert.equal(watchMatched, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.customType, RETEST_REQUIRED_EVENT);
    assert.deepEqual(entries[0]?.data, {
      command: "git pull",
      _agentLoopIndex: 0,
    });
  });

  it("does NOT fire on failed `git pull`", async () => {
    const { entries, watchMatched } = await testObserver(
      retestRequiredTracker,
      {
        toolName: "bash",
        input: { command: "git pull" },
        output: {},
        exitCode: 1,
      },
    );
    assert.equal(watchMatched, false);
    assert.equal(entries.length, 0);
  });

  it("does NOT fire on unrelated commands", async () => {
    const { entries, watchMatched } = await testObserver(
      retestRequiredTracker,
      {
        toolName: "bash",
        input: { command: "git push" },
        output: {},
        exitCode: 0,
      },
    );
    assert.equal(watchMatched, false);
    assert.equal(entries.length, 0);
  });

  it("fires on `git pull --rebase` (watch regex unanchored to suffix)", async () => {
    const { entries, watchMatched } = await testObserver(
      retestRequiredTracker,
      {
        toolName: "bash",
        input: { command: "git pull --rebase" },
        output: {},
        exitCode: 0,
      },
    );
    assert.equal(watchMatched, true);
    assert.equal(entries.length, 1);
  });
});
