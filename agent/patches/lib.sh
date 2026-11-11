#!/bin/sh
# Shared helpers for pi local patches. Sourced by apply.sh; not executable on its own.
# Patch file contract (see *.patch.sh): PATCH_ID, PATCH_TITLE, PATCH_UPSTREAM,
# PATCH_REMOVE_WHEN, PATCH_FILES (glob relative to the package root), UNPATCHED_RE,
# PATCHED_RE, PATCH_PERL (perl -0 -p substitution program), and optionally PATCH_ROOTS
# (package root globs; default: the pi-coding-agent package in the selected releases).

PI_AGENT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}"
RELEASES_GLOB="${PI_AGENT_DIR}/install/releases/*/node_modules/@earendil-works/pi-coding-agent"
PKG_REL="node_modules/@earendil-works/pi-coding-agent"

active_version() {
  f="${PI_AGENT_DIR}/install/current-version"
  [ -r "$f" ] && IFS= read -r v < "$f" && printf '%s' "$v"
}

# patched | upstream | unpatched | n/a
#  patched   our marker is there
#  upstream  UPSTREAM_FIXED_RE matches: the fix landed in the package, so applying ours would
#            duplicate or contradict it (2026-11-11: pi-devin 0.1.15 fixed #73/#74 and the old
#            anchor line survived, so the shape alone still said "unpatched")
#  unpatched our anchor is there and nothing claims the fix
#  n/a       the code this patch targets is gone: upstream refactor
patch_state() {
  _pkgfile=$1
  if grep -qE "$PATCHED_RE" "$_pkgfile" 2>/dev/null; then echo patched
  elif [ -n "$UPSTREAM_FIXED_RE" ] && grep -qE "$UPSTREAM_FIXED_RE" "$_pkgfile" 2>/dev/null; then echo upstream
  elif grep -qE "$UNPATCHED_RE" "$_pkgfile" 2>/dev/null; then echo unpatched
  else echo n/a
  fi
}

# Syntax-check a patched file. .ts files are type-stripped by Node's own stripper first
# (node --check alone rejects TypeScript), then checked as an ES module.
syntax_ok() {
  case "$1" in
    *.ts|*.mts)
      _tmp=$(mktemp "${TMPDIR:-/tmp}/pi-patch-check.XXXXXX.mjs") || return 1
      node -e 'const m=require("node:module"),fs=require("fs");fs.writeFileSync(process.argv[2],m.stripTypeScriptTypes(fs.readFileSync(process.argv[1],"utf8")))' "$1" "$_tmp" 2>/dev/null \
        && node --check "$_tmp" 2>/dev/null
      _rc=$?; rm -f "$_tmp"; return $_rc ;;
    *) node --check "$1" 2>/dev/null ;;
  esac
}

# True when the release still contains any unpatched target file.
release_needs_patch() {
  _pkg=$1
  release_has_state unpatched && return 0
  return 1
}

# True when any target file is in the given state (patched | upstream | unpatched | n/a).
release_has_state() {
  for _f in $FILES; do
    [ "$(patch_state "$_f")" = "$1" ] && return 0
  done
  return 1
}

# Patch one release. Sets PATCHED_COUNT; prints one line per file when verbose.
patch_release() {
  _pkg=$1
  _verbose=$2
  PATCHED_COUNT=0
  for _f in $FILES; do
    [ -f "$_f" ] || continue
    _state=$(patch_state "$_f")
    case "$_state" in
      patched) [ "$_verbose" = 1 ] && printf '    already patched: %s\n' "${_f#$_pkg/}" ;;
      upstream) [ "$_verbose" = 1 ] && printf '    upstream already fixed, left alone: %s\n' "${_f#$_pkg/}" ;;
      n/a)     : ;;   # target code absent (upstream refactor); say nothing
      unpatched)
        cp -n "$_f" "$_f.orig" 2>/dev/null || true
        # Restore point for THIS patch: .orig is the pristine file, so restoring it would also
        # drop earlier patches on the same file. mv (rename) gives a new inode, never an
        # in-place write into a pnpm store hardlink.
        _pre=$(mktemp "${TMPDIR:-/tmp}/pi-patch-pre.XXXXXX") && cp "$_f" "$_pre" || return 1
        # perl -i writes a new inode, which matters for pnpm installs: their package files
        # are hardlinks into the content-addressed store, and an in-place write would
        # corrupt the store copy too.
        if ! perl -0pi -e "$PATCH_PERL" "$_f" || [ "$(patch_state "$_f")" != patched ]; then
          printf '    ERROR: substitution did not produce the patched form in %s, restoring backup\n' "${_f#$_pkg/}" >&2
          mv "$_pre" "$_f"
          return 1
        fi
        if syntax_ok "$_f"; then
          rm -f "$_pre"
          PATCHED_COUNT=$((PATCHED_COUNT + 1))
          printf '    patched: %s\n' "${_f#$_pkg/}"
        else
          printf '    ERROR: syntax check failed on %s, restoring backup\n' "${_f#$_pkg/}" >&2
          mv "$_pre" "$_f"
          return 1
        fi ;;
    esac
  done
  return 0
}
