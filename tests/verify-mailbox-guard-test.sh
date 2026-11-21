#!/usr/bin/env bash
# Offline guard-path checks for tools/verify-mailbox.sh and the related install-dir
# helpers. No Graph, no live verify, no live install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/tools/verify-mailbox.sh"
REAPPLY_SRC="$ROOT/tools/reapply-patch.sh"
if [ -n "${TMPDIR:-}" ]; then
  SCRATCH=$(mktemp -d "$TMPDIR/verify-mailbox-guard-XXXXXX")
else
  SCRATCH=$(mktemp -d)
fi
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT
fails=0
passes=0
fail() { echo "FAIL: $*" >&2; fails=$((fails+1)); }
pass() { echo "PASS: $*"; passes=$((passes+1)); }

FILES=(
  email-mcp/dist/server.js
  provider-microsoft/dist/auth.js
  provider-microsoft/dist/index.js
  provider-microsoft/dist/shared-mailbox-readonly.js
)
HASHED3=(
  email-mcp/dist/server.js
  provider-microsoft/dist/auth.js
  provider-microsoft/dist/index.js
)

# present: scratch install + matching guard file → exit 0
good="$SCRATCH/good-install"
mkdir -p "$good/node_modules/@usejunior"
echo 'ok' > "$good/node_modules/@usejunior/marker.txt"
guard="$SCRATCH/sha256-after.txt"
(cd "$good" && sha256sum node_modules/@usejunior/marker.txt) > "$guard"
out="$SCRATCH/present.out"
if EAM_INSTALL_DIR="$good" EAM_GUARD_FILE="$guard" EAM_GUARD_ONLY=1 \
    bash "$SCRIPT" scratch scratch@example.com >"$out" 2>&1; then
  if ! grep -q 'patch integrity' "$out"; then
    fail "present: missing integrity output"; cat "$out" >&2
  else
    pass "present install+guard exits 0"
  fi
else
  fail "present: expected exit 0, got $?"; cat "$out" >&2
fi

# missing install dir → fail closed
out="$SCRATCH/missing-install.out"
ec=0
EAM_INSTALL_DIR="$SCRATCH/no-such-install" EAM_GUARD_FILE="$guard" EAM_GUARD_ONLY=1 \
  bash "$SCRIPT" scratch scratch@example.com >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]]; then
  fail "missing install: expected exit 2, got $ec"; cat "$out" >&2
elif ! grep -q 'install dir missing' "$out"; then
  fail "missing install: expected a clear missing-dir message"; cat "$out" >&2
else
  pass "missing install fails closed (exit 2)"
fi

# missing guard file → fail closed
out="$SCRATCH/missing-guard.out"
ec=0
EAM_INSTALL_DIR="$good" EAM_GUARD_FILE="$SCRATCH/no-such-guard.txt" EAM_GUARD_ONLY=1 \
  bash "$SCRIPT" scratch scratch@example.com >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]]; then
  fail "missing guard: expected exit 2, got $ec"; cat "$out" >&2
elif ! grep -q 'guard file missing' "$out"; then
  fail "missing guard: expected a clear missing-file message"; cat "$out" >&2
else
  pass "missing guard file fails closed (exit 2)"
fi

# Dir present but expected node_modules/@usejunior missing → fail closed (exit 2)
bare="$SCRATCH/bare-install"
mkdir -p "$bare"
out="$SCRATCH/missing-nm.out"
ec=0
EAM_INSTALL_DIR="$bare" EAM_GUARD_FILE="$guard" EAM_GUARD_ONLY=1 \
  bash "$SCRIPT" scratch scratch@example.com >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]]; then
  fail "missing node_modules: expected exit 2, got $ec"; cat "$out" >&2
elif ! grep -q 'node_modules/@usejunior missing' "$out"; then
  fail "missing node_modules: expected a clear missing-entry message"; cat "$out" >&2
else
  pass "missing node_modules/@usejunior fails closed (exit 2)"
fi

# Default and override resolution (print hook only; does not touch a live install).
print_dir() {
  env -u EAM_INSTALL_DIR -u EAM_NPX_DIR HOME="$SCRATCH/home" EAM_PRINT_INSTALL_DIR=1 "$@"
}
DEFAULT="$SCRATCH/home/.email-agent-mcp/patched-install"
got=$(print_dir bash "$SCRIPT" scratch scratch@example.com)
if [[ "$got" != "$DEFAULT" ]]; then
  fail "wrapper default: got $got"
