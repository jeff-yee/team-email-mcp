#!/usr/bin/env bash
# Offline: a hostile-mode BUILD_DIR must produce the same tgz hash as a clean
# copy of the same tree. Usage: build-modes-test.sh <patchedTree>
# No Graph, no live install, no official dist/ writes.
set -euo pipefail
ROOT="${TEAM_EMAIL_MCP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TREE="${1:-}"
if [ -z "$TREE" ] || [ ! -d "$TREE" ]; then
  echo "usage: $0 <patchedTree>" >&2
  exit 2
fi
TREE="$(cd "$TREE" && pwd)"
[ -f "$TREE/node_modules/@usejunior/provider-microsoft/dist/team-build-config.js" ] || {
  echo "build-modes-test.sh: $TREE is not a patched team tree" >&2
  exit 2
}
SCRATCH="${TMPDIR:-$ROOT/scratch-prune}/build-modes-$$"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT
mkdir -p "$SCRATCH"

setup_root() {
  local dest="$1"
  mkdir -p "$dest"
  # patches/ is required: build.sh derives .patched-files from the three diffs.
  cp -a "$ROOT/build.sh" "$ROOT/LICENSE" "$ROOT/NOTICE" "$ROOT/licenses" "$ROOT/src" "$ROOT/package" "$ROOT/tools" "$ROOT/patches" "$dest/"
}

build_one() {
  local name="$1" src="$2"
  local r="$SCRATCH/$name-root"
  local b="$SCRATCH/$name-tree"
  setup_root "$r"
  rm -rf "$b"
  cp -a "$src" "$b"
  if [ "$name" = hostile ]; then
    # Hostile modes: odd file and directory permissions, plus the 0777/0700 cases.
    chmod 0744 "$b/package.json"
    chmod 0600 "$b/node_modules/he/package.json"
    chmod 0700 "$b/node_modules/@usejunior/provider-microsoft/dist/index.js"
    chmod 0711 "$b/node_modules/he"
    chmod 0777 "$b/node_modules/semver/package.json"
    chmod 0700 "$b/node_modules/marked"
    # An allowlisted file that arrived without +x must still be 0755 in the tarball.
    chmod 0644 "$b/node_modules/sisteransi/package.json"
    chmod 0644 "$b/node_modules/email-agent-mcp/bin/email-agent-mcp.js"
  fi
  # Same TAG as the other arm: TEAM-BUILD.json embeds the tag, so a different
  # name would make the hashes diverge even when modes match.
  (cd "$r" && umask 077 && BUILD_DIR="$b" TAG=modes-repro TEAM_EMAIL_MCP_ROOT="$r" bash build.sh 20261117) >"$SCRATCH/$name.build.log"
  sha256sum "$r/dist/modes-repro.tgz" | tee "$SCRATCH/$name.sha"
}

# Missing listed executable must fail the build.
setup_root "$SCRATCH/missing-root"
rm -rf "$SCRATCH/missing-tree"
cp -a "$TREE" "$SCRATCH/missing-tree"
rm -f "$SCRATCH/missing-tree/node_modules/he/bin/he"
if (cd "$SCRATCH/missing-root" && BUILD_DIR="$SCRATCH/missing-tree" TAG=modes-missing TEAM_EMAIL_MCP_ROOT="$SCRATCH/missing-root" bash build.sh 20261117) >"$SCRATCH/missing.build.log" 2>&1; then
  echo "FAIL: build succeeded with a missing listed executable" >&2
  cat "$SCRATCH/missing.build.log" >&2
  exit 1
fi
if ! grep -q 'listed executable missing: node_modules/he/bin/he' "$SCRATCH/missing.build.log"; then
  echo "FAIL: missing-exec build did not report the listed path" >&2
  cat "$SCRATCH/missing.build.log" >&2
  exit 1
fi
echo "PASS: missing listed executable fails the build"

# Empty exec list (comments and blanks only) must fail the build.
setup_root "$SCRATCH/empty-root"
printf '  # indented comment\r\n\r\n# another\n' > "$SCRATCH/empty-root/src/install-exec-files.txt"
rm -rf "$SCRATCH/empty-tree"
cp -a "$TREE" "$SCRATCH/empty-tree"
if (cd "$SCRATCH/empty-root" && BUILD_DIR="$SCRATCH/empty-tree" TAG=modes-empty TEAM_EMAIL_MCP_ROOT="$SCRATCH/empty-root" bash build.sh 20261117) >"$SCRATCH/empty.build.log" 2>&1; then
  echo "FAIL: build succeeded with an empty exec list" >&2
  cat "$SCRATCH/empty.build.log" >&2
  exit 1
