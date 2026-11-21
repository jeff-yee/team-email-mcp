#!/usr/bin/env bash
# Tier-C prune of a COPY of the team build.
# Usage: prune-dir.sh <dir>   (never point this at build/; build.sh passes staging/prune-root)
# See docs/PRUNE-NOTES.md for why each item is safe.
set -euo pipefail
ROOT="${TEAM_EMAIL_MCP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
R="$ROOT"; D="${1:?dir}"; N="$D/node_modules"
case "$(cd "$D" && pwd)" in "$R/build"|"$R/build/"*) echo "prune-dir.sh: refusing to prune build/" >&2; exit 1;; esac
[ -f "$N/@usejunior/provider-gmail/package.json" ] || { echo "prune-dir.sh: $D does not look like the team build" >&2; exit 1; }
CUT=(prebuild-install node-addon-api @azure/msal-browser @microsoft/microsoft-graph-client
     express hono @hono/node-server cors express-rate-limit eventsource eventsource-parser pkce-challenge jose cross-spawn content-type raw-body)
# Tier A: dev/doc files, browser builds (Windows dpapi x64/arm64 kept; ia32 dropped)
find "$N" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.ts' -o -name '*.tsbuildinfo' \) -delete
# License and notice files always stay (LICENSE.md, licence, COPYING, NOTICE, ...).
find "$N" -type f \( -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' -o -iname '*.md' -o -iname '*.markdown' \) \
  ! -iname 'licen[cs]e*' ! -iname 'copying*' ! -iname 'notice*' -delete
rm -rf "$N/@azure/msal-node-extensions/bin/ia32" "$N/@azure/msal-node-extensions/types" "$N/@azure/msal-node-runtime/dist/index.js"
for d in "$N"/@azure/* "$N"/@typespec/*; do rm -rf "$d/dist/browser" "$d/dist/react-native" "$d/dist/workerd"; done
# keytar: build.sh adds the hash-pinned N-API prebuilds for each OS; drop any locally built copy.
rm -rf "$N/keytar/src" "$N/keytar/binding.gyp" "$N/keytar/build"
# npm .bin links are unused (the launcher runs the CLI by path) and break on Windows.
rm -rf "$N/.bin"
# Tier B: all broker natives (JS fallback stays), unused packages
rm -rf "$N/@azure/msal-node-runtime/dist/linux" "$N/@azure/msal-node-runtime/dist/macos" "$N/@azure/msal-node-runtime/dist/windows"
# Top-level msal-common was only used by msal-browser when msal-node carried its own nested copy (msal-node 6.x).
# With msal-node 7.x, npm hoists msal-common and msal-node needs it, so keep it then.
[ -f "$N/@azure/msal-node/node_modules/@azure/msal-common/package.json" ] && rm -rf "$N/@azure/msal-common"
# Tier C: Gmail provider -> stub, Google libraries go as orphans
G="$N/@usejunior/provider-gmail/dist"
install -m 0644 "$R/src/provider-gmail-stub.js" "$G/index.js"
rm -f "$G/auth.js" "$G/broker.js" "$G/email-gmail-provider.js" "$G/googleapis-client.js" "$G/push.js"
node -e 'const fs=require("fs"),f=process.argv[1],j=JSON.parse(fs.readFileSync(f,"utf8"));delete j.dependencies["@googleapis/gmail"];delete j.dependencies["google-auth-library"];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$N/@usejunior/provider-gmail/package.json"
node "$R/tools/orphans.mjs" "$D" "${CUT[@]}" > "$D.orphans"
while read -r p; do [ -n "$p" ] && rm -rf "${D:?}/$p"; done < "$D.orphans"; rm -f "$D.orphans"
find "$D" -xtype l -delete; find "$N" -type d -empty -delete
# Must-keep sanity
[ -f "$N/@azure/msal-node/node_modules/@azure/msal-common/package.json" ] || [ -f "$N/@azure/msal-common/package.json" ] || { echo "prune-dir.sh: msal-common (needed by msal-node) missing after prune" >&2; exit 1; }
for k in @azure/identity @azure/msal-node @azure/identity-cache-persistence @azure/msal-node-extensions @azure/msal-node-runtime keytar @modelcontextprotocol/sdk @usejunior/provider-microsoft @usejunior/email-core @usejunior/email-mcp email-agent-mcp; do
  [ -f "$N/$k/package.json" ] || { echo "prune-dir.sh: required package $k missing after prune" >&2; exit 1; }; done
for a in x64 arm64; do [ -f "$N/@azure/msal-node-extensions/bin/$a/dpapi.node" ] || { echo "prune-dir.sh: Windows dpapi.node ($a) missing" >&2; exit 1; }; done
echo "pruned $D: $(find "$D" -type f | wc -l) files, $(du -sk "$D" | cut -f1) KiB" >&2