else
  pass "wrapper default is $DEFAULT"
fi
got=$(EAM_INSTALL_DIR="$good" EAM_PRINT_INSTALL_DIR=1 bash "$SCRIPT" scratch scratch@example.com)
if [[ "$got" != "$good" ]]; then
  fail "wrapper EAM_INSTALL_DIR override: got $got"
else
  pass "wrapper honors EAM_INSTALL_DIR"
fi
got=$(env -u EAM_INSTALL_DIR EAM_NPX_DIR="$SCRATCH/npx-fallback" EAM_PRINT_INSTALL_DIR=1 bash "$SCRIPT" scratch scratch@example.com)
if [[ "$got" != "$SCRATCH/npx-fallback" ]]; then
  fail "wrapper EAM_NPX_DIR fallback: got $got"
else
  pass "wrapper falls back to EAM_NPX_DIR when EAM_INSTALL_DIR is unset"
fi
got=$(EAM_INSTALL_DIR="$good" EAM_NPX_DIR="$SCRATCH/npx-fallback" EAM_PRINT_INSTALL_DIR=1 bash "$SCRIPT" scratch scratch@example.com)
if [[ "$got" != "$good" ]]; then
  fail "wrapper INSTALL wins over NPX: got $got"
else
  pass "wrapper EAM_INSTALL_DIR wins over EAM_NPX_DIR"
fi

