#!/bin/sh
# Apply every local patch under this directory to the installed pi releases.
#   apply.sh              reconcile all installed releases (idempotent)
#   apply.sh --dry-run    report what would change, touch nothing
#   apply.sh --quiet      only problems + a one-line summary (used at startup)
#   apply.sh --status     report state only, no writes
# Exit: 0 = everything reconciled (or already was), 1 = a patch failed.
set -u
. "${0%/*}/lib.sh"

MODE=apply
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE=dry ;;
    --status)  MODE=status ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

ACTIVE=$(active_version)
failures=0
applied=0
need_restart=0

PATCHES=$(ls -1 "${0%/*}"/*.patch.sh 2>/dev/null | sort)
[ -n "$PATCHES" ] || { say "no patches in ${0%/*}"; exit 0; }

for patch in $PATCHES; do
  ( . "$patch" ) >/dev/null 2>&1 || true
  # shellcheck disable=SC1090
  . "$patch"
  say "== $PATCH_ID — $PATCH_TITLE"
  say "   upstream: $PATCH_UPSTREAM"
  touched=0
  for pkg in $RELEASES_GLOB; do
    [ -d "$pkg" ] || continue
    version=$(jq -r .version "$pkg/package.json" 2>/dev/null || echo '?')
    marker=""; [ "$version" = "$ACTIVE" ] && marker=" (active)"
    # Expand the target globs, then narrow to the files that actually contain the
    # check in either state — one grep per release instead of one per chunk.
    # shellcheck disable=SC2086
    set -- $PATCH_FILES
    _candidates=""
    for glob in "$@"; do
      for f in "$pkg"/$glob; do [ -f "$f" ] && _candidates="$_candidates $f"; done
    done
    # shellcheck disable=SC2086
    FILES=$(grep -lE "$UNPATCHED_RE|$PATCHED_RE" $_candidates 2>/dev/null)
    [ -n "$FILES" ] || continue
    if ! release_needs_patch "$pkg"; then
      say "   pi $version$marker: already applied"
      continue
    fi
    case "$MODE" in
      status) say "   pi $version$marker: NEEDS PATCH" ;;
      dry)    say "   pi $version$marker: would patch" ;;
      apply)
        if patch_release "$pkg" $((1 - QUIET)); then
          applied=$((applied + PATCHED_COUNT))
          [ "$PATCHED_COUNT" -gt 0 ] && touched=1
          [ "$version" = "$ACTIVE" ] && [ "$PATCHED_COUNT" -gt 0 ] && need_restart=1
        else
          failures=$((failures + 1))
        fi ;;
    esac
  done
  [ "$MODE" = apply ] && [ "$touched" = 0 ] && say "   (nothing to do)"
done

if [ "$MODE" = apply ]; then
  if [ "$failures" -gt 0 ]; then
    printf 'pi-patches: %d patch failure(s)\n' "$failures" >&2
    exit 1
  fi
  if [ "$need_restart" = 1 ]; then
    msg="pi-patches: applied $applied patch file(s) to the active release — restart pi to load them"
  else
    msg="pi-patches: up to date ($applied file(s) patched this run)"
  fi
  [ "$QUIET" = 1 ] && [ "$need_restart" = 0 ] || printf '%s\n' "$msg"
fi
exit 0
