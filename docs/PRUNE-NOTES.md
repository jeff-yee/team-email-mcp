# Team email-agent-mcp: trial prune (2026-11-17, PT). Scratch only.

Nothing in dist/, build/ or any live install was touched. dist tgz sha256 is still 7df07bb6…6bcd,
and build/ still matches dist/…files.sha256. No sign-in and no network:
every check ran under `unshare -rn` with fetch blocked, using scratch HOME dirs under scratch-prune/homes/.

## Layout
- build-full/   : copy of build/ (baseline)
- tier-a/ tier-b/ tier-c/ : cumulative trims (tools/prune.sh rebuilds all three from build-full)
- dist-trial/*.tgz : each tier packed exactly like build.sh (install.tar + manifest + launcher, tar czf)
- tools/ : prune.sh, pack.sh, orphans.mjs (dependency-graph orphan finder), run-checks.sh, trace-hook.mjs,
  devicecode-dry.mjs, devicecode-flow-mock.mjs, provider-gmail-stub.js, legacy-guard-unit-test.mjs (path-parametrised copy)
- checks-tier-*.out : check output; loaded-full.txt : every module file loaded across all checks on the full build

## Sizes
| build | tgz (compressed) | unpacked on disk (du) | unpacked bytes | files | packages |
|---|---|---|---|---|---|
| current (repacked build-full; dist is 28,229,471 B) | 28,228,163 B (26.9 MiB) | 141.2 MiB | 102.1 MiB | 12,363 | 226 |
| tier A: safe, no code change | 7,601,443 B (7.2 MiB) | 44.2 MiB | 30.3 MiB | 3,908 | 195 |
| tier B: + unused packages, no code change | 3,198,472 B (3.1 MiB) | 22.1 MiB | 13.9 MiB | 2,418 | 127 |
| tier C: + Google removed (1 stub file) | 2,265,910 B (2.2 MiB) | 16.7 MiB | 10.3 MiB | 1,921 | 83 |

## What each tier removes
**A (no behaviour change):**
- *.map, *.d.ts/.d.mts/.d.cts, .ts sources, READMEs/CHANGELOGs/*.md (license, licence, copying and notice files are kept, including LICENSE.md; tools/license-notices.mjs then fails the build if any package lacks license text)
- msal-node-runtime binaries for macOS (15.1 MiB), Windows (10.4 MiB), and RHEL 8/9 + RHEL 10 (12.2 MiB). Only linux/ubuntu/x64 is kept, which is the one this Debian 13 box picks.
- msal-node-extensions/bin (Windows DPAPI addon), its types/, msal-node-runtime's ESM index (unused: main = index.cjs)
- dist/browser, dist/react-native in @azure/* and @typespec/* (used only under browser/RN export conditions)
- keytar's install-time tree: prebuild-install, node-addon-api, and 29 more packages orphaned with them (tar-fs, rc, simple-get, …); also keytar/src
**B (no code change):**
- @azure/msal-browser (18.3 MiB): only @azure/identity's browser build uses it; the Node ESM build never imports it
- top-level @azure/msal-common: msal-node uses its own nested copy, and msal-node-extensions bundles its own (only its .d.ts referenced it)
- @microsoft/microsoft-graph-client + @babel/runtime: provider-microsoft lists it but never imports it (it calls Graph with fetch)
- the MCP SDK's HTTP/SSE server and client stack: express, hono, @hono/node-server, cors, express-rate-limit, eventsource(-parser), pkce-challenge, jose, cross-spawn, content-type, raw-body, plus the packages orphaned with them (tier B removes 68 packages in all). email-mcp only has a stdio transport.
- msal-node-runtime's linux binary as well. The package's JS (index.cjs) stays because msal-node-extensions imports it statically. With no binary it falls back to "broker unavailable", which is exactly what happens on the box with the binary present (isBrokerAvailable=false).
**C (code change: one stub file):**
- @usejunior/provider-gmail/dist/index.js is replaced by tools/provider-gmail-stub.js. It has the same export names, listConfiguredGmailMailboxes() returns [], and anything else Gmail throws. auth/broker/provider/googleapis-client/push.js are deleted, and the two Google deps are dropped from its package.json.
- Removed: @googleapis/gmail, google-auth-library, googleapis-common, gaxios, gcp-metadata, gtoken, google-p12-pem, node-forge, json-bigint, bignumber.js, node-fetch(+whatwg-url, tr46, webidl-conversions), qs and its side-channel/get-intrinsic tree, uuid, lru-cache, and others (all orphaned).
- Why a stub: server.js initProvider() imports provider-gmail eagerly (a Promise.all alongside provider-microsoft), so deleting the package without the stub would break startup.
- **Security side effect (found during this trial):** the CURRENT team build only blocks Gmail `configure`. If a Gmail token JSON is put in ~/.email-agent-mcp/tokens/ by hand, initProvider still loads it and tries Google OAuth (shown offline: build-full reported "request to https://oauth2.googleapis.com/token failed … EAI_AGAIN"). Tier C ignores the file (status not_configured). Tier C therefore also makes the build genuinely Microsoft-only.

## Device-code sign-in risk
- Runtime path: provider-microsoft auth.js → @azure/identity DeviceCodeCredential → @azure/msal-node (nested msal-common) and @azure/identity-cache-persistence → @azure/msal-node-extensions (FilePersistence on Linux; keytar is tried first, and keytar.node is kept).
- msal-node-runtime (the native broker: WAM, macOS broker) is not on the device-code path. It gets imported but only hit when a broker is enabled, and the team build never enables one.
- Proven offline on tier C: (1) devicecode-dry imports auth, builds the team DeviceCodeCredential, builds an MSAL PublicClientApplication with the same persistence cache plugin, and reads the cache. (2) devicecode-flow-mock runs the real DeviceCodeCredential.getToken through identity → msal-node → cache plugin against an in-process fake HTTP client. The device-code prompt fires (user code FAKE1234), then the mocked "authorization_declined" ends it. No token, no network.
- Not proven offline: a real token round-trip and silent refresh against Entra. Before rollout, run the live verify (verify-install.mjs) on a test user with the trimmed build (needs the tenant admin's OK; it signs in).

## Checks (each tier)
offline-test.mjs **56/56** (tier A, B and C), legacy guard PASS, serve with empty home = demo, 0 fetch, device-code dry 8/8,
MCP stdio via the launcher (manifest regenerated for the scratch copy): draft = 16 tools and 6/6 forbidden calls refused; observe = 11 tools.
configure without client id = TEAM_CLIENT_ID_REQUIRED, Gmail configure refused, and the launcher refuses after a 1-byte edit.

## Platforms
Update: the package is now universal. build.sh adds sha256-pinned keytar 7.9.0 N-API prebuilds for linux-x64, darwin-x64, darwin-arm64 and win32-x64 (loader patched to pick `build/Release/<platform>-<arch>/keytar.node`), prune keeps msal-node-extensions dpapi x64/arm64 (Windows cache encryption), and the installer and launcher are Node, so no bash, find -printf or sha256sum is needed on the target. npm `.bin` links are pruned so the package has no symlinks.
If a native Mac/Windows install were ever wanted, it would need a separate npm install on that OS; per-OS broker binaries wouldn't be enough.

## Making it permanent (proposed build.sh change, NOT applied)
Keep build/ as the canonical patched tree, prune a copy, then hash and tar the pruned copy:
```
P="$R/staging/prune-root"; rm -rf "$P"; cp -a "$B" "$P"
"$R/tools/prune-dir.sh" "$P" C   # = prune.sh's tier A+B+C steps applied to one dir (fails if orphans.mjs errors)
# then use $P instead of $B for team-install.sha256, team-install.links and install.tar
```
- Record the prune in TEAM-BUILD.json ("pruned": "tier-C", stub file sha256) and add tools/provider-gmail-stub.js to src/.
- Re-run the full offline suite plus a live verify on the new tgz. A new tgz means a new launcher hash, so existing installs need reinstalling (they are not affected until then).
- Future dependency bumps: re-run the trace (TRACE=1 tools/run-checks.sh) because the removal list is name-based.
- Not attempted: dropping msal-node's duplicate CJS/ESM builds, zod v3/locales, @typespec dual builds (another ~3–4 MiB unpacked, under 1 MiB compressed), which is riskier for little gain.