# The read-only node helpers keep the same default/override/fallback.
for tool in "node $ROOT/tools/guard-unit-test.mjs" "node $ROOT/tools/verify-mailbox.mjs"; do
  label=${tool##*/}
  got=$(print_dir $tool)
  if [[ "$got" != "$DEFAULT" ]]; then
    fail "$label default: got $got"
  else
    pass "$label default is $DEFAULT"
  fi
  got=$(EAM_INSTALL_DIR="$good" EAM_PRINT_INSTALL_DIR=1 $tool)
  if [[ "$got" != "$good" ]]; then
    fail "$label EAM_INSTALL_DIR override: got $got"
  else
    pass "$label honors EAM_INSTALL_DIR"
  fi
  got=$(env -u EAM_INSTALL_DIR EAM_NPX_DIR="$SCRATCH/npx-fallback" EAM_PRINT_INSTALL_DIR=1 $tool)
  if [[ "$got" != "$SCRATCH/npx-fallback" ]]; then
    fail "$label EAM_NPX_DIR fallback: got $got"
  else
    pass "$label falls back to EAM_NPX_DIR when EAM_INSTALL_DIR is unset"
  fi
done

# reapply-patch.sh and the node helpers fail closed without running any live work.
# reapply now requires an explicit absolute path (argument or EAM_INSTALL_DIR).
out="$SCRATCH/reapply-missing.out"
ec=0
EAM_INSTALL_DIR="$SCRATCH/no-such-install" bash "$REAPPLY_SRC" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'install dir missing' "$out"; then
  fail "reapply missing dir: expected exit 2 with a clear message (got $ec)"; cat "$out" >&2
else
  pass "reapply-patch missing install fails closed (exit 2)"
fi
out="$SCRATCH/reapply-nm.out"
ec=0
EAM_INSTALL_DIR="$bare" bash "$REAPPLY_SRC" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'node_modules/@usejunior missing' "$out"; then
  fail "reapply missing node_modules: expected exit 2 with a clear message (got $ec)"; cat "$out" >&2
else
  pass "reapply-patch missing node_modules/@usejunior fails closed (exit 2)"
fi
for tool in "$ROOT/tools/guard-unit-test.mjs" "$ROOT/tools/verify-mailbox.mjs"; do
  label=${tool##*/}
  out="$SCRATCH/${label%.mjs}-missing.out"
  ec=0
  EAM_INSTALL_DIR="$SCRATCH/no-such-install" node "$tool" >"$out" 2>&1 || ec=$?
  if [[ "$ec" -ne 2 ]] || ! grep -q 'install dir missing' "$out"; then
    fail "$label missing dir: expected exit 2 with a clear message (got $ec)"; cat "$out" >&2
  else
    pass "$label missing install fails closed (exit 2)"
  fi
  out="$SCRATCH/${label%.mjs}-nm.out"
  ec=0
  EAM_INSTALL_DIR="$bare" node "$tool" >"$out" 2>&1 || ec=$?
  if [[ "$ec" -ne 2 ]] || ! grep -q 'node_modules/@usejunior missing' "$out"; then
    fail "$label missing node_modules: expected exit 2 with a clear message (got $ec)"; cat "$out" >&2
  else
    pass "$label missing node_modules/@usejunior fails closed (exit 2)"
  fi
done

# Nit: a relative EAM_INSTALL_DIR must exit 2 with a message (wrapper, real run).
out="$SCRATCH/wrapper-relative.out"
ec=0
EAM_INSTALL_DIR="rel-install" EAM_GUARD_FILE="$guard" EAM_GUARD_ONLY=1 \
  bash "$SCRIPT" scratch scratch@example.com >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'install path must be absolute' "$out"; then
  fail "wrapper relative path: expected exit 2 with a message (got $ec)"; cat "$out" >&2
else
  pass "wrapper relative EAM_INSTALL_DIR exits 2 with a message"
fi

# Nit: install check is a directory check, not existsSync.
notdir="$SCRATCH/not-a-dir"
echo 'not a directory' > "$notdir"
out="$SCRATCH/guard-notdir.out"
ec=0
EAM_INSTALL_DIR="$notdir" node "$ROOT/tools/guard-unit-test.mjs" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'install dir missing or not a directory' "$out"; then
  fail "guard-unit-test file-as-install: expected exit 2, not-a-directory message (got $ec)"; cat "$out" >&2
elif grep -q 'node_modules/@usejunior missing' "$out"; then
  fail "guard-unit-test file-as-install: should not use the @usejunior message"; cat "$out" >&2
else
  pass "guard-unit-test treats a regular file as a missing directory"
fi

# Nit: pathToFileURL handles a path containing '#'; createRequire is gone.
if grep -q 'createRequire' "$ROOT/tools/guard-unit-test.mjs"; then
  fail "guard-unit-test.mjs still references createRequire"
else
  pass "guard-unit-test.mjs no longer uses createRequire"
fi
if ! grep -q 'pathToFileURL' "$ROOT/tools/guard-unit-test.mjs"; then
  fail "guard-unit-test.mjs does not use pathToFileURL"
else
  pass "guard-unit-test.mjs imports via pathToFileURL"
fi
hashdir="$SCRATCH/dir#hash"
mkdir -p "$hashdir"
# A local package.json keeps Node from walking into an invalid parent
# package.json when the scratch dir sits under another project.
printf '{ "type": "module" }\n' > "$hashdir/package.json"
echo 'export const ok = true;' > "$hashdir/mod.js"
cat > "$hashdir/import-test.mjs" <<'JS'
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(join(here, 'mod.js')).href);
if (m.ok !== true) process.exit(1);
JS
if node "$hashdir/import-test.mjs"; then
  pass "pathToFileURL imports a module from a path containing #"
else
  fail "pathToFileURL failed to import from a path containing #"
fi
out="$SCRATCH/hashdir-missing.out"
ec=0
EAM_INSTALL_DIR="$hashdir" node "$ROOT/tools/guard-unit-test.mjs" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'node_modules/@usejunior missing' "$out" || ! grep -q 'dir#hash' "$out"; then
  fail "guard-unit-test # path: expected exit 2 mentioning the path (got $ec)"; cat "$out" >&2
else
  pass "guard-unit-test reports a # path without a raw-path import crash"
fi

# ---- reapply-patch.sh writer tests on fake installs ----
HERE="$SCRATCH/here"
setup_here() {
  rm -rf "$HERE"
  mkdir -p "$HERE/backup/20261026-110312" "$HERE/orig" "$HERE/patched"
  cp "$REAPPLY_SRC" "$HERE/reapply-patch.sh"
  local f
  for f in "${FILES[@]}"; do
    mkdir -p "$HERE/orig/$(dirname "$f")" "$HERE/patched/$(dirname "$f")"
    printf 'ORIG %s\n' "$f" > "$HERE/orig/$f"
    printf 'PATCHED %s\n' "$f" > "$HERE/patched/$f"
  done
  (cd "$HERE/orig" && sha256sum "${HASHED3[@]}") > "$HERE/backup/20261026-110312/sha256-before.txt"
}
setup_install() {
  local dest="$1" mode="${2:-orig}"
  rm -rf "$dest"
  local uj="$dest/node_modules/@usejunior" f
  mkdir -p "$uj"
  for f in "${FILES[@]}"; do
    mkdir -p "$uj/$(dirname "$f")"
    case "$mode" in
      orig)
        if [[ "$f" == *shared-mailbox-readonly.js ]]; then
          :
        else
          cp "$HERE/orig/$f" "$uj/$f"
        fi
        ;;
      patched)
        cp "$HERE/patched/$f" "$uj/$f"
        chmod 0444 "$uj/$f"
        ;;
      *)
        echo "unknown setup_install mode: $mode" >&2
        return 2
        ;;
    esac
  done
}
snap_install() {
  local dest="$1" out="$2"
  local uj="$dest/node_modules/@usejunior" f
  : > "$out"
  for f in "${FILES[@]}"; do
    local p="$uj/$f"
    if [ -L "$p" ]; then
      printf 'symlink %s %s\n' "$f" "$(readlink -- "$p")" >> "$out"
    elif [ -f "$p" ]; then
      printf '%s %s %s %s\n' "$(sha256sum -- "$p" | awk '{print $1}')" "$(stat -c '%Y %a' "$p")" "$f" >> "$out"
    else
      printf 'missing %s\n' "$f" >> "$out"
    fi
  done
}

