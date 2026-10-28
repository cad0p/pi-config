#!/usr/bin/env node
// Launcher for the napkin CLI.
//
// napkin ships its TypeScript sources directly (no committed `dist/`). Node's
// built-in type stripping refuses to run `.ts` files under `node_modules`
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so this tiny `.js` stub —
// which IS allowed under node_modules — uses jiti to load the real `.ts`
// entry point. jiti strips types AND resolves the package's `.js` import
// specifiers to their `.ts` sources, all in pure JS (no native toolchain).
//
// jiti is resolved relative to THIS file (not the caller's cwd) so the bin
// works no matter where it is invoked from.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const jiti = createJiti(import.meta.url, { moduleCache: false });
await jiti.import("../src/main.ts");
