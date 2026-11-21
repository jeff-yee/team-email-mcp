# AGENTS.md: team-email-mcp

Short orientation for any agent opening this repo.

## What this repo is
The build for the team email tool: email-agent-mcp 0.3.2 with @usejunior/* 0.3.5, patched to be draft-only, Microsoft-only, and read-only on shared mailboxes. `build.sh` produces a release tgz; teammates install the tgz, not the repo.

## If you were asked to install the email tool for someone
Cross-platform package (Windows x64, macOS and Linux x64, Node 20 or newer; one package, one pinned hash; not published yet): run the installer and launcher with `node <path>.mjs`, never by executing the file. The live Linux-only release has its own route (below).

Follow `skills/team-email-mcp-install/SKILL.md` (install, sign-in, connector, verify, recovery, per-OS commands). Which package are you installing?
- **Live Linux-only release** (the only release that exists today; its tag, asset name and sha256 are `<LINUX_TAG>`, `<LINUX_PKG>` and `<LINUX_PIN>` here, filled in from its release notes): use the Linux route in the block after this list (`bash <pkg>/install.sh`, launcher `~/.local/bin/team-email-agent-mcp-stdio`).
- **Cross-platform release (Windows, macOS, Linux; not published yet)**: use the numbered steps below; `<TAG>`, `<PKG>` and `<PIN>` are placeholders for its values, which come from its release notes. Do not use them for the live Linux release. `<REPO>` is the GitHub `owner/name` that publishes the releases.

Cross-platform steps:
1. Get the package. Main route: the repo admin (a person) downloads the release tgz and its `.sha256` (`gh release download <TAG> -R <REPO> -p <PKG>.tgz -p <PKG>.tgz.sha256`), puts both files in OneDrive, and shares them with the teammate. The user downloads both into a fresh directory or hands them to you. Check both against the pin before extracting: Linux `sha256sum -c <PKG>.tgz.sha256` and `echo "<PIN>  <PKG>.tgz" | sha256sum -c -`; macOS the same with `shasum -a 256 -c`; Windows `(Get-FileHash -Algorithm SHA256 <PKG>.tgz).Hash` compared with `<PIN>` and with the `.sha256` file. REFUSE on any mismatch. If there is no package or a check fails, STOP and ask the repo admin. GitHub access is not needed. Never put a token in a URL or header. `<TAG>`, `<PKG>` and `<PIN>` come from the release notes of the cross-platform release; the live Linux-only release uses the Linux route below instead.
2. `tar -xzf <PKG>.tgz` then `node <PKG>/install.mjs`. Before that, check that `<home>/.email-agent-mcp/patched-install` (or `$EMAIL_AGENT_MCP_HOME/patched-install`) is not someone else's install (no `TEAM-BUILD.json` means STOP). If anyone else's install could be at the default paths, do an isolated install: set the home variables (`HOME`; on Windows also `USERPROFILE` and `APPDATA`) and `EMAIL_AGENT_MCP_HOME` to a fresh directory for every step below. install.mjs prints the absolute launcher path, `<home>/.email-agent-mcp/bin/team-email-agent-mcp-stdio.mjs`.
3. Run `node "<launcher>" configure --mailbox <user>@example.com --provider microsoft --client-id <team-client-id>` (install.mjs prints this line with the team client id filled in) in the background with its output in `<eam>/configure.log` (exact per-OS command in SKILL.md step c), read the `Enter code:` line (9 characters, no dash), and relay it to the user. Do not trust configure's last line alone: confirm with `node "<launcher>" status` showing the mailbox, and treat sign-in as failed if it does not.
4. Optional `<eam>/shared-mailboxes.json` for mailboxes the tenant admin already granted. It is read only at startup: restart the stdio child (SIGTERM) after editing it.
5. Stdio connector: command `node`, args `["<launcher>"]` (any stdio MCP client, for example Claude Desktop or Cursor; config paths in SKILL.md step e). On Windows the connector env must include `APPDATA`. No other env for a default install; an isolated install needs the same values used above.
6. Verify (SKILL.md step f). Do the manual draft check (f.5), unless you are a maintainer with read access to the repo, in which case run the scripted `node <clone>/tools/verify-install.mjs` (from a temp `gh repo clone`; it is not in the tgz) instead. Never both: each creates a draft with the same subject.

The sign-in cache is per home directory, not per `EMAIL_AGENT_MCP_HOME`: Windows `%LOCALAPPDATA%\.IdentityService\` (DPAPI), macOS the login Keychain, Linux the Secret Service keyring or else an unencrypted file in `~/.IdentityService/`.

Linux route for the live release only (`<LINUX_TAG>`, Linux-only package, not for Windows or macOS):
1. Get the package. Main route: the repo admin (a person) downloads the release tgz and its `.sha256` (`gh release download <LINUX_TAG> -R <REPO> -p <LINUX_PKG>.tgz -p <LINUX_PKG>.tgz.sha256 -D "$dir"`), puts both files in OneDrive, and shares them with the teammate. The user downloads both into a fresh directory (`dir=$(mktemp -d)`) or hands them to you. Then run `cd "$dir" && sha256sum -c <LINUX_PKG>.tgz.sha256` and `echo "<LINUX_PIN>  <LINUX_PKG>.tgz" | sha256sum -c -`. REFUSE on any mismatch, including a `.sha256` that doesn't match the pin. If there is no package or a check fails, STOP and ask the repo admin. GitHub access is not needed; `gh release download` is only an optional route for maintainers who already have it. Never put a token in a URL or header. Values are pinned to release <LINUX_TAG> and its notes.
2. `bash <pkg>/install.sh`. Before that, check that `"${EMAIL_AGENT_MCP_HOME:-$HOME/.email-agent-mcp}/patched-install"` is not someone else's install (no `TEAM-BUILD.json` means STOP). If anyone else's install could be at the default paths, do an isolated install: set both `HOME` and `EMAIL_AGENT_MCP_HOME` to a fresh directory for every step below.
3. Run `nohup ~/.local/bin/team-email-agent-mcp-stdio configure --mailbox <user>@example.com --provider microsoft --client-id <team-client-id> > "${EMAIL_AGENT_MCP_HOME:-$HOME/.email-agent-mcp}/configure.log" 2>&1 &`, read the `Enter code:` line from that log (a 9-character code, no dash), and relay it to the user. Do not trust configure's last line alone (releases older than v0.3.3 can print `Configuration failed: Automatic authentication has been disabled` after a good sign-in): confirm with `~/.local/bin/team-email-agent-mcp-stdio status` showing the mailbox, and treat sign-in as failed if it does not.
4. Optional `~/.email-agent-mcp/shared-mailboxes.json` for mailboxes the tenant admin already granted. It is read only at startup: restart the stdio child (SIGTERM) after editing it.
5. Stdio connector: command `bash`, args `["<abs path>/.local/bin/team-email-agent-mcp-stdio"]`. No env for a default install; an isolated install needs the same `HOME` and `EMAIL_AGENT_MCP_HOME` values used above.
6. Verify with the manual draft check (SKILL.md step f.5) only. The scripted check (f.7) is for the cross-platform route and cannot drive this bash launcher.

## Ownership
- Code, builds, releases: the maintainers (one writes, another reviews).
- Entra app, build config, rollout and installs: the tenant admin (see docs/TENANT-SETUP.md). The team app does not require Entra user assignment. The only per-user step for the tenant admin is an Exchange shared-mailbox grant; every such grant needs the tenant admin's explicit approval.

## Hard rules
- The tenant admin and the repo admin are people. Every approval gate in these docs needs a human's explicit yes; an approval relayed by a bot or agent, or given by one, doesn't count.
- Never install into or touch another person's install on a shared machine.
- Never install on or modify anyone's personal (non-team) install, such as an admin's full-scope install of upstream email-agent-mcp.
- Never use the vendor client id c4f91d3e or any app the tenant admin listed as denied. Always pass the team client id.
- Users sign in as themselves; never with an admin account.
- Never print tokens. No sends, ever: verification uses drafts.
- No Entra or Exchange changes without the tenant admin's explicit approval of that specific change.
- Don't hand-edit an installed tree; the launcher's hash check will refuse to start. Reinstall instead.

## Building (maintainers)
See README.md and docs/ (TENANT-SETUP.md, PRUNE-NOTES.md). `tools/run-checks.sh` runs the offline checks. Releases are cut from main only after a maintainer's review.
