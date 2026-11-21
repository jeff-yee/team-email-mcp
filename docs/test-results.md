# Team email-agent-mcp build: offline test results (2026-11-17, PT)

> **Anonymized record.** This is the record of an offline run of an internal build, with people, mailboxes, paths and notes replaced by example values. The package named below is that internal build; its sha256 matches no public package.

Package: `dist/email-agent-mcp-team-20261117.tgz` sha256 `eabe7e149f7da28142475ba62ffbe177e38dd40ac67854cafb0708a3d759a460`
Base: email-agent-mcp 0.3.2 + @usejunior/* 0.3.5 + the existing read-only shared-mailbox patch + team patch (`patch-team-build.diff`).
All tests were offline: in-process mock of `fetch`, or `unshare -rn` (no network namespace) with scratch HOME / EMAIL_AGENT_MCP_HOME under the repo's scratch/ directory. No sign-in, no Graph call, no real token.

Shared allowlist in this build: **one example shared mailbox (shared-mailbox@example.com) only**.

| # | Test | Result | Evidence |
|---|------|--------|----------|
| 1 | Scopes the draft profile requests: `https://graph.microsoft.com/User.Read offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Read.Shared` (no Mail.Send, no MailboxSettings). Shared-mailbox token: `Mail.Read.Shared` only. draft is the default; `full` is refused. | PASS | tests/offline-test.mjs |
| 2 | MCP tools/list (real launcher over stdio, draft): 16 tools: list_emails, read_email, search_emails, get_mailbox_status, list_mailboxes, get_thread, create_draft, update_draft, list_attachments, download_attachment, download_message, label_email, flag_email, mark_read, move_to_folder, list_folders. Absent: send_email, send_draft, reply_to_email, scheduled-send tools, delete_email, create/delete_folder, all inbox-rule tools. Calling them over MCP returns "unavailable in the team build". observe = 11 read tools. Launcher with profile=full: refuses to start. | PASS | tests/mcp-stdio-test.mjs |
| 3a | Mocked Graph, own mailbox: list/read/search/list_folders/create_draft (POST /me/messages, no /send)/mark_read/flag/move succeed | PASS | tests/offline-test.mjs |
| 3b | send_email, send_draft, reply_to_email, delete_email, rules, delete_folder refused when called (0 fetch, 0 token) | PASS | tests/offline-test.mjs |
| 3c | Second layer (request guard on own mailbox): POST sendMail, /send, /reply, /replyAll, /forward, permanentDelete, DELETE message/folder, any messageRules or mailboxSettings URL, /users/<other>, path traversal: all refused before a token is fetched. createReply* (which only makes drafts) allowed. provider.sendMessage/sendDraft return TEAM_BUILD_REFUSED, not "may have been delivered". | PASS | tests/offline-test.mjs |
| 3d | Shared (shared-mailbox@example.com): list/read allowed (GET /users/shared-mailbox@example.com/... only); mark_read, move, flag, label, create_draft, update_draft, send refused (0 fetch, 0 token) | PASS | tests/offline-test.mjs + tests/legacy-guard-unit-test.mjs |
| 3e | Unlisted shared address: other-shared@example.com and another-shared@example.com entries in shared-mailboxes.json are ignored; a "read-write" entry is ignored; constructing a client for them throws; tool call naming them gives "not configured" | PASS | tests/offline-test.mjs |
| 4 | Missing client id: configure with no id, an empty env var, a non-GUID, the vendor id c4f91d3e, or saved metadata holding c4f91d3e all give TEAM_CLIENT_ID_REQUIRED. Server init with saved metadata lacking clientId errors the mailbox (0 network calls). `token` command disabled; Gmail configure disabled. | PASS | tools/run-checks.sh, tests/serve-no-clientid.mjs |
| 5 | Launcher tamper test (copies): untouched copy starts. It refuses to start for each of: an edited allowlist constant, a 1-byte edit, a deleted file, an added file, a repointed .bin symlink, an edited file with the manifest regenerated (manifest hash is embedded in the launcher), a missing manifest, or a missing install. | PASS | tools/run-checks.sh |
| 6 | install.sh: refuses to replace a non-team install; reinstall over a team build backs it up; a non-empty send-allowlist is backed up and replaced with {"entries": []} | PASS | tests/install-test.mjs |

Totals: offline-test.mjs 56/56, legacy guard test PASS, all CLI/launcher/tamper checks as expected.
