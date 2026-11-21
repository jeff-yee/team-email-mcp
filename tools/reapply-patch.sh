#!/usr/bin/env bash
# Re-apply the shared-mailbox read-only patch to an email-agent-mcp install.
# Only writes a target file when it matches the known 0.3.5 original
# (sha256-before.txt), or, for files the patch added (no before hash), when
# the file is absent. Already-patched files are skipped. Anything else
# refuses the whole run before any write (exit 2).
#
# Usage: reapply-patch.sh <absolute-install-dir>
# If the argument is omitted, EAM_INSTALL_DIR is used only when it is set,
# non-empty, and absolute. There is no default and no EAM_NPX_DIR fallback.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

FILES=(
  email-mcp/dist/server.js
  provider-microsoft/dist/auth.js
  provider-microsoft/dist/index.js
  provider-microsoft/dist/shared-mailbox-readonly.js
)

usage_path() {
  echo "reapply-patch: an explicit, non-empty, absolute install path is required." >&2
  echo "Pass the path as the first argument, or set EAM_INSTALL_DIR to an absolute path. There is no default." >&2
}

if [ "$#" -ge 1 ]; then
  INSTALL="$1"
  if [ -z "$INSTALL" ]; then
    echo "reapply-patch: install path is empty." >&2
    usage_path
    exit 2
  fi
elif [ -n "${EAM_INSTALL_DIR:-}" ]; then
  INSTALL="$EAM_INSTALL_DIR"
else
  usage_path
  exit 2
fi

case "$INSTALL" in
  /*) ;;
  *)
    echo "reapply-patch: install path must be absolute: $INSTALL" >&2
    usage_path
    exit 2
    ;;
esac

export EAM_INSTALL_DIR="$INSTALL"
if [[ "${EAM_PRINT_INSTALL_DIR:-}" = 1 ]]; then
  printf '%s\n' "$INSTALL"
  exit 0
fi

if [[ ! -d "$INSTALL" ]]; then
  echo "reapply-patch: install dir missing or not a directory: $INSTALL" >&2
  echo "Set EAM_INSTALL_DIR or pass an absolute path to a team patched-install directory." >&2
  exit 2
fi
if [[ ! -d "$INSTALL/node_modules/@usejunior" ]]; then
  echo "reapply-patch: expected node_modules/@usejunior missing under $INSTALL" >&2
  echo "Set EAM_INSTALL_DIR or pass an absolute path to a team patched-install directory." >&2
  exit 2
fi

UJ="$INSTALL/node_modules/@usejunior"
BEFORE="$HERE/backup/20261026-110312/sha256-before.txt"
PATCHED_DIR="$HERE/patched"

if [[ ! -f "$BEFORE" ]]; then
  echo "reapply-patch: missing pre-patch hash list: $BEFORE" >&2
  exit 2
fi

# True if $path or a parent directory strictly inside $root is a symlink.
symlink_inside_install() {
  local path="$1"
  local root="$2"
  local cur="$path"
  while [ "$cur" != "$root" ] && [ "$cur" != "/" ] && [ -n "$cur" ]; do
    if [ -L "$cur" ]; then
      return 0
    fi
    cur=$(dirname -- "$cur")
  done
  return 1
}

file_sha() {
  sha256sum -- "$1" | cut -d' ' -f1
}

before_sha() {
  awk -v f="$1" '$2==f { print $1; exit }' "$BEFORE"
}

# Classify every target and refuse before any write.
declare -a TO_WRITE=()
declare -A PATCHED_SHA=()
for f in "${FILES[@]}"; do
  src="$PATCHED_DIR/$f"
  if [ -L "$src" ]; then
    echo "reapply-patch: REFUSING: patched source is a symlink: $src" >&2
    exit 2
  fi
  if [ ! -f "$src" ]; then
    echo "reapply-patch: missing patched copy: $src" >&2
    exit 2
  fi
  PATCHED_SHA[$f]=$(file_sha "$src")

  target="$UJ/$f"
  if symlink_inside_install "$target" "$INSTALL"; then
    echo "reapply-patch: REFUSING: $f is a symlink, or a parent directory inside the install is a symlink." >&2
    exit 2
  fi

  want=$(before_sha "$f")
  patched=${PATCHED_SHA[$f]}

  if [ ! -e "$target" ]; then
    if [ -n "$want" ]; then
      echo "reapply-patch: REFUSING: $f is missing (not the 0.3.5 original). Port the patch manually." >&2
      exit 2
    fi
    # No pre-patch hash: the patch added this file. Absence is the pre-patch state.
    TO_WRITE+=("$f")
    continue
  fi
  if [ ! -f "$target" ] || [ -L "$target" ]; then
    echo "reapply-patch: REFUSING: $f is not a regular file." >&2
    exit 2
  fi
  have=$(file_sha "$target")
  if [ "$have" = "$patched" ]; then
    echo "already patched: $f"
    continue
  fi
  if [ -n "$want" ] && [ "$have" = "$want" ]; then
    TO_WRITE+=("$f")
    continue
  fi
  echo "reapply-patch: REFUSING: $f is neither the 0.3.5 original nor the known patched copy. Port the patch manually." >&2
  exit 2
done

if [ "${#TO_WRITE[@]}" -eq 0 ]; then
  echo "All 4 files already patched. No writes."
  exit 0
fi

tmp_files=()
cleanup_tmps() { rm -f -- "${tmp_files[@]}"; }
trap cleanup_tmps EXIT

for f in "${TO_WRITE[@]}"; do
  target="$UJ/$f"
  dir=$(dirname -- "$target")
  mkdir -p -- "$dir"
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    echo "reapply-patch: REFUSING: parent of $f is not a regular directory." >&2
    exit 2
  fi
  tmp=$(mktemp -p "$dir" .reapply.XXXXXX)
  tmp_files=("$tmp")
  cp -- "$PATCHED_DIR/$f" "$tmp"
  chmod 0444 -- "$tmp"
  mv -f -- "$tmp" "$target"
  tmp_files=()
  echo "patched: $f"
done

echo "Done. Restart the email-agent-mcp server(s) to load it."
