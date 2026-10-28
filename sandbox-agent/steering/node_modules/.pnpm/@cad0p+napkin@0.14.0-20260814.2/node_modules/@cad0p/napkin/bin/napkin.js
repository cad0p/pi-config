#!/usr/bin/env node
// Launcher for the napkin CLI.
//
// The package ships a compiled `dist/` (see tsconfig.build.json) built by the
// `prepare` script, so this bin stub is a plain ESM import of the built entry
// point — no jiti runtime, no createRequire. The import is relative to THIS
// file (not the caller's cwd), so the bin works no matter where it is invoked
// from.
import "../dist/main.js";