fi
if ! grep -q 'exec list is empty' "$SCRATCH/empty.build.log"; then
  echo "FAIL: empty exec list did not report empty" >&2
  cat "$SCRATCH/empty.build.log" >&2
  exit 1
fi
echo "PASS: empty exec list fails the build"

# Exec list that omits the launcher script must fail the build.
setup_root "$SCRATCH/nolaunch-root"
grep -v 'email-agent-mcp/bin/email-agent-mcp.js' "$ROOT/src/install-exec-files.txt" > "$SCRATCH/nolaunch-root/src/install-exec-files.txt"
rm -rf "$SCRATCH/nolaunch-tree"
cp -a "$TREE" "$SCRATCH/nolaunch-tree"
if (cd "$SCRATCH/nolaunch-root" && BUILD_DIR="$SCRATCH/nolaunch-tree" TAG=modes-nolaunch TEAM_EMAIL_MCP_ROOT="$SCRATCH/nolaunch-root" bash build.sh 20261117) >"$SCRATCH/nolaunch.build.log" 2>&1; then
  echo "FAIL: build succeeded without the launcher path in the exec list" >&2
  cat "$SCRATCH/nolaunch.build.log" >&2
  exit 1
fi
if ! grep -q 'exec list must include node_modules/email-agent-mcp/bin/email-agent-mcp.js' "$SCRATCH/nolaunch.build.log"; then
  echo "FAIL: missing-launcher list did not report the required path" >&2
  cat "$SCRATCH/nolaunch.build.log" >&2
  exit 1
fi
echo "PASS: exec list without the launcher path fails the build"

build_one clean "$TREE"
build_one hostile "$TREE"
sha_c=$(awk '{print $1}' "$SCRATCH/clean.sha")
sha_h=$(awk '{print $1}' "$SCRATCH/hostile.sha")
echo "clean=$sha_c"
echo "hostile=$sha_h"
if [ "$sha_c" != "$sha_h" ]; then
  echo "FAIL: hostile-mode build hash differs from the clean-mode build" >&2
  exit 1
fi
echo "PASS: hostile-mode build matches clean-mode hash $sha_c"

# umask 077 must still leave the dist tgz and sha256 at 0644.
for f in "$SCRATCH/clean-root/dist/modes-repro.tgz" "$SCRATCH/clean-root/dist/modes-repro.tgz.sha256" \
         "$SCRATCH/hostile-root/dist/modes-repro.tgz" "$SCRATCH/hostile-root/dist/modes-repro.tgz.sha256"; do
  mode=$(stat -c '%a' "$f")
  if [ "$mode" != 644 ]; then
    echo "FAIL: $f mode is $mode, expected 0644" >&2
    exit 1
  fi
done
echo "PASS: dist .tgz and .sha256 are 0644 under umask 077"

# A CRLF exec list with indented comments and padded paths must match the clean hash.
setup_root "$SCRATCH/crlf-root"
python3 -c '
import sys
src = sys.argv[1]
dest = sys.argv[2]
out = [b"  # indented comment\r\n", b"# hash comment\r\n", b"\r\n"]
for raw in open(src, "rb").read().splitlines():
    s = raw.decode().replace("\r", "").strip()
    if not s or s.startswith("#"):
        continue
    out.append(("  " + s + "  \r\n").encode())
open(dest, "wb").write(b"".join(out))
' "$ROOT/src/install-exec-files.txt" "$SCRATCH/crlf-root/src/install-exec-files.txt"
rm -rf "$SCRATCH/crlf-tree"
cp -a "$TREE" "$SCRATCH/crlf-tree"
(cd "$SCRATCH/crlf-root" && umask 077 && BUILD_DIR="$SCRATCH/crlf-tree" TAG=modes-repro TEAM_EMAIL_MCP_ROOT="$SCRATCH/crlf-root" bash build.sh 20261117) >"$SCRATCH/crlf.build.log"
sha_crlf=$(sha256sum "$SCRATCH/crlf-root/dist/modes-repro.tgz" | awk '{print $1}')
echo "crlf=$sha_crlf"
if [ "$sha_crlf" != "$sha_c" ]; then
  echo "FAIL: CRLF/indented-comment exec list hash differs from the clean-mode build" >&2
  cat "$SCRATCH/crlf.build.log" >&2
  exit 1
fi
echo "PASS: CRLF and indented comments in the exec list match the clean-mode hash"

echo "build-modes-test.sh: 6 passed, 0 failed"
