#!/bin/sh
# Apply every local patch under this directory to the installed pi releases.
#   apply.sh              reconcile the active release (idempotent)
#   apply.sh --all        reconcile every installed release, active or not
#   apply.sh --dry-run    report what would change, touch nothing
#   apply.sh --quiet      only problems + a one-line summary (used at startup)
#   apply.sh --status     report state only, no writes
# Exit: 0 = everything reconciled (or already was), 1 = a patch failed.
set -u
. "${0%/*}/lib.sh"

MODE=apply
QUIET=0
ALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE=dry ;;
    --status)  MODE=status ;;
    --all)     ALL=1 ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

ACTIVE=$(active_version)
# Default scope: the release the launcher will actually run. Patching old releases only
# mutates code that cannot execute; if you ever roll back, that release becomes active and
# the next session patches it then. --all exists for the explicit case (auditing, or
# pre-patching a rollback target before switching).
if [ "$ALL" = 1 ]; then
  RELEASES=$RELEASES_GLOB
elif [ -n "$ACTIVE" ]; then
  RELEASES="${PI_AGENT_DIR}/install/releases/${ACTIVE}/${PKG_REL}"
else
  printf 'pi-patches: no current-version file, falling back to every installed release\n' >&2
  RELEASES=$RELEASES_GLOB
fi
failures=0
applied=0
need_restart=0

PATCHES=$(ls -1 "${0%/*}"/*.patch.sh 2>/dev/null | sort)
[ -n "$PATCHES" ] || { say "no patches in ${0%/*}"; exit 0; }

for patch in $PATCHES; do
  # Reset the contract before each file so one patch can never inherit another's state.
  PATCH_ID= PATCH_TITLE= PATCH_UPSTREAM= PATCH_REMOVE_WHEN= PATCH_FILES=
  UNPATCHED_RE= PATCHED_RE= PATCH_PERL=
  # shellcheck disable=SC1090
  . "$patch" || { printf 'pi-patches: cannot source %s\n' "$patch" >&2; failures=$((failures + 1)); continue; }
  if [ -z "$PATCH_ID" ] || [ -z "$PATCH_FILES" ] || [ -z "$UNPATCHED_RE" ] || [ -z "$PATCH_PERL" ]; then
    printf 'pi-patches: %s is missing PATCH_ID/PATCH_FILES/UNPATCHED_RE/PATCH_PERL\n' "${patch##*/}" >&2
    failures=$((failures + 1)); continue
  fi
  say "== $PATCH_ID — $PATCH_TITLE"
  say "   upstream: $PATCH_UPSTREAM"
  touched=0
  for pkg in $RELEASES; do
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
