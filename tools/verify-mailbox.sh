#!/usr/bin/env bash
# Generic read-only shared mailbox check (copy of verify.sh). Usage: VERIFY_OWNER=<signed-in mailbox> verify-mailbox.sh <name> <address>   (VERIFY_OWNER is required; exits 2 without it)
# Prints scope names only, never tokens.
#
# The guard step checks the launcher's real install, not ~/.npm/_npx.
# Override with EAM_INSTALL_DIR and EAM_GUARD_FILE. Missing install or
# guard file fails closed (nonzero exit, message on stderr).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="${EAM_INSTALL_DIR:-${EAM_NPX_DIR:-$HOME/.email-agent-mcp/patched-install}}"
GUARD="${EAM_GUARD_FILE:-$HERE/sha256-after.txt}"
case "$INSTALL" in
  /*) ;;
  *)
    echo "verify-mailbox: install path must be absolute: $INSTALL" >&2
    echo "Set EAM_INSTALL_DIR to an absolute path (default: $HOME/.email-agent-mcp/patched-install)." >&2
    exit 2
    ;;
esac
export EAM_INSTALL_DIR="$INSTALL"
if [[ "${EAM_PRINT_INSTALL_DIR:-}" = 1 ]]; then
  printf '%s\n' "$INSTALL"
  exit 0
fi
export VERIFY_MBX="${1:?mailbox name}" VERIFY_SHARED="${2:?mailbox address}"

if [[ ! -d "$INSTALL" ]]; then
  echo "verify-mailbox: install dir missing or not a directory: $INSTALL" >&2
  echo "Set EAM_INSTALL_DIR to the team patched-install path (default: $HOME/.email-agent-mcp/patched-install)." >&2
  exit 2
fi
if [[ ! -d "$INSTALL/node_modules/@usejunior" ]]; then
  echo "verify-mailbox: expected node_modules/@usejunior missing under $INSTALL" >&2
  echo "Set EAM_INSTALL_DIR to the team patched-install path (default: $HOME/.email-agent-mcp/patched-install)." >&2
  exit 2
fi
if [[ ! -f "$GUARD" ]]; then
  echo "verify-mailbox: guard file missing: $GUARD" >&2
  echo "Set EAM_GUARD_FILE or place sha256-after.txt next to this script." >&2
  exit 2
fi

echo "== patch integrity"
(cd "$INSTALL" && sha256sum -c "$GUARD") || { echo "Patch missing/changed: run $HERE/reapply-patch.sh \"$INSTALL\""; exit 2; }

# Offline tests set this so the live Graph verify never runs.
if [[ "${EAM_GUARD_ONLY:-}" = 1 ]]; then
  echo "guard-only: patch integrity passed"
  exit 0
fi

echo "== offline guard unit test"; node "$HERE/guard-unit-test.mjs" 2>/dev/null | tail -1
echo "== live checks for $VERIFY_MBX <$VERIFY_SHARED> ($(date '+%Y-%m-%d %H:%M %Z'))"
cd "$INSTALL" && node "$HERE/verify-mailbox.mjs"
