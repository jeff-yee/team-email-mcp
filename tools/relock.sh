#!/usr/bin/env bash
# Re-resolve the team build's npm dependencies into a NEW tree (2026-11-17, msal-node advisory
# GHSA-xcx6-jx8p-x3h5). email-agent-mcp stays 0.3.2 with @usejunior/* 0.3.5 overrides (same package.json as build/).
# Then overlays our patched @usejunior dist files from the existing patched tree (same 0.3.5 versions, so this is an
# exact file-level re-application of the local patches) and checks the overlay equals the documented patch.
# Usage: relock.sh <srcPatchedTree> <newTree>     e.g. relock.sh build build-msal7
set -euo pipefail
ROOT="${TEAM_EMAIL_MCP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
R="$ROOT"
# Paths may be absolute or relative to the repo root.
SRC="${1:?src}"; DST="${2:?dst}"
case "$SRC" in /*) ;; *) SRC="$R/$SRC" ;; esac
case "$DST" in /*) ;; *) DST="$R/$DST" ;; esac
[ -e "$DST" ] && { echo "relock.sh: $DST exists" >&2; exit 1; }
mkdir -p "$DST"; cp "$SRC/package.json" "$DST/"
if [ -f "$DST/package-lock.json" ]; then
  (cd "$DST" && npm ci --no-audit --no-fund --loglevel=error)
else
  (cd "$DST" && npm install --no-audit --no-fund --loglevel=error)
fi
# patched-file overlay: only files that differ from pristine upstream, plus our added files
for p in email-core email-mcp provider-microsoft provider-gmail; do
  pv(){ python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$1"; }; v=$(pv "$DST/node_modules/@usejunior/$p/package.json"); s=$(pv "$SRC/node_modules/@usejunior/$p/package.json")
  [ "$v" = "$s" ] || { echo "relock.sh: @usejunior/$p version drift $s -> $v" >&2; exit 1; }
done
OV=$(cd "$SRC/node_modules/@usejunior" && { diff -rq . "$DST/node_modules/@usejunior" || true; } | sed -nE 's#^Files \./(\S+) and .* differ$#\1#p; s#^Only in \.(/?[^:]*): (.*)$#\1/\2#p' | sed 's#^/##')
echo "$OV" > "$DST/.patched-files"
while read -r f; do [ -n "$f" ] && install -D -m 0644 "$SRC/node_modules/@usejunior/$f" "$DST/node_modules/@usejunior/$f"; done <<< "$OV"
[ -f "$SRC/TEAM-BUILD.json" ] && cp "$SRC/TEAM-BUILD.json" "$DST/TEAM-BUILD.json"
diff -rq "$SRC/node_modules/@usejunior" "$DST/node_modules/@usejunior" && echo "relock.sh: @usejunior identical to $SRC (patches re-applied)"
(cd "$DST" && npm ls @azure/msal-node @azure/msal-common @azure/identity @azure/identity-cache-persistence @azure/msal-node-extensions keytar)
