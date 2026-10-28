# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-08-11

<!-- USER-EDITABLE SECTION START -->
### Breaking

- **Two-layer config resolution** (issue [#21](https://github.com/cad0p/pi-steering/issues/21)): the loader now mirrors pi's own settings model instead of walking up `cwd → $HOME`. Exactly two fixed layers — the project layer at `<cwd>/.pi/steering/` and the global layer at `<agentDir>/steering/` (`~/.pi/agent/steering/`, or `$PI_CODING_AGENT_DIR` when set) — merged project-first (project wins on rule-name collision). Intermediate ancestor layers no longer load, and `~/.pi/steering/` is no longer special (no alias, no deprecation diagnostic): it only works when pi is launched from `$HOME` itself, where the project layer IS that path.
- **Migration:** `mv ~/.pi/steering ~/.pi/agent/steering`. No fallback is provided — the old path stops being discovered once this version ships.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Two-layer config resolution — project `.pi/steering/` + global `agentDir/steering/`, walk-up removed ([#21](https://github.com/cad0p/pi-steering/pull/21)) ([#25](https://github.com/cad0p/pi-steering/pull/25))

### 🐛 Bug Fixes

- Approve peer-graph build scripts (@google/genai, protobufjs) in pnpm-workspace.yaml ([#17](https://github.com/cad0p/pi-steering/pull/17))

### 📚 Documentation

- PUBLISHING.md reflects scoped @cad0p publish + semver-calver-release flow ([#15](https://github.com/cad0p/pi-steering/pull/15))
- Npm install line for published scoped package ([#20](https://github.com/cad0p/pi-steering/pull/20))

### 🎨 Styling

- Biome format + organizeImports after scoped-rename edits ([#18](https://github.com/cad0p/pi-steering/pull/18))


## [0.1.0] — 2026-08-10

### Added

- First public npm release as `@cad0p/pi-steering` (scoped — reverses the ADR's unscoped-name decision per maintainer request).
- `publishConfig.access: public` for OIDC/CLI publishing.

### Changed

- `unbash-walker` dependency: `github:cad0p/unbash-walker` → `@cad0p/unbash-walker ^0.1.0`.

## [Unreleased] — pre-publish (v0.1.x)

### Changed

- Monorepo split (2026-08-10): this repo is now `cad0p/pi-steering` (renamed from `pi-steering-hooks`); `unbash-walker`, `pi-steering-commit-format`, and `pi-steering-flags` moved to their own repos. The git plugin is now **opt-in** — `DEFAULT_PLUGINS` is empty; declare `plugins: [gitPlugin]` (import from `pi-steering/plugins/git`) to register it. This restores compile-time typo-checking on `disabledRules` / `disabledPlugins` for configs that declare their plugins (runtime defaults and type-level visibility can no longer diverge).

### Breaking

- Factory-time throw on any warning-class loader/merger diagnostic by default. Opt out via `defineConfig({ failOnWarnings: false })`.
- Tracker-name collisions are now detected at config-load time and surfaced as an `error`-class diagnostic that aggregates with other diagnostics (single thrown error per factory invocation, not multiple sequential throws). Errors always throw regardless of `failOnWarnings` (see schema JSDoc).
- `disabledPlugins` / `disabledRules` are now applied BEFORE cross-layer collision detection in `buildConfig`. A user resolving a duplicate-plugin warning by adding the plugin to `disabledPlugins` now sees the warning go away.
- `loadConfigs(cwd)`, `buildConfig(layers, defaults?)`, `loadSteeringConfig(cwd, defaults?)` return shape changed (now include `diagnostics` field). Internal `buildSessionRuntime` return shape changed. Bridge default factory is now async.
- `PluginResolveWarning` interface renamed to `SteeringDiagnostic` with extended `kind` union (covers loader-side categories) and required `type: "warning" | "error"` field.

### Changed

Visibility improvement: some plugin-merger warnings (predicate / observer / rule / extension-orphan collisions) were previously collected internally and never logged. They now flow through the same `failOnWarnings` policy as loader-side warnings: aggregated into the factory throw under the default, or emitted to `console.warn` with the opt-out.
