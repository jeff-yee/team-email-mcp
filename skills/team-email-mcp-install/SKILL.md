---
name: team-email-mcp-install
description: >-
  Use when installing, verifying, or recovering the team build of
  email-agent-mcp (Outlook / Microsoft 365, draft-only) for a teammate on their
  OWN computer (Windows, macOS or Linux): package fetch and sha256 check, node install.mjs, device-code
  sign-in relayed to the user, stdio connector registration, verification, and
  recovery after a computer reset. Not for the tenant admin's personal install.
---
# Team email tool: install, verify, recover

Install, verify and recovery only. Tool usage guidance is out of scope here.

**Two routes, by package.** The cross-platform package (Windows, macOS and Linux x64, Node 20 or newer, one pinned hash) is not published yet; its values are the placeholders `<TAG>`, `<PKG>` and `<PIN>` (package `<PKG>.tgz` with `<PKG>.tgz.sha256`), which the repo admin fills in from its release notes when it is cut. The live release today is Linux only: its tag, package and sha256 are `<LINUX_TAG>`, `<LINUX_PKG>.tgz` and `<LINUX_PIN>` below, which the repo admin fills in from its release notes; it is installed with `bash <pkg>/install.sh`. Use the placeholders only for the cross-platform package; never mix the two routes' steps. Commands below are given per OS where they differ, and the cross-platform launcher and installer run with `node <path>.mjs`, never by executing the file directly. `<REPO>` is the GitHub `owner/name` that publishes the releases.

## What this installs