setup_here

# Explicit-path rule: no default, no empty arg, no EAM_NPX_DIR fallback.
# Env var alone is OK only if set, non-empty, and absolute.
run_reapply() {
  env -u EAM_INSTALL_DIR -u EAM_NPX_DIR bash "$HERE/reapply-patch.sh" "$@"
}

out="$SCRATCH/reapply-noarg.out"
ec=0
run_reapply >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'explicit, non-empty, absolute' "$out" || ! grep -q 'no default' "$out"; then
  fail "reapply no arg: expected exit 2, no-default message (got $ec)"; cat "$out" >&2
else
  pass "reapply with no argument and no env exits 2 (no live default)"
fi

out="$SCRATCH/reapply-empty-arg.out"
ec=0
# Keep a valid env set to prove an empty argument is not ignored.
EAM_INSTALL_DIR="$good" bash "$HERE/reapply-patch.sh" "" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'install path is empty' "$out"; then
  fail "reapply empty arg: expected exit 2 (got $ec)"; cat "$out" >&2
else
  pass "reapply with an empty argument exits 2 even if EAM_INSTALL_DIR is set"
fi

out="$SCRATCH/reapply-empty-env.out"
ec=0
EAM_INSTALL_DIR= bash "$HERE/reapply-patch.sh" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'explicit, non-empty, absolute' "$out"; then
  fail "reapply empty env: expected exit 2 (got $ec)"; cat "$out" >&2
else
  pass "reapply with empty EAM_INSTALL_DIR and no argument exits 2"
fi

out="$SCRATCH/reapply-npx-ignored.out"
ec=0
env -u EAM_INSTALL_DIR EAM_NPX_DIR="$good" EAM_PRINT_INSTALL_DIR=1 bash "$HERE/reapply-patch.sh" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || grep -qx "$good" "$out"; then
  fail "reapply must not fall back to EAM_NPX_DIR (got $ec)"; cat "$out" >&2
else
  pass "reapply does not fall back to EAM_NPX_DIR"
fi

out="$SCRATCH/reapply-rel-arg.out"
ec=0
run_reapply rel-install >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'install path must be absolute' "$out"; then
  fail "reapply relative arg: expected exit 2 (got $ec)"; cat "$out" >&2
else
  pass "reapply relative argument exits 2 with a message"
fi

out="$SCRATCH/reapply-rel-env.out"
ec=0
EAM_INSTALL_DIR="rel-install" bash "$HERE/reapply-patch.sh" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 2 ]] || ! grep -q 'install path must be absolute' "$out"; then
  fail "reapply relative env: expected exit 2 (got $ec)"; cat "$out" >&2
else
  pass "reapply relative EAM_INSTALL_DIR exits 2 with a message"
