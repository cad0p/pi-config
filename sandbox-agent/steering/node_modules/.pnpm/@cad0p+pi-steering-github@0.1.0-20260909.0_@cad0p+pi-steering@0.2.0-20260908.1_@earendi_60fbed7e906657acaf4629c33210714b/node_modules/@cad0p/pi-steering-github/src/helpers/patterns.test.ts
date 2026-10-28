// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Unit tests for the github plugin's content-pattern constants.
 * Import the constants from `./patterns.ts` directly: the module
 * loads cleanly under plain node (`node --test
 * --experimental-strip-types`).
 *
 * Command routing is structural now (`command: "gh"` +
 * `when.subcommand` sequences on the rules — core #117, closes #55):
 * the retired `^gh\s+` anchor family has no pins here. Routing truth
 * tables live at the engine level in `../integration.test.ts` (real
 * defineConfig + loadHarness) and the descriptor value pin in
 * `../descriptors.test.ts`. What remains pinned here are the
 * VALUE-content patterns the keyword rules test flag values against.
 *
 * The flag+value-region builders (`TITLE_WITH_REF`,
 * `SUBJECT_WITH_REF`, `BODY_WITH_REF`) are INTENTIONALLY unpinned —
 * deleted: keyword checks extract the value through the bound facade
 * (`ctx.command.getFlagValue(ghFlags.<key>)`) and test `ISSUE_REF`
 * against the extracted value, so flag spellings live only in the
 * descriptor table. The value-side pins below feed `ISSUE_REF` bare
 * extracted values (what the facade hands the rules), never raw
 * flag-carrying command text.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOSING_KEYWORD, ISSUE_REF } from "./patterns.ts";

describe("github plugin — content patterns", () => {
  it("closing-keyword family and issue-ref are exported for pinning", () => {
    assert.match(CLOSING_KEYWORD, /close/);
    assert.match(ISSUE_REF, /#\\d/);
  });

  it("issue-ref matches extracted flag values carrying a closing keyword", () => {
    // Bare extracted values (facade output — no flag spellings): the
    // title/subject/body channels all test this one pattern.
    const refRe = new RegExp(ISSUE_REF, "i");
    assert.equal(refRe.test("feat: x (closes #12)"), true);
    assert.equal(refRe.test("feat: x (fixes #7)"), true);
    assert.equal(refRe.test("see resolves #3"), true);
    assert.equal(refRe.test("plain text, no keyword"), false);
    assert.equal(refRe.test("see #12 without a keyword"), false);
  });
});
