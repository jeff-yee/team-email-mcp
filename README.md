# team-email-mcp

Team packaging of email-agent-mcp 0.3.2 (`@usejunior` 0.3.5) with local patches and a pruned install.

This repository holds the patches against upstream, the build and prune scripts, and offline tests. It does not vendor `node_modules`, tokens, MSAL caches, or live install trees.

## Installing the email tool

Teammates install the release package, not this repository. Two routes exist. The live Linux-only release (tag, asset and sha256 shown as `<LINUX_TAG>`, `<LINUX_PKG>` and `<LINUX_PIN>`, from its release notes) is installed with `bash install.sh`. Packages built from this tree run on Windows, macOS and Linux with Node 20 or newer (installed with `node install.mjs`); that cross-platform release does not exist yet, so its tag, asset name and sha256 appear in the guide as `<TAG>`, `<PKG>` and `<PIN>`. The repo admin hands the package out through OneDrive (the release tgz and its `.sha256`), and the installer checks it against the pinned sha256.

If you are an agent doing the install, follow [AGENTS.md](AGENTS.md) and [skills/team-email-mcp-install/SKILL.md](skills/team-email-mcp-install/SKILL.md). Those files hold the steps; this README does not repeat them.

Installing does not need GitHub access. If you have no package or a hash check fails, ask the repo admin.

## The `watch` command

`watch` is kept but optional. For each new message it POSTs the sender, subject and To/Cc addresses (never the body) to a webhook, `http://localhost:18789/hooks/wake` by default. Only the `--wake-url` flag or `wakeUrl` in `config.json` moves it off this computer; there is no environment variable for the URL. A malformed or unreadable receive allowlist blocks every sender. Messages from blocked senders are skipped, not queued. Details: [skills/team-email-mcp-install/SKILL.md](skills/team-email-mcp-install/SKILL.md#the-watch-command) and [package/README.md](package/README.md).

## Building (maintainers)

- Build config: copy `team-build.config.example.json` to `team-build.config.json` (untracked) and fill in your tenant id and team app client id, or point `TEAM_BUILD_CONFIG` at such a file. See [docs/TENANT-SETUP.md](docs/TENANT-SETUP.md). Without it the build refuses (`TEAM_BUILD_CONFIG_MISSING`); there is no built-in tenant or app.
- Patched tree: `tools/make-build-tree.sh <emptyDir>`
- Build: `build.sh` (set `BUILD_DIR` if the patched tree is not `./build`)
- Offline checks: `tools/run-checks.sh <installDir> <label>` and `node tests/offline-test.mjs <installDir>`
- The check scripts default to this repository root. Override with `TEAM_EMAIL_MCP_ROOT` if the scratch homes should live somewhere else.

See [package/README.md](package/README.md) and [docs/](docs/) for package layout, tenant setup, and an anonymized test record.

## Publishing a copy

See [docs/PUBLISHING.md](docs/PUBLISHING.md): a new, empty repository with one import commit made by `tools/export-public.sh` (exactly the files in `tools/public-manifest.txt`), and `tools/public-rescan.sh` over the export and a tgz built from it before anything is pushed. Never copy a working directory: untracked sign-in data and scratch files can sit next to it.

## License

Apache-2.0 (see [LICENSE](LICENSE)). This build includes and modifies email-agent-mcp by UseJunior; see [NOTICE](NOTICE). Release packages also carry `THIRD-PARTY-NOTICES` for every bundled npm package.
