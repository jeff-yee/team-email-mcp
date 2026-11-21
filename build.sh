#!/usr/bin/env bash
# Package $BUILD_DIR (default: $ROOT/build) into dist/. Offline except for the
# hash-pinned keytar prebuild download when KEYTAR_PREBUILD_DIR has no copy yet;
# writes nothing outside this repository (or KEYTAR_PREBUILD_DIR). A copy is pruned (tier C, tools/prune-dir.sh) in
# staging and the manifest + install.tar are made from the pruned copy.
# The full patched tree is left intact.
# Relock metadata (msal-node 7.2.2 / GHSA-xcx6-jx8p-x3h5) is written into
# TEAM-BUILD.json. Override TAG to name the dist artifact; BUILD_DIR for the
# patched tree; TEAM_EMAIL_MCP_ROOT (or this script's directory) is the repo root.
set -euo pipefail
ROOT="${TEAM_EMAIL_MCP_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
R="$ROOT"
DATE="${1:-$(date +%Y%m%d)}"
TAG="${TAG:-email-agent-mcp-team-$DATE}"
# Fixed mtime so two builds of the same tree produce the same tarball hashes.
# 2026-11-17 00:00:00 UTC.
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1794873600}"
B="${BUILD_DIR:-$R/build}"; S="$R/src"; ST="$R/staging/$TAG"
P="$R/staging/prune-root"
[ -e "$R/dist/$TAG.tgz" ] && [ "${ALLOW_OVERWRITE:-0}" != 1 ] && { echo "build.sh: dist/$TAG.tgz already exists; refusing to overwrite" >&2; exit 1; }
[ -f "$B/node_modules/@usejunior/provider-microsoft/dist/team-build-config.js" ] || { echo "build.sh: $B is not a patched team tree" >&2; exit 1; }
# The tree must carry a tenant id, team client id and denied prefixes (or the
# explicit opt-out) from tools/apply-team-config.mjs; no fallback. The path goes
# to node as an argument, never inside the JS source.
TBC_JS="$B/node_modules/@usejunior/provider-microsoft/dist/team-build-config.js"
TEAM_CFG=$(node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then((m) => { m.assertTeamBuildConfig(); console.log(JSON.stringify({ tenantId: m.TEAM_TENANT_ID, teamClientId: m.TEAM_CLIENT_ID, deniedClientIdPrefixes: m.TEAM_FORBIDDEN_CLIENT_ID_PREFIXES, allowNoDeniedClients: m.TEAM_ALLOW_NO_DENIED_CLIENTS, sharedTargetPolicy: m.SHARED_TARGET_POLICY })); }).catch((e) => { console.error("build.sh: " + e.message); process.exit(2); })' "$TBC_JS") || exit 2
cfgv(){ printf '%s' "$TEAM_CFG" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)[sys.argv[1]]))' "$1"; }
POLICY=$(cfgv sharedTargetPolicy)
rm -rf "$R/staging"; mkdir -p "$ST" "$R/dist"
cp -a "$B" "$P"
pv(){ python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$P/node_modules/$1/package.json"; }
bash "$R/tools/prune-dir.sh" "$P"
# keytar 7.9.0 N-API prebuilds (github.com/atom/node-keytar release assets), one per
# supported OS/CPU, so one package runs on Windows, macOS and Linux. Each download is
# checked against the pinned sha256 before use. KEYTAR_PREBUILD_DIR caches them;
# with KEYTAR_OFFLINE=1 a missing file fails the build instead of downloading.
KEYTAR_VER=7.9.0
KEYTAR_PREBUILDS="linux-x64=2d75753fabf9dceb49537ae231e1897de53727bc0fadbc2a01e6374a1443c67c
darwin-x64=4ce56e3896e76a2deaef13f8a36207efa6d94d96678d30200952d83d327eb5f9
darwin-arm64=195f0855e26f83e0d61e228d1b61c7769baa993244518dc9879d9d57104c7cec
win32-x64=f00156103976f77847f9ff96ca96c3facac2b4527edf41dfee5d50be39736459"
KT_DIR="${KEYTAR_PREBUILD_DIR:-$R/vendor/keytar-$KEYTAR_VER}"; mkdir -p "$KT_DIR"
[ "$(pv keytar)" = "$KEYTAR_VER" ] || { echo "build.sh: keytar is not $KEYTAR_VER" >&2; exit 1; }
for kp in $KEYTAR_PREBUILDS; do
  plat="${kp%%=*}"; want="${kp#*=}"; f="$KT_DIR/keytar-v$KEYTAR_VER-napi-v3-$plat.tar.gz"
  if [ ! -f "$f" ]; then
    [ "${KEYTAR_OFFLINE:-0}" = 1 ] && { echo "build.sh: missing $f (KEYTAR_OFFLINE=1)" >&2; exit 1; }
    curl -sSfL -o "$f.part" "https://github.com/atom/node-keytar/releases/download/v$KEYTAR_VER/${f##*/}" && mv "$f.part" "$f"
  fi
  got=$(sha256sum < "$f" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "build.sh: ${f##*/} sha256 $got does not match the pin $want" >&2; exit 1; }
  mkdir -p "$P/node_modules/keytar/build/Release/$plat"
  tar -xzf "$f" -O build/Release/keytar.node > "$P/node_modules/keytar/build/Release/$plat/keytar.node"
done
patch -s -f -p1 --no-backup-if-mismatch -d "$P" < "$R/patches/patch-keytar-loader.diff" || { echo "build.sh: keytar loader patch failed" >&2; exit 1; }
# Every bundled package keeps (or gets) its license text; LICENSE, NOTICE and
# THIRD-PARTY-NOTICES ship at the install root and in the package.
node "$R/tools/license-notices.mjs" "$P" "$R/LICENSE" || { echo "build.sh: a bundled package has no license text" >&2; exit 1; }
cp "$R/LICENSE" "$R/NOTICE" "$P/"
STUB_SHA=$(sha256sum < "$R/src/provider-gmail-stub.js" | cut -d' ' -f1)
if [ -f "$P/node_modules/@azure/msal-node/node_modules/@azure/msal-common/package.json" ]; then
  MSAL_COMMON_VER=$(pv @azure/msal-node/node_modules/@azure/msal-common)
else
  MSAL_COMMON_VER=$(pv @azure/msal-common)
fi
DEPS=$(printf '{"@azure/msal-node": "%s", "@azure/msal-common": "%s", "@azure/identity": "%s", "@azure/identity-cache-persistence": "%s", "@azure/msal-node-extensions": "%s", "keytar": "%s"}' \
  "$(pv @azure/msal-node)" "$MSAL_COMMON_VER" \
  "$(pv @azure/identity)" "$(pv @azure/identity-cache-persistence)" "$(pv @azure/msal-node-extensions)" "$(pv keytar)")
RELOCK='{"date": "2026-11-17", "why": "GHSA-xcx6-jx8p-x3h5 (@azure/msal-node 5.0.0-beta.0 through 7.0.2 inclusive; advisory range >=5.0.0-beta.0 <7.1.0, patched in 7.1.0+)", "lockfile": "package-lock.json", "method": "npm ci from the relocked package-lock.json, then the 12 patched @usejunior files"}'
cat > "$P/TEAM-BUILD.json" <<JSON
{
  "build": "$TAG",
  "base": {"email-agent-mcp": "0.3.2", "@usejunior/*": "0.3.5", "localPatches": ["shared-mailbox-readonly (2026-10-26)", "team-draft-profile (2026-11-17)", "receive-allowlist-fail-closed (2026-11-18, upstream #267)"]},
  "defaultScopeProfile": "draft",
  "draftScopes": ["User.Read", "offline_access", "Mail.ReadWrite", "Mail.Read.Shared"],
  "sharedTargetPolicy": $POLICY,
  "dependencies": $DEPS,
  "relock": $RELOCK,
  "requiresExplicitClientId": true,
  "tenantId": $(cfgv tenantId),
  "teamClientId": $(cfgv teamClientId),
  "deniedClientIdPrefixes": $(cfgv deniedClientIdPrefixes),
  "allowNoDeniedClients": $(cfgv allowNoDeniedClients),
  "platforms": ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"],
  "pruned": {"tier": "C", "script": "tools/prune-dir.sh (msal7 hoisted msal-common kept)", "providerGmailStubSha256": "$STUB_SHA",
             "natives": "keytar $KEYTAR_VER N-API prebuilds (sha256-pinned in build.sh) + msal-node-extensions dpapi x64/arm64", "removed": "dev/doc files, npm .bin links, msal-node-runtime native binaries, dpapi ia32, msal-browser, top-level msal-common (only if a nested copy exists), microsoft-graph-client, MCP SDK HTTP stack, Google libraries (provider-gmail stubbed)"}
}
JSON
# Derive .patched-files from the four diffs plus the two whole-file copies.
python3 - "$R/patches" "$P/.patched-files" <<'DERIVE'
import re, sys
from pathlib import Path
src, dest = Path(sys.argv[1]), Path(sys.argv[2])
files = set()
for name in ("patch-provider-microsoft.diff", "patch-email-mcp.diff", "patch-team-build.diff", "patch-change-notices.diff"):
    for m in re.finditer(r"(?m)^\+\+\+ \S*?/@usejunior/(\S+?)(?:\t|$)", (src / name).read_text()):
        files.add(m.group(1))
for copied in ("own-mailbox-guard.js", "team-build-config.js"):
    files.add("provider-microsoft/dist/" + copied)
dest.write_text("".join(p + "\n" for p in sorted(files)))
DERIVE
# Normalize modes so BUILD_DIR file modes (e.g. 0744 package.json) cannot leak
# into the tarball. Directories are 0755 and every regular file is 0644, then
# the checked-in list src/install-exec-files.txt is chmod 0755. The build
# fails if a listed file is missing or if any other regular file is left executable.
find "$P" -type d -exec chmod 0755 {} +
find "$P" -type f -exec chmod 0644 {} +
EXEC_LIST="$S/install-exec-files.txt"
[ -f "$EXEC_LIST" ] || { echo "build.sh: missing $EXEC_LIST" >&2; exit 1; }
# Same comment/blank filter for the chmod loop and the extra-exec check:
# strip CR, trim whitespace, drop blank lines and comments (including indented).
EXEC_PATHS="$R/staging/exec-list.normalized"
awk '{
  sub(/\r$/, "")
  sub(/^[[:space:]]+/, "")
  sub(/[[:space:]]+$/, "")
}
/^($|#)/ { next }
{ print }
' "$EXEC_LIST" > "$EXEC_PATHS"
if [ ! -s "$EXEC_PATHS" ]; then
  echo "build.sh: exec list is empty after removing comments and blank lines" >&2
  exit 1
fi
REQUIRED_EXEC="node_modules/email-agent-mcp/bin/email-agent-mcp.js"
if ! grep -Fxq "$REQUIRED_EXEC" "$EXEC_PATHS"; then
  echo "build.sh: exec list must include $REQUIRED_EXEC" >&2
  exit 1
fi
missing=0
while IFS= read -r rel || [ -n "${rel:-}" ]; do
  [ -n "$rel" ] || continue
  f="$P/$rel"
  if [ ! -f "$f" ]; then
    echo "build.sh: listed executable missing: $rel" >&2
    missing=1
    continue
  fi
  chmod 0755 "$f"
done < "$EXEC_PATHS"
[ "$missing" = 0 ] || exit 1
extra=$(find "$P" -type f -perm /111 -printf '%P\n' | LC_ALL=C sort | grep -Fvx -f "$EXEC_PATHS" || true)
if [ -n "$extra" ]; then
  echo "build.sh: unexpected executable files (not in $EXEC_LIST):" >&2
  echo "$extra" >&2
  exit 1
fi
(cd "$P" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$ST/team-install.sha256"
(cd "$P" && find . -type l -printf '%p -> %l\n' | LC_ALL=C sort) > "$ST/team-install.links"
(cd "$P" && tar cf "$ST/install.tar" --owner=0 --group=0 --numeric-owner --sort=name --mtime=@"$SOURCE_DATE_EPOCH" --mode='u+rwX,go+rX,go-w' .)
MS=$(sha256sum < "$ST/team-install.sha256" | cut -d' ' -f1); LS=$(sha256sum < "$ST/team-install.links" | cut -d' ' -f1)
sed -e "s/@@BUILD_TAG@@/$TAG/" -e "s/@@MANIFEST_SHA256@@/$MS/" -e "s/@@LINKS_SHA256@@/$LS/" "$S/team-email-agent-mcp-stdio.mjs.in" > "$ST/team-email-agent-mcp-stdio.mjs"
PKG="$R/package"
[ -f "$PKG/install.mjs" ] && [ -f "$PKG/install.sh" ] && [ -f "$PKG/README.md" ] || {
  echo "build.sh: missing $PKG/install.mjs, install.sh or README.md" >&2
  exit 1
}
cp "$PKG/install.mjs" "$PKG/install.sh" "$PKG/README.md" "$R/LICENSE" "$R/NOTICE" "$ST/"
(cd "$ST" && sha256sum install.tar team-install.sha256 team-install.links team-email-agent-mcp-stdio.mjs install.mjs install.sh README.md LICENSE NOTICE > package-files.sha256)
# Normalize the outer package tree too (scripts stay executable).
find "$ST" -type d -exec chmod 0755 {} +
find "$ST" -type f -exec chmod 0644 {} +
chmod 0755 "$ST/install.sh"
for out in "$R/dist/$TAG.tgz" "$R/dist/$TAG.files.sha256" "$R/dist/$TAG.tgz.sha256" "$R/dist/$TAG.team-email-agent-mcp-stdio.mjs"; do
  [ -e "$out" ] && [ "${ALLOW_OVERWRITE:-0}" != 1 ] && { echo "build.sh: $out already exists; refusing to overwrite" >&2; exit 1; }
done
(cd "$R/staging" && tar --owner=0 --group=0 --numeric-owner --sort=name --mtime=@"$SOURCE_DATE_EPOCH" --mode='u+rwX,go+rX,go-w' -cf - "$TAG" | gzip -n > "$R/dist/$TAG.tgz")
cp "$ST/team-install.sha256" "$R/dist/$TAG.files.sha256"
cp "$ST/team-email-agent-mcp-stdio.mjs" "$R/dist/$TAG.team-email-agent-mcp-stdio.mjs"
(cd "$R/dist" && sha256sum "$TAG.tgz" > "$TAG.tgz.sha256")
# umask 077 would otherwise leave these as 0600.
chmod 0644 "$R/dist/$TAG.tgz" "$R/dist/$TAG.tgz.sha256"
echo "built $R/dist/$TAG.tgz ($(wc -l < "$ST/team-install.sha256") files)"; cat "$R/dist/$TAG.tgz.sha256"