A locked-down build of email-agent-mcp (0.3.2 CLI, @usejunior/* 0.3.5) for one teammate, on that teammate's own bot computer.
- Own mailbox: read, search, drafts, mark read/unread, flag, categorize, move.
- Shared or delegated mailboxes: **read only**, and only where Exchange already grants the user access.
- No send, delete, rules, or mailbox settings. The `token` command and Gmail are disabled.
- Scopes: `User.Read offline_access Mail.ReadWrite Mail.Read.Shared`. App: **email-agent-mcp-team**, client id `<team-client-id>` (install.mjs prints it; the tenant admin sets it in the build config). The tenant is pinned at build time.

## Who does what

The team app does not require Entra user assignment. The only per-user step for the tenant admin is an Exchange grant on a shared mailbox.

| Step | Who |
|---|---|
| Exchange: Full Access / folder share on a shared mailbox | The tenant admin's explicit approval per grant (a human's explicit yes, never relayed by a bot or agent), then the admin who runs Exchange |
| Device-code sign-in | The teammate, as themself |
| Approving the connector in their bot | The teammate |
| Fetch, verify, install, configure, connector, verify, recovery | This agent |

If a step needs the tenant admin or the user, stop and ask; do not work around it.

## Before you start

- You are on the **teammate's own** bot computer, not a machine shared with other people or bots. Never install into or touch another person's install on a shared machine.
- Check for an existing install in the location this install will use: `${EMAIL_AGENT_MCP_HOME:-$HOME/.email-agent-mcp}/patched-install` (Windows: `%USERPROFILE%\.email-agent-mcp\patched-install` unless `EMAIL_AGENT_MCP_HOME` is set). If it exists and has no `TEAM-BUILD.json`, STOP: that is a personal install (possibly the tenant admin's) and must not be touched.
- Default install or isolated install? The default uses your home directory and `<home>/.email-agent-mcp`. If anyone else's install could be at those paths, or you need your own copy, use an isolated install: pick a fresh directory and set `HOME` (and on Windows `USERPROFILE` and `APPDATA`) plus `EMAIL_AGENT_MCP_HOME` to it, and use the same values for install, configure, `status`, verify and the connector (step e). The sign-in cache follows the home directory (`HOME` on macOS/Linux, `APPDATA` on Windows), not `EMAIL_AGENT_MCP_HOME`, so two installs that share a home share one cache.
- `node -v` is 20 or newer.
- You know the user's address (`<user>@example.com`) and which shared mailboxes the tenant admin has already granted them (may be none).

## a) Get the package

Main route: the repo admin hands out the package through OneDrive, and you check it against the pinned hash. You do not need GitHub access.

**Repo admin (a person), once per release.** Download the release tgz and its `.sha256`, put both files in OneDrive, and share them with the teammate:

```bash
# cross-platform release (not published yet); its values come from its release notes
gh release download <TAG> -R <REPO> -p <PKG>.tgz -p <PKG>.tgz.sha256 -D <empty dir>

# live Linux-only release <LINUX_TAG>
dir=$(mktemp -d)
gh release download <LINUX_TAG> -R <REPO> \
  -p <LINUX_PKG>.tgz \
  -p <LINUX_PKG>.tgz.sha256 \
  -D "$dir"
```

**You (the installing agent).** Get both files from the user: the user downloads them from the OneDrive share into a fresh empty directory or hands them over. Then run exactly, for that OS:

Linux:
```bash
cd <dir>
sha256sum -c <PKG>.tgz.sha256
echo "<PIN>  <PKG>.tgz" | sha256sum -c -
```
macOS:
```bash
cd <dir>
shasum -a 256 -c <PKG>.tgz.sha256
echo "<PIN>  <PKG>.tgz" | shasum -a 256 -c -
```
Windows (PowerShell):
```powershell
cd <dir>
$got = (Get-FileHash -Algorithm SHA256 <PKG>.tgz).Hash.ToLower()
$file = (Get-Content <PKG>.tgz.sha256).Split(' ')[0]
if ($got -eq "<PIN>" -and $file -eq "<PIN>") { "OK" } else { "MISMATCH: $got" }
```

Linux and macOS must print `OK` twice; Windows must print `OK`. REFUSE on any mismatch, including a `.sha256` file that does not match the pin (that catches a swapped `.sha256` or a tampered tgz). If either file is missing, or a check fails, STOP and ask the repo admin. Never extract or install an unverified package. Never put a token in a URL or header, and never ask for, print, paste, or set a token. The tag, asset names and sha256 come from the release notes.

**Live Linux-only release (the only published release today):** use its tag, asset name and sha256 from its release notes for `<LINUX_TAG>`, `<LINUX_PKG>` and `<LINUX_PIN>`, with the Linux commands:

```bash
cd "$dir"
sha256sum -c <LINUX_PKG>.tgz.sha256
echo "<LINUX_PIN>  <LINUX_PKG>.tgz" | sha256sum -c -
```

Both commands must print `OK`. REFUSE on any mismatch, including a `.sha256` file that does not match the pin (the second command catches a swapped `.sha256` or a tampered tgz). If either file is missing, or either check fails, STOP and ask the repo admin. Never install an unverified package. Never put a token in a URL or header, and never ask for, print, paste, or set a token. The tag, asset names and sha256 are pinned to release <LINUX_TAG> and its notes.

Optional, for maintainers who already have GitHub access: run the admin's `gh release download` command above yourself, then the same checks. Do not ask for GitHub access just to install.

## b) Install

From the same directory (the files that passed the checks), on any OS (`tar` ships with Windows 10 and later, macOS and Linux):

```bash
tar -xzf <PKG>.tgz
node <PKG>/install.mjs
```

**Live Linux-only release <LINUX_TAG>** installs with its `install.sh` instead (Linux only):

```bash
tar xzf <LINUX_PKG>.tgz
bash <LINUX_PKG>/install.sh
```

`install.mjs` (and the live release's `install.sh`) checks every package file's sha256, refuses to replace a non-team install, puts the server in `<home>/.email-agent-mcp/patched-install`, the launcher in `<home>/.email-agent-mcp/bin/team-email-agent-mcp-stdio.mjs` (the live release's `install.sh` puts a bash launcher at `~/.local/bin/team-email-agent-mcp-stdio` instead), writes an empty `send-allowlist.json` (it never adds addresses), and runs an offline smoke test. No network, no tokens. It prints the absolute launcher path; use it below as `<launcher>`.
- If it says the install "is not a team build. Refusing to replace it", STOP and ask. Never pass `--replace-existing` on your own.
- For the cross-platform package, `install.sh` in the package is a deprecated one-line wrapper around `node install.mjs`, kept for one release; use `node install.mjs`.

## c) Sign in (device code, relayed)

The commands in steps c to f are for the cross-platform package, where the launcher is `node "<launcher>"`. For the live Linux-only release <LINUX_TAG>, run the same commands with its launcher instead: `bash ~/.local/bin/team-email-agent-mcp-stdio` in place of `node "<launcher>"` (connector command `bash`, args `["<abs path>/.local/bin/team-email-agent-mcp-stdio"]`), and ignore the Windows and macOS parts. For that release, verify with the manual draft check (step f.5) only; skip step f.7.

Run configure in the background so it keeps waiting, with its output in a log (`<eam>` is `EMAIL_AGENT_MCP_HOME`, default `<home>/.email-agent-mcp`):

macOS / Linux:
```bash
nohup node "<launcher>" configure --mailbox <user>@example.com --provider microsoft \
  --client-id <team-client-id> > "<eam>/configure.log" 2>&1 &
```
Windows (PowerShell):
```powershell
Start-Process -WindowStyle Hidden node -ArgumentList '"<launcher>"','configure','--mailbox','<user>@example.com','--provider','microsoft','--client-id','<team-client-id>' -RedirectStandardOutput "<eam>\configure.log" -RedirectStandardError "<eam>\configure.err.log"
```
Read the `Enter code:` line from the log (on Windows check both log files; wait a few seconds if it is not there yet). The code is 9 characters with no dash (for example `ABCDEFGHI`). Then tell the user right away, in one message (do not wait or batch it with other updates; the code is only valid for 15 minutes):
> Open https://login.microsoft.com/device, enter code **<the 9-character code>**, and sign in as **<user>@example.com** (your normal account, not an admin account).

- Relay only the device code and URL. Never print or paste tokens.
- **Do not trust the last line of configure alone.** On releases older than v0.3.3 configure prints `❌ Configuration failed: Automatic authentication has been disabled…` even though sign-in worked. After the user says they signed in, run `node "<launcher>" status` (with the same home and `EMAIL_AGENT_MCP_HOME` as configure): sign-in is confirmed only when `status` shows `<user>@example.com` connected. If `status` does not show it, treat sign-in as failed, then re-run configure and send a new code. If configure fails with any other message, it failed.
- `TEAM_CLIENT_ID_REQUIRED` means `--client-id` was missing.
- If the code expires (15 minutes; configure reports `device_code_expired`), re-run the same command and relay the new code to the user right away.

## d) Shared mailboxes (optional, read only)

Only for mailboxes the tenant admin has already granted this user. Write `<eam>/shared-mailboxes.json` (mode 0600 on macOS/Linux):
```json
{ "mailboxes": [
  { "name": "shared-mailbox", "emailAddress": "shared-mailbox@example.com",
    "viaSignedInMailbox": "<user>@example.com", "access": "read-only" }
] }
```
`access` must be `read-only`. There is no local allowlist: Exchange permissions are the gate, and an ungranted mailbox returns Graph 403/404. The connector reads this file only when it starts, so after you create or edit it, restart the stdio child (send it SIGTERM and the client starts a fresh one on the next tool call, or restart the client) before you verify. Adding an entry never grants access; do not ask for grants on the user's behalf beyond passing the request to the tenant admin.

## e) Register the connector (stdio)

Add a stdio MCP connector in the teammate's client. The command is always `node` and the only argument is the absolute launcher path that install.mjs printed. If the client cannot find `node` (common for desktop apps on macOS), use the absolute node path instead (`command -v node` on macOS/Linux, `(Get-Command node).Source` on Windows).

- **A bot platform or any other stdio MCP client:** name `team-email` (any), command `node`, args `["<launcher>"]`.
- **Claude Desktop:** edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then fully quit and reopen Claude.
- **Cursor:** `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`) for all projects.

```json
{ "mcpServers": { "team-email": { "command": "node", "args": ["<launcher>"] } } }
```
On Windows, JSON paths need doubled backslashes (`"C:\\Users\\<you>\\.email-agent-mcp\\bin\\team-email-agent-mcp-stdio.mjs"`), and the connector **must** have `APPDATA` in its environment: the launcher refuses to start without it, because the sign-in cache path is built from it. Some clients start servers with a reduced environment, so set it explicitly: `"env": { "APPDATA": "C:\\Users\\<you>\\AppData\\Roaming" }`.

env otherwise: none for a **default** install (defaults: `EMAIL_AGENT_MCP_HOME=<home>/.email-agent-mcp`, profile `draft`). For an **isolated** install, set the same values you used for install and configure (`HOME`, on Windows also `USERPROFILE` and `APPDATA`, and `EMAIL_AGENT_MCP_HOME`).

The user approves the connector.

## f) Verify

If the first call you make is `get_mailbox_status` (or `list_mailboxes`) and it returns `pending` or `connecting`, or a warning that the provider is warming up, wait a few seconds and retry once before treating it as a problem.

1. `node "<launcher>" status` shows `<user>@example.com`.
2. The connector's tool list has the draft profile (16 tools) and **no** send_email, send_draft, reply_to_email, delete or rule tools.
3. `list_mailboxes` shows the user (default) and each shared entry. For the user's own mailbox `emailAddress` can be `null`, and a shared entry shows status `unverified` (it is not probed until a read succeeds). Both are normal, not failures.
4. `list_emails` on the user's inbox returns messages.
5. `create_draft` to the user's own address with subject `TEAM-EMAIL INSTALL TEST - delete me`; tell the user it is in Drafts to delete by hand. Do not try to send it. **Skip this step if you run step 7** (maintainers with repo access): the scripted check creates a real draft with the same subject, so do one or the other, not both.
6. For each shared mailbox: `list_emails` works, `read_email` leaves `isRead` unchanged, and `create_draft` / `mark_read` against it are refused (`SHARED_MAILBOX_READ_ONLY` or 403/404).
7. Choose **one** of step 5 or step 7, never both: each creates a draft with the same subject. Step 7 is the scripted check for the cross-platform route only (`verify-install.mjs` starts the launcher with `node`, so it cannot drive the live v0.3.3 bash launcher; use step 5 there). It is only for agents that already have read access to the repo (the maintainer route). Everyone else, including an installer with no GitHub access, does step 5 and skips step 7. Step 7 covers steps 2 to 6 and creates the draft. `tools/verify-install.mjs` is not in the release tgz, so clone the repo into a temp directory and only run it from there, read-only (never edit or install from the clone), on any OS:
   ```bash
   gh repo clone <REPO> <temp dir>
   node <temp dir>/tools/verify-install.mjs <user>@example.com [<shared>@example.com]
   ```
   It finds the launcher and install under `EMAIL_AGENT_MCP_HOME` (default `<home>/.email-agent-mcp`); pass `--launcher` / `--install` otherwise. For an isolated install, run it with the same environment as step e.

Report pass/fail per step. On any failure, stop and report; do not patch files.

## Recovery

| Symptom | Cause | Fix |
|---|---|---|
| Launcher says `REFUSING to start` | An installed file changed, or (Windows) `APPDATA` is missing from the connector env | Add `APPDATA` if that is what it says; otherwise re-run `node install.mjs` from the verified package. Never hand-edit installed files. |
| Connector worked with the old bash launcher, now refuses | `~/.local/bin/team-email-agent-mcp-stdio` belongs to the older Linux-only release | Point the connector at `node <launcher>` (step e) |
| Tools missing / connector errors / launcher not found after a computer reset | `<home>/.email-agent-mcp` wiped | Steps a, b, then c, d, and re-check e |
| `Cannot find module …keytar.node` | Unsupported OS/CPU (for example Windows on ARM with ARM64 Node, or Linux ARM) | STOP and tell the repo admin; there is no build for it yet |
| `error while loading shared libraries: libsecret-1.so.0` (Linux; `configure` exits 1) | The Secret Service client library is not installed | STOP and ask the machine's admin to install `libsecret-1-0` (the libsecret package on their distro). Do not install system packages yourself. |
| Demo mode, or "re-auth needed" | The MSAL cache (see below) was wiped, or the refresh token expired | Step c again (same command, same client id) |
| macOS: sign-in or start fails with `Unable to read from the macOS Keychain` | The login Keychain is locked or the prompt was denied | Ask the user to unlock the Keychain and allow access, then step c again. There is no unencrypted fallback on macOS. |
| Shared mailbox missing | `shared-mailboxes.json` lost, or edited after the connector started (it is read only at startup) | Step d again, then restart the stdio child (SIGTERM) |
| New build installed but old behavior | The running stdio child still has the old tree loaded | Stop that child process (SIGTERM); the next tool call respawns it. A connector restart alone may not. |
| `search_emails` with offset > 0 fails (Graph 400 SearchWithSkip) | Known upstream limit, not an install fault | Page with `list_emails` instead |
| No package, a missing `.sha256`, or a hash mismatch (either check in step a fails) | The files were not handed over, are corrupt or tampered, or are the wrong release | STOP and ask the admin (the repo admin). Do not install, and do not fetch the package some other way. |
| Sign-in fails with an `AADSTS` error saying the account is in the wrong tenant, is a guest account, or that consent is needed | The account is not a normal member of the tenant, or the app needs a tenant-level approval | STOP and ask the tenant admin. Do not retry with another account, do not use an admin account, and do not change anything in Entra. |

Upgrades: get the new release, check its sha256, run `node install.mjs` (it backs up the old team install), restart the stdio child, verify again. The sign-in cache survives.

Good to know:
- Where the MSAL sign-in cache lives (one cache per home directory, shared by every install under that home, not per `EMAIL_AGENT_MCP_HOME`; names start `email-agent-mcp-<user>@example.com-`):
  - Windows: `%LOCALAPPDATA%\.IdentityService\` (the code takes `%APPDATA%` and swaps `Roaming` for `Local`), encrypted with DPAPI for the current Windows user.
  - macOS: the login Keychain (service `Microsoft.Developer.IdentityService`), plus a marker file in `~/.IdentityService/`. If the Keychain cannot be read, sign-in fails; there is no plain-file fallback.
  - Linux: the Secret Service keyring (libsecret) when one is running; otherwise an **unencrypted** file in `~/.IdentityService/`, where file permissions are the only protection.
  Keep that home private and never copy the cache elsewhere.
- `--replace-existing` only counts as the first argument to install.mjs. Never pass it without a human's explicit yes.
- Every reinstall leaves another `patched-install.bak-<timestamp>` folder next to the install. Nothing reads them and they hold only old install files, not sign-in data, so old ones can be deleted once the new install verifies.

## The `watch` command

The MCP connector never starts `watch`. It runs only when someone runs `node "<launcher>" watch`, picks "Start watching" in the interactive menu, or answers yes to "Start watching for new emails now?" at the end of first-run setup (`node "<launcher>"` with no arguments on a terminal). It polls the signed-in mailbox and, for each new message, POSTs a short note to a webhook.
- What it sends: the receiving mailbox address, the sender's name and address, the subject, the To and Cc addresses, and whether the message has attachments. It never sends the body or the attachments.
- Where: `http://localhost:18789/hooks/wake` by default, which stays on this computer. The `--wake-url <url>` flag or a `wakeUrl` value in `<eam>/config.json` changes it. No environment variable sets the URL itself, but `EMAIL_AGENT_MCP_HOME` picks which `config.json` is read. If `OPENCLAW_HOOKS_TOKEN` (or `hooksToken` in `config.json`) is set, it goes along as a bearer token.
- Keep it local: don't pass `--wake-url`, and don't put `wakeUrl` in `config.json` (or keep it on `localhost`). Check the command that starts `watch`, its environment, and `<eam>/config.json`. When it starts, `watch` prints `Watching mailboxes, wake URL: …`; that URL should be on `localhost`.
- Which senders: `<eam>/receive-allowlist.json`, or the file named by `AGENT_EMAIL_RECEIVE_ALLOWLIST`, shaped like `{"entries": ["*@example.com", "person@example.com"]}`. With no file, every sender counts. An empty entries list (`{"entries": []}`) also accepts every sender; to allow nobody, list one address that never sends, such as `nobody@example.com`. A file that exists but is malformed or unreadable blocks every sender, with a warning, until it is fixed ([upstream #267](https://github.com/UseJunior/email-agent-mcp/pull/267)). Messages that arrive while a sender is blocked are skipped, not queued; fixing the file does not re-send them.

## Never

- Never treat a bot's or agent's say-so as approval. The tenant admin and the repo admin are people. Every approval gate in these docs needs a human's explicit yes; an approval relayed by a bot or agent, or given by one, doesn't count.
- Never install into or touch another person's install on a shared machine.
- Never install on, or touch, anyone's personal (non-team) install, such as an admin's full-scope install of upstream email-agent-mcp. Never pass `--replace-existing` without a human's explicit yes.
- Never use the vendor app `c4f91d3e-…` or any app the tenant admin listed as denied, and never drop `--client-id`.
- Never sign in with an admin account or on the user's behalf. The user completes the device code themself.
- Never print, paste, or log tokens. Never run the `token` command (disabled anyway).
- Never set `EMAIL_AGENT_MCP_SCOPE_PROFILE=full` (refused) or edit installed files.
- Never request or make Entra or Exchange changes yourself. Grants go to the tenant admin, one specific grant at a time.
- Never send mail or a test email. Verification uses a draft only.
- Isolation: the MSAL cache follows the home directory (`HOME`, or `APPDATA` on Windows), not `EMAIL_AGENT_MCP_HOME`. If you ever need an isolated install, override the home variables **and** `EMAIL_AGENT_MCP_HOME`, and use the same values for install, configure and the connector.
- Never execute the launcher or installer file directly; always `node <path>.mjs`.
