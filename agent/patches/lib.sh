#!/bin/sh
# Shared helpers for pi local patches. Sourced by apply.sh; not executable on its own.
# Patch file contract (see *.patch.sh): PATCH_ID, PATCH_TITLE, PATCH_UPSTREAM,
# PATCH_REMOVE_WHEN, PATCH_FILES (glob relative to the pi-coding-agent package root),
# UNPATCHED_RE, PATCHED_RE, PATCH_PERL (perl -0 -p substitution program).

PI_AGENT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}"
RELEASES_GLOB="${PI_AGENT_DIR}/install/releases/*/node_modules/@earendil-works/pi-coding-agent"
PKG_REL="node_modules/@earendil-works/pi-coding-agent"

active_version() {
  f="${PI_AGENT_DIR}/install/current-version"
  [ -r "$f" ] && IFS= read -r v < "$f" && printf '%s' "$v"
}

# patched | unpatched | n/a  (n/a = the code this patch targets is gone: upstream fixed or refactor)
patch_state() {
  _pkgfile=$1
  if grep -qE "$PATCHED_RE" "$_pkgfile" 2>/dev/null; then echo patched
  elif grep -qE "$UNPATCHED_RE" "$_pkgfile" 2>/dev/null; then echo unpatched
  else echo n/a
  fi
}

# True when the release still contains any unpatched target file.
release_needs_patch() {
  _pkg=$1
  _need=1
  for _f in $FILES; do
    [ "$(patch_state "$_f")" = unpatched ] && _need=0 && break
  done
  return $_need
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
      n/a)     : ;;   # target code absent (upstream fixed or refactored); say nothing
      unpatched)
        cp -n "$_f" "$_f.orig" 2>/dev/null || true
        perl -0pi -e "$PATCH_PERL" "$_f"
        if node --check "$_f" 2>/dev/null; then
          PATCHED_COUNT=$((PATCHED_COUNT + 1))
          printf '    patched: %s\n' "${_f#$_pkg/}"
        else
          printf '    ERROR: syntax check failed on %s, restoring backup\n' "${_f#$_pkg/}" >&2
          [ -f "$_f.orig" ] && cp "$_f.orig" "$_f"
          return 1
        fi ;;
    esac
  done
  return 0
}
