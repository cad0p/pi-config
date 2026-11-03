// SPDX-License-Identifier: MIT
// Capability gate tests (functional F4): a lockedRules config must refuse
// to load on a framework that would silently ignore the field.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertLockedRulesSupport,
	LOCKED_RULES_REQUIREMENT,
} from "./framework-support.ts";

describe("framework-support: lockedRules capability gate", () => {
	it("passes when the framework reports lock enforcement and the snapshot accessor", () => {
		assert.doesNotThrow(() =>
			assertLockedRulesSupport({
				LOCKED_RULES_SUPPORTED: true,
				agentDirSnapshot: () => ({ agentDir: "/a", homeDir: "/h" }),
			}),
		);
	});

	it("refuses a framework with the flag but without agentDirSnapshot (lens round 4)", () => {
		assert.throws(
			() => assertLockedRulesSupport({ LOCKED_RULES_SUPPORTED: true }),
			(err: Error) => err.message.includes(LOCKED_RULES_REQUIREMENT),
		);
	});

	it("refuses (loudly) a framework without the flag", () => {
		assert.throws(
			() => assertLockedRulesSupport({}),
			(err: Error) => {
				assert.match(err.message, /refusing to load: this config declares lockedRules/);
				assert.ok(
					err.message.includes(LOCKED_RULES_REQUIREMENT),
					"the message names what to install",
				);
				assert.match(err.message, /silently/);
				return true;
			},
		);
	});

	it("refuses a framework that reports the flag as anything but true", () => {
		assert.throws(() => assertLockedRulesSupport({ LOCKED_RULES_SUPPORTED: "yes" }));
	});
});
