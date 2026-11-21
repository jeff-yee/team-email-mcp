#!/usr/bin/env bash
# Make the patched team tree that build.sh packages (used by CI; works offline
# with a warm npm cache): npm ci from package-lock.json with install scripts off,
# then the four @usejunior diffs and the two whole-file copies from patches/,
# with the tenant and team client id from team-build.config.json (or $TEAM_BUILD_CONFIG).
# Usage: make-build-tree.sh <emptyDestDir>     (never writes outside <emptyDestDir>)
set -euo pipefail
ROOT="${TEAM_EMAIL_MCP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
T="${1:?usage: make-build-tree.sh <emptyDestDir>}"
mkdir -p "$T"; T="$(cd "$T" && pwd)"
[ -z "$(ls -A "$T")" ] || { echo "make-build-tree.sh: $T is not empty" >&2; exit 1; }
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$T/"
(cd "$T" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
U="$T/node_modules/@usejunior"
for d in patch-provider-microsoft.diff patch-email-mcp.diff; do
  python3 - "$ROOT/patches/$d" "$U" <<'PY'
import re, sys, subprocess
src, U = sys.argv[1], sys.argv[2]
for p in re.split(r'(?m)^(?=--- )', open(src).read()):
    m = re.search(r'(?m)^\+\+\+ \S*?/@usejunior/(\S+)', p)
    if m:
        r = subprocess.run(['patch', '--no-backup-if-mismatch', '-s', '-f', f"{U}/{m.group(1)}"], input=p, text=True, capture_output=True)
        if r.returncode:
            print(r.stdout, r.stderr, file=sys.stderr)
            sys.exit(1)
PY
done
(cd "$T" && patch -s -p1 -f --no-backup-if-mismatch < "$ROOT/patches/patch-team-build.diff")
# Apache-2.0 4(b) change notices on modified upstream files that had none.
(cd "$T" && patch -s -p1 -f --no-backup-if-mismatch < "$ROOT/patches/patch-change-notices.diff")
cp "$ROOT/patches/own-mailbox-guard.js" "$ROOT/patches/team-build-config.js" "$U/provider-microsoft/dist/"
# Tenant and team client id come from the untracked build config (refuses if missing).
TEAM_EMAIL_MCP_ROOT="$ROOT" node "$ROOT/tools/apply-team-config.mjs" "$U/provider-microsoft/dist/team-build-config.js"
if find "$T" -name '*.rej' -o -name '*.orig' | grep -q .; then echo "make-build-tree.sh: patch rejects" >&2; exit 1; fi
echo "make-build-tree.sh: patched tree ready at $T" >&2
