# email-agent-mcp — team build

A locked-down build of email-agent-mcp (0.3.2 CLI, @usejunior/* 0.3.5) for each
teammate's **own** computer or bot. Not for anyone's personal (full-scope) install, which stays separate.

What it can do (the `draft` scope profile, the default and the only write-capable profile):
- Your own mailbox: list, search and read mail and threads, list folders and attachments,
  create and edit **drafts**, mark read/unread, flag, categorize, move to a folder.
- Shared / delegated mailboxes: **read only**, for any mailbox Exchange already permits the
  signed-in user to read (`sharedTargetPolicy` defaults to `exchange` in
  `@usejunior/provider-microsoft/dist/team-build-config.js`). There is no local address
  allowlist. An unpermitted mailbox surfaces Graph's own 403 or 404. A second policy,
  `shared-mailbox-only`, is implemented as a config flip but currently fails closed,
  because the current scopes cannot prove a target is a shared mailbox.

What it cannot do: send (send_email, send_draft, reply_to_email, scheduled sends), delete mail or
folders, create folders, read or change inbox rules or mailbox settings, or write anything
in a mailbox other than the signed-in user's own. Those tools are absent from the tool
list, refused if called, and refused again at the Graph request layer before a token is used.
The `token` command (which prints a raw access token) and Gmail setup are disabled.
`EMAIL_AGENT_MCP_SCOPE_PROFILE` can be `draft` (default) or `observe` (read only); `full` is refused.

Microsoft scopes requested: `User.Read offline_access Mail.ReadWrite Mail.Read.Shared`
(no Mail.Send, no MailboxSettings.*). You must always pass the team app's client id (install.mjs prints it);
the build refuses to fall back to the package vendor's app.

**Requirements:** Windows (x64), macOS (Apple silicon or Intel) or Linux (x64), and Node 20 or newer. One package covers all three. The repo admin hands the tgz and its `.sha256` out through OneDrive; no GitHub access is needed. Run the installer and launcher with `node <file>.mjs`.

## 1. Install (once per computer)
Verify first; refuse on any mismatch, and do not extract an unverified package. `<PIN>` is the pinned sha256 from the release notes.
```bash
# Linux
sha256sum -c email-agent-mcp-team-YYYYMMDD.tgz.sha256
echo "<PIN>  email-agent-mcp-team-YYYYMMDD.tgz" | sha256sum -c -
# macOS
shasum -a 256 -c email-agent-mcp-team-YYYYMMDD.tgz.sha256
echo "<PIN>  email-agent-mcp-team-YYYYMMDD.tgz" | shasum -a 256 -c -
```
```powershell
# Windows (PowerShell): must equal <PIN> and the value in the .sha256 file
(Get-FileHash -Algorithm SHA256 email-agent-mcp-team-YYYYMMDD.tgz).Hash.ToLower()
```
Then, on any OS:
```bash
tar -xzf email-agent-mcp-team-YYYYMMDD.tgz
node email-agent-mcp-team-YYYYMMDD/install.mjs
```
This puts the install in `<home>/.email-agent-mcp/patched-install`, its file manifest in
`<home>/.email-agent-mcp/team-install.sha256` (+ `.links`, empty: the package has no symlinks), an empty
`send-allowlist.json` (never seeded with addresses), and the launcher in
`<home>/.email-agent-mcp/bin/team-email-agent-mcp-stdio.mjs`; it prints the absolute launcher path
(`<launcher>` below). It refuses to replace an existing non-team install. `install.sh` is a
deprecated wrapper that runs `node install.mjs` (kept for one release).

`EMAIL_AGENT_MCP_HOME` defaults to `<home>/.email-agent-mcp`. If you change it, set the same value
for install.mjs, configure and the connector. `--replace-existing` only counts as install.mjs's first
argument. Every reinstall leaves another `patched-install.bak-<timestamp>` folder (old install
files only; nothing reads them).

The MSAL sign-in cache is per home directory, separate from `EMAIL_AGENT_MCP_HOME`, and shared by
every install under that home (names start `email-agent-mcp-<you>@example.com-`):
- Windows: `%LOCALAPPDATA%\.IdentityService\` (derived from `%APPDATA%`), DPAPI-encrypted for the Windows user.
- macOS: the login Keychain (service `Microsoft.Developer.IdentityService`) plus a marker file in `~/.IdentityService/`; no plain-file fallback.
- Linux: the Secret Service keyring if one is running, else an unencrypted file in `~/.IdentityService/`
  (file permissions are the only protection).
For an isolated install, override the home variables (`HOME`; on Windows also `USERPROFILE` and `APPDATA`)
and `EMAIL_AGENT_MCP_HOME`.

## 2. Sign in (device code, once)
```bash
node "<launcher>" configure \
  --mailbox <you>@example.com --provider microsoft --client-id <team-client-id>
```
Open https://login.microsoft.com/device, enter the code it prints (9 characters, no dash), sign in as **yourself**
(`<you>@example.com`, not an admin account). Without `--client-id` (or a saved one) it stops with
`TEAM_CLIENT_ID_REQUIRED`.

## 3. Shared mailboxes (optional, read-only)
Create `<home>/.email-agent-mcp/shared-mailboxes.json`:
```json
{
  "mailboxes": [
    { "name": "shared-mailbox", "emailAddress": "shared-mailbox@example.com",
      "viaSignedInMailbox": "<you>@example.com", "access": "read-only" }
  ]
}
```
A strict SMTP address is accepted in this file under the default `exchange` policy
(values with `/`, `?`, `#`, `%`, or whitespace are refused; local part at most 64
characters, whole address at most 254). Entries whose access is not `read-only`,
and entries whose address is a signed-in mailbox (matched case-insensitively,
regardless of `viaSignedInMailbox`, including a mailbox whose sign-in failed),
are ignored so your own mailbox stays on `/me` (read plus draft) and is not listed twice. Writes to any mailbox other than
your own are refused before a token is fetched. It only works after Exchange has granted
you permission on that mailbox (Full Access, or a folder-level share that `Mail.Read.Shared`
can see). Graph 403/404 is the access control, not a local address list.
The connector reads this file only at startup: after editing it, restart the connector's stdio process (SIGTERM, then the client restarts it, or restart the client).

## 4. Register as a stdio MCP connector
- command: `node` (or the absolute node path if the client can't find it)
- args: `["<launcher>"]`, the absolute path install.mjs printed
- Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
  `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Cursor: `~/.cursor/mcp.json`
  (Windows `%USERPROFILE%\.cursor\mcp.json`). Shape: `{"mcpServers": {"team-email": {"command": "node", "args": ["<launcher>"]}}}`
- Windows: the connector env must include `APPDATA` (e.g. `"env": {"APPDATA": "C:\\Users\\<you>\\AppData\\Roaming"}`);
  the launcher refuses to start without it. JSON paths need doubled backslashes.
- no other env for a default install (defaults: `EMAIL_AGENT_MCP_HOME=<home>/.email-agent-mcp`, profile `draft`); an isolated install needs the same home variables and `EMAIL_AGENT_MCP_HOME` as install.mjs and configure

## 5. Verify
- `node "<launcher>" status` shows your mailbox.
- In the bot: `list_mailboxes` shows you (+ shared ones, status `unverified` until a read is tried); `tools/list` has no send/delete/rule tools.
- Create a test draft to yourself and check Outlook Drafts; do not expect it to send.
- If the launcher says `REFUSING to start`, a file changed (or, on Windows, `APPDATA` is missing): re-run `node install.mjs` from the package.

## 6. After a reset of the bot's computer
A reset can wipe the sign-in cache (above) and/or `<home>/.email-agent-mcp`. The connector then
falls back to demo mode or errors with re-auth needed. Re-run `node install.mjs` if the launcher is gone,
then repeat step 2 (same command, same client id). Shared-mailboxes.json must be recreated if lost.

## 7. The `watch` command (optional)
The MCP connector never starts `watch`. It runs only when someone runs `node "<launcher>" watch`, picks "Start watching" in the interactive menu, or answers yes to "Start watching for new emails now?" at the end of first-run setup (`node "<launcher>"` with no arguments on a terminal). It polls the signed-in mailbox and, for each new message, POSTs a short note to a webhook.
- What it sends: the receiving mailbox address, the sender's name and address, the subject, the To and Cc addresses, and whether the message has attachments. It never sends the body or the attachments.
- Where: `http://localhost:18789/hooks/wake` by default, which stays on this computer. The `--wake-url <url>` flag or a `wakeUrl` value in `<home>/.email-agent-mcp/config.json` changes it. No environment variable sets the URL itself, but `EMAIL_AGENT_MCP_HOME` picks which `config.json` is read. If `OPENCLAW_HOOKS_TOKEN` (or `hooksToken` in `config.json`) is set, it goes along as a bearer token.
- Keep it local: don't pass `--wake-url`, and don't put `wakeUrl` in `config.json` (or keep it on `localhost`). Check the command that starts `watch`, its environment, and `<home>/.email-agent-mcp/config.json`. When it starts, `watch` prints `Watching mailboxes, wake URL: …`; that URL should be on `localhost`.
- Which senders: `<home>/.email-agent-mcp/receive-allowlist.json`, or the file named by `AGENT_EMAIL_RECEIVE_ALLOWLIST`, shaped like `{"entries": ["*@example.com", "person@example.com"]}`. With no file, every sender counts. An empty entries list (`{"entries": []}`) also accepts every sender; to allow nobody, list one address that never sends, such as `nobody@example.com`. A file that exists but is malformed or unreadable blocks every sender, with a warning, until it is fixed ([upstream #267](https://github.com/UseJunior/email-agent-mcp/pull/267)). Messages that arrive while a sender is blocked are skipped, not queued; fixing the file does not re-send them.