fi

# Env var alone, set, non-empty, absolute: accepted (print hook, no writes).
got=$(EAM_INSTALL_DIR="$good" EAM_PRINT_INSTALL_DIR=1 bash "$HERE/reapply-patch.sh")
if [[ "$got" != "$good" ]]; then
  fail "reapply env alone: got $got"
else
  pass "reapply honors a set, non-empty, absolute EAM_INSTALL_DIR with no argument"
fi
got=$(env -u EAM_INSTALL_DIR EAM_PRINT_INSTALL_DIR=1 bash "$HERE/reapply-patch.sh" "$good")
if [[ "$got" != "$good" ]]; then
  fail "reapply arg alone: got $got"
else
  pass "reapply honors an absolute argument with EAM_INSTALL_DIR unset"
fi
got=$(EAM_INSTALL_DIR="$SCRATCH/other" EAM_PRINT_INSTALL_DIR=1 bash "$HERE/reapply-patch.sh" "$good")
if [[ "$got" != "$good" ]]; then
  fail "reapply arg wins over env: got $got"
else
  pass "reapply argument wins over EAM_INSTALL_DIR"
fi

# Repo copy (no backup/ or patched/ beside it) refuses and writes nothing.
repo_inst="$SCRATCH/repo-copy-install"
setup_install "$repo_inst" orig
snap_install "$repo_inst" "$SCRATCH/repo-copy.before"
out="$SCRATCH/reapply-repo-copy.out"
ec=0
EAM_INSTALL_DIR="$repo_inst" bash "$REAPPLY_SRC" >"$out" 2>&1 || ec=$?
snap_install "$repo_inst" "$SCRATCH/repo-copy.after"
if [[ "$ec" -ne 2 ]] || ! grep -q 'missing pre-patch hash list' "$out"; then
  fail "repo copy without backup/: expected exit 2 (got $ec)"; cat "$out" >&2
elif ! cmp -s "$SCRATCH/repo-copy.before" "$SCRATCH/repo-copy.after"; then
  fail "repo copy without backup/: install was modified"
else
  pass "repo copy without backup/patched refuses and writes nothing"
fi

# Happy path: 3 originals + missing shared-mailbox-readonly.js → write all 4.
inst="$SCRATCH/inst-orig"
setup_install "$inst" orig
out="$SCRATCH/reapply-orig.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
if [[ "$ec" -ne 0 ]]; then
  fail "reapply orig: expected exit 0 (got $ec)"; cat "$out" >&2
else
  ok=1
  for f in "${FILES[@]}"; do
    if ! cmp -s "$HERE/patched/$f" "$inst/node_modules/@usejunior/$f"; then
      fail "reapply orig: $f was not written to the patched copy"
      ok=0
    fi
    if ! grep -q "patched: $f" "$out"; then
      fail "reapply orig: missing patched: $f line"
      ok=0
    fi
  done
  if [[ "$ok" -eq 1 ]]; then
    pass "reapply writes pre-patch files (3 originals + missing new file)"
  fi
fi

# Already patched: skip all writes (content, mode, mtime unchanged).
inst="$SCRATCH/inst-patched"
setup_install "$inst" patched
touch -t 202001010000 "$inst/node_modules/@usejunior"/email-mcp/dist/server.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/auth.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/index.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/shared-mailbox-readonly.js
snap_install "$inst" "$SCRATCH/patched.before"
out="$SCRATCH/reapply-already.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
snap_install "$inst" "$SCRATCH/patched.after"
if [[ "$ec" -ne 0 ]]; then
  fail "reapply already patched: expected exit 0 (got $ec)"; cat "$out" >&2
elif ! grep -q 'All 4 files already patched. No writes.' "$out"; then
  fail "reapply already patched: expected a no-writes message"; cat "$out" >&2
elif grep -q '^patched:' "$out"; then
  fail "reapply already patched: wrote files"; cat "$out" >&2
elif ! cmp -s "$SCRATCH/patched.before" "$SCRATCH/patched.after"; then
  fail "reapply already patched: install changed"
  diff -u "$SCRATCH/patched.before" "$SCRATCH/patched.after" >&2 || true
else
  pass "reapply skips writes when all 4 files are already patched"
fi

