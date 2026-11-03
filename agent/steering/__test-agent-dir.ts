// SPDX-License-Identifier: MIT
// Hermetic test fixture: point the loader's GLOBAL layer at this
// checkout instead of the machine's live ~/.pi/agent/steering.
//
// Without this, every config suite reads whatever the live checkout
// happens to contain, so a branch is untestable before it is activated
// and a stale live copy makes a correct branch fail (functional F5,
// trust "Reviewer note"). Import this module FIRST in a test file; it
// only sets the variable when the runner did not set one, so an explicit
// PI_CODING_AGENT_DIR still wins.

import { resolve } from "node:path";

if (process.env.PI_CODING_AGENT_DIR === undefined) {
	// <checkout>/agent/steering -> <checkout>/agent
	process.env.PI_CODING_AGENT_DIR = resolve(process.cwd(), "..");
}
