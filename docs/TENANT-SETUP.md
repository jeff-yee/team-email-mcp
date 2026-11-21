# Setting up the team build for your tenant

The tenant admin does these steps once. Each one needs that person's explicit
yes; an approval relayed by a bot or agent doesn't count. Nothing here needs a
client secret, a certificate, or any token.

## 1. Register the team app (Entra admin center)

1. Identity > Applications > App registrations > New registration.
   - Name: `email-agent-mcp-team` (any name works).
   - Supported account types: accounts in this organizational directory only (single tenant).
   - Redirect URI: leave blank.
2. Authentication > Advanced settings > Allow public client flows: Yes (needed for device-code sign-in).
3. API permissions > Microsoft Graph > Delegated: `User.Read`, `offline_access`,
   `Mail.ReadWrite`, `Mail.Read.Shared`. Not `Mail.Send`, not `MailboxSettings.*`,
   not `Mail.ReadWrite.Shared`. No client secret, no certificate.
4. Grant admin consent for your organization. All four rows should show "Granted".
5. Optional: Enterprise applications > the app > Properties > Assignment required: Yes,
   then add the users or groups who may sign in.

Note the Application (client) id and the Directory (tenant) id from the app's
Overview page. Neither is a secret, but they identify your tenant, so they stay
out of this repository.

## 2. Write the build config

Copy `team-build.config.example.json` to `team-build.config.json` in the repo
root (it is git-ignored), or keep it elsewhere and set `TEAM_BUILD_CONFIG` to its path:

```json
{
  "tenantId": "<Directory (tenant) id>",
  "clientId": "<Application (client) id of the team app>",
  "deniedClientIdPrefixes": ["<first 8 hex digits and the dash of any other app id to refuse, e.g. 0123abcd->"],
  "allowNoDeniedClients": false
}
```

`deniedClientIdPrefixes` lists other apps in your tenant that teammates must
never sign in with, for example a full-scope app that holds `Mail.Send`. It is
required: a missing, `null` or empty list stops the build with
`TEAM_BUILD_CONFIG_NO_DENIED_CLIENTS`, so a lost or truncated config cannot
silently drop the guard. If your tenant really has no such app, say so with
`"allowNoDeniedClients": true`. The vendor's default app is always refused.

`tools/make-build-tree.sh` writes these values into the patched
`team-build-config.js`, so they end up inside the hash-pinned package; users
cannot change them afterwards. A missing or invalid config stops the build
with `TEAM_BUILD_CONFIG_MISSING`, and a tree built without one refuses to sign
in. There is no fallback to `organizations` or to any built-in app.
`build.sh` records the tenant id, team client id, denied prefixes and the
opt-out flag in the package's `TEAM-BUILD.json`.

Keep your real config out of any public copy, and record its sha256 next to
it so a changed file is noticed.

## 3. Build and hand out the package

Run `tools/make-build-tree.sh <emptyDir>`, then `BUILD_DIR=<emptyDir> bash build.sh`.
Give teammates the tgz and its `.sha256`. `install.mjs` prints the exact
`configure` command with your team client id filled in.

## 4. Shared mailboxes (per user, optional)

The build reads a shared mailbox only where Exchange already grants the user
access. To grant one: Exchange admin center > Recipients > Mailboxes > the shared
mailbox > Delegation > Read and manage (Full Access) > add the user. PowerShell:
`Add-MailboxPermission -Identity shared-mailbox@example.com -User user@example.com -AccessRights FullAccess -InheritanceType All -AutoMapping $false`.
Propagation can take up to about an hour. The user then lists the mailbox in
their `shared-mailboxes.json` (see the install guide).

## Rollback

Delete the app registration and remove any Full Access grants you added.