# Mixed: three already patched, shared-mailbox-readonly.js is a newer unknown hash → refuse, no writes.
inst="$SCRATCH/inst-newer-shared"
setup_install "$inst" patched
chmod u+w "$inst/node_modules/@usejunior/provider-microsoft/dist/shared-mailbox-readonly.js"
printf 'NEWER shared-mailbox-readonly (e.g. team build)\n' \
  > "$inst/node_modules/@usejunior/provider-microsoft/dist/shared-mailbox-readonly.js"
chmod 0644 "$inst/node_modules/@usejunior/provider-microsoft/dist/shared-mailbox-readonly.js"
touch -t 202001010000 "$inst/node_modules/@usejunior"/email-mcp/dist/server.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/auth.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/index.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/shared-mailbox-readonly.js
snap_install "$inst" "$SCRATCH/newer.before"
out="$SCRATCH/reapply-newer.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
snap_install "$inst" "$SCRATCH/newer.after"
if [[ "$ec" -ne 2 ]] || ! grep -q 'neither the 0.3.5 original nor the known patched copy' "$out"; then
  fail "reapply newer shared file: expected exit 2 refuse (got $ec)"; cat "$out" >&2
elif ! cmp -s "$SCRATCH/newer.before" "$SCRATCH/newer.after"; then
  fail "reapply newer shared file: install changed despite refuse"
  diff -u "$SCRATCH/newer.before" "$SCRATCH/newer.after" >&2 || true
else
  pass "reapply refuses a newer shared-mailbox-readonly.js before any write"
fi

# Mixed pre-patch + already-patched: only write the pre-patch file.
inst="$SCRATCH/inst-mixed"
setup_install "$inst" patched
chmod u+w "$inst/node_modules/@usejunior/email-mcp/dist/server.js"
cp "$HERE/orig/email-mcp/dist/server.js" "$inst/node_modules/@usejunior/email-mcp/dist/server.js"
chmod 0644 "$inst/node_modules/@usejunior/email-mcp/dist/server.js"
touch -t 202001010000 "$inst/node_modules/@usejunior"/provider-microsoft/dist/auth.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/index.js \
  "$inst/node_modules/@usejunior"/provider-microsoft/dist/shared-mailbox-readonly.js
auth_before=$(stat -c '%Y %a' "$inst/node_modules/@usejunior/provider-microsoft/dist/auth.js")
out="$SCRATCH/reapply-mixed.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
auth_after=$(stat -c '%Y %a' "$inst/node_modules/@usejunior/provider-microsoft/dist/auth.js")
if [[ "$ec" -ne 0 ]]; then
  fail "reapply mixed: expected exit 0 (got $ec)"; cat "$out" >&2
elif ! grep -q 'patched: email-mcp/dist/server.js' "$out"; then
  fail "reapply mixed: should write the pre-patch file"; cat "$out" >&2
elif ! grep -q 'already patched: provider-microsoft/dist/auth.js' "$out"; then
  fail "reapply mixed: should skip already-patched files"; cat "$out" >&2
elif ! cmp -s "$HERE/patched/email-mcp/dist/server.js" "$inst/node_modules/@usejunior/email-mcp/dist/server.js"; then
  fail "reapply mixed: server.js content mismatch"
elif [[ "$auth_before" != "$auth_after" ]]; then
  fail "reapply mixed: already-patched auth.js was rewritten ($auth_before -> $auth_after)"
else
  pass "reapply writes only pre-patch files and skips already-patched ones"
fi

# Missing original (server.js absent, but it has a before hash) → refuse, no writes.
inst="$SCRATCH/inst-missing-server"
setup_install "$inst" orig
rm -f "$inst/node_modules/@usejunior/email-mcp/dist/server.js"
snap_install "$inst" "$SCRATCH/missing-server.before"
out="$SCRATCH/reapply-missing-server.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
snap_install "$inst" "$SCRATCH/missing-server.after"
if [[ "$ec" -ne 2 ]] || ! grep -q 'is missing (not the 0.3.5 original)' "$out"; then
  fail "reapply missing original: expected exit 2 (got $ec)"; cat "$out" >&2
elif ! cmp -s "$SCRATCH/missing-server.before" "$SCRATCH/missing-server.after"; then
  fail "reapply missing original: install changed"
else
  pass "reapply refuses a missing original file before any write"
fi

# Symlinked target: refuse, do not write through to a file outside the install.
inst="$SCRATCH/inst-symlink-target"
setup_install "$inst" orig
outside="$SCRATCH/outside-shared.js"
printf 'OUTSIDE\n' > "$outside"
outside_before=$(sha256sum -- "$outside" | awk '{print $1}')
rm -f "$inst/node_modules/@usejunior/provider-microsoft/dist/shared-mailbox-readonly.js"
ln -s "$outside" "$inst/node_modules/@usejunior/provider-microsoft/dist/shared-mailbox-readonly.js"
snap_install "$inst" "$SCRATCH/symlink-target.before"
out="$SCRATCH/reapply-symlink-target.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
outside_after=$(sha256sum -- "$outside" | awk '{print $1}')
if [[ "$ec" -ne 2 ]] || ! grep -qi 'symlink' "$out"; then
  fail "reapply symlinked target: expected exit 2 mentioning symlink (got $ec)"; cat "$out" >&2
elif [[ "$outside_before" != "$outside_after" ]] || [[ "$(cat "$outside")" != $'OUTSIDE' ]]; then
  fail "reapply symlinked target: wrote through to the file outside the install"
else
  # The three originals must also be unchanged.
  ok=1
  for f in "${HASHED3[@]}"; do
    if ! cmp -s "$HERE/orig/$f" "$inst/node_modules/@usejunior/$f"; then
      fail "reapply symlinked target: $f was modified"
      ok=0
    fi
  done
  if [[ "$ok" -eq 1 ]]; then
    pass "reapply refuses a symlinked target and does not write outside the install"
  fi
fi

# Symlinked parent dir inside the install.
inst="$SCRATCH/inst-symlink-parent"
setup_install "$inst" orig
escaped="$SCRATCH/escaped-dist"
mkdir -p "$escaped"
# Move the real dist aside and point provider-microsoft/dist at a dir outside.
mv "$inst/node_modules/@usejunior/provider-microsoft/dist" "$escaped/dist"
ln -s "$escaped/dist" "$inst/node_modules/@usejunior/provider-microsoft/dist"
snap_install "$inst" "$SCRATCH/symlink-parent.before"
# Also snapshot the escaped dir files.
escaped_before=$( (cd "$escaped/dist" && sha256sum auth.js index.js 2>/dev/null; ls -l) )
out="$SCRATCH/reapply-symlink-parent.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
escaped_after=$( (cd "$escaped/dist" && sha256sum auth.js index.js 2>/dev/null; ls -l) )
if [[ "$ec" -ne 2 ]] || ! grep -qi 'symlink' "$out"; then
  fail "reapply symlinked parent: expected exit 2 mentioning symlink (got $ec)"; cat "$out" >&2
elif [[ "$escaped_before" != "$escaped_after" ]]; then
  fail "reapply symlinked parent: wrote through a parent symlink"
else
  pass "reapply refuses a symlinked parent directory inside the install"
fi

# A neither-hash file among otherwise pre-patch files refuses the whole run.
inst="$SCRATCH/inst-neither"
setup_install "$inst" orig
printf 'TAMPERED server.js\n' > "$inst/node_modules/@usejunior/email-mcp/dist/server.js"
snap_install "$inst" "$SCRATCH/neither.before"
out="$SCRATCH/reapply-neither.out"
ec=0
run_reapply "$inst" >"$out" 2>&1 || ec=$?
snap_install "$inst" "$SCRATCH/neither.after"
if [[ "$ec" -ne 2 ]] || ! grep -q 'neither the 0.3.5 original nor the known patched copy' "$out"; then
  fail "reapply neither-hash: expected exit 2 (got $ec)"; cat "$out" >&2
elif ! cmp -s "$SCRATCH/neither.before" "$SCRATCH/neither.after"; then
  fail "reapply neither-hash: install changed despite refuse"
else
  pass "reapply refuses the whole run when any file is neither pre-patch nor patched"
fi

if [[ "$fails" -ne 0 ]]; then
  echo "verify-mailbox-guard-test.sh: $passes passed, $fails failed" >&2
  exit 1
fi
echo "verify-mailbox-guard-test.sh: $passes passed, 0 failed"
