// Parameterized copy of verify.mjs (2026-10-29): read-only shared mailbox check. Never prints tokens.
// Run: tools/verify-mailbox.sh <name> <address>   (VERIFY_OWNER=<signed-in mailbox> is required)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs'; import os from 'node:os'; import assert from 'node:assert/strict';
import { join } from 'node:path';
function resolveInstallDir(env = process.env) {
  const raw = env.EAM_INSTALL_DIR || env.EAM_NPX_DIR || join(os.homedir(), '.email-agent-mcp', 'patched-install');
  return String(raw).replace(/\/+$/, '');
}
const INSTALL = resolveInstallDir();
if (process.env.EAM_PRINT_INSTALL_DIR === '1') {
  process.stdout.write(INSTALL + '\n');
  process.exit(0);
}
if (!fs.existsSync(INSTALL) || !fs.statSync(INSTALL).isDirectory()) {
  console.error(`verify-mailbox: install dir missing or not a directory: ${INSTALL}`);
  console.error('Set EAM_INSTALL_DIR to the team patched-install path (default: ~/.email-agent-mcp/patched-install).');
  process.exit(2);
}
if (!fs.existsSync(join(INSTALL, 'node_modules', '@usejunior'))) {
  console.error(`verify-mailbox: expected node_modules/@usejunior missing under ${INSTALL}`);
  console.error('Set EAM_INSTALL_DIR to the team patched-install path (default: ~/.email-agent-mcp/patched-install).');
  process.exit(2);
}
const NM = `${INSTALL}/node_modules`;
const imp = p => import(pathToFileURL(`${NM}/${p}`).href);
const pm = await imp('@usejunior/provider-microsoft/dist/index.js');
const { Client } = await imp('@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await imp('@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const SHARED = (process.env.VERIFY_SHARED || 'support@example.com').toLowerCase(), MBX = process.env.VERIFY_MBX || 'support';
const OWNER = String(process.env.VERIFY_OWNER || '').trim().toLowerCase();
if (!OWNER) { console.error('verify-mailbox: set VERIFY_OWNER to the signed-in mailbox whose token metadata to use.'); process.exit(2); }
console.log(`      target: ${MBX} <${SHARED}>`);
const short = id => String(id).slice(0, 10) + '…' + String(id).slice(-8);
let failures = 0;
const step = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}: ${String(e?.message ?? e).replace(/eyJ[\w.-]+/g, '<jwt>')}`); } };

// 1. Refresh the shared-scope token; print scope names only.
const meta = JSON.parse(fs.readFileSync(join(process.env.EMAIL_AGENT_MCP_HOME || join(os.homedir(), '.email-agent-mcp'), 'tokens', `${OWNER}.json`), 'utf8'));
const auth = new pm.DelegatedAuthManager({ mode: 'delegated', clientId: meta.clientId, tenantId: meta.tenantId }, meta.mailboxName);
await auth.reconnect();
let token = null;
await step('1 token refresh with Mail.Read.Shared', async () => {
  token = await auth.getAccessTokenForScopes(pm.SHARED_MAILBOX_SCOPES);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  console.log(`      scopes: ${claims.scp}`);
  console.log(`      expires: ${new Date(claims.exp * 1000).toISOString()}`);
  assert.ok(String(claims.scp).split(' ').includes('Mail.Read.Shared'), 'Mail.Read.Shared not in token scp');
});
// Independent isRead probe: plain GET, $select only (never PATCH).
const probeIsRead = async id => {
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${SHARED}/messages/${encodeURIComponent(id)}?$select=isRead`, { headers: { Authorization: `Bearer ${token}` } });
  const b = await r.json(); if (!r.ok) throw new Error(`probe GET ${r.status} ${b?.error?.code}`); return b.isRead;
};

// MCP stdio client against a fresh server process (same patched code the connector runs).
const transport = new StdioClientTransport({ command: process.execPath, args: [`${NM}/.bin/email-agent-mcp`], stderr: 'pipe', env: { ...process.env } });
const client = new Client({ name: `${MBX}-verify`, version: '1.0.0' });
await client.connect(transport);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const text = (r.content || []).map(c => c.text).join('\n'); return { isError: !!r.isError || /^Error:/.test(text), text }; };

let target = null, before = null;
await step(`1b list_mailboxes shows ${MBX} (read-only, not default)`, async () => {
  const r = await call('list_mailboxes', {});
  assert.ok(!r.isError, r.text.slice(0, 300));
  const j = JSON.parse(r.text); const arr = j.mailboxes ?? j;
  for (const m of arr) console.log(`      ${m.name ?? ''} <${m.emailAddress ?? ''}> default=${m.isDefault ?? m.default} status=${m.status ?? ''}`);
  const m = arr.find(m => String(m.emailAddress ?? '').toLowerCase() === SHARED || m.name === MBX);
  assert.ok(m, `${MBX} not listed`); assert.ok(!(m.isDefault ?? m.default), `${MBX} is default`);
});
await step(`2 list top 3 ${SHARED} inbox messages (MCP list_emails)`, async () => {
  const r = await call('list_emails', { mailbox: MBX, limit: 3 });
  assert.ok(!r.isError, r.text.slice(0, 300));
  const emails = JSON.parse(r.text).emails || [];
  for (const m of emails) console.log(`      id=${short(m.id)} isRead=${m.isRead}`);
  assert.ok(emails.length > 0, 'inbox returned no messages');
  target = emails.find(m => m.isRead === false) ?? emails[0]; // prefer an unread one: a stray mark-read would show
  console.log(`      chosen: ${short(target.id)} (isRead=${target.isRead})`);
});
if (target && token) {
  await step('3 read one full message (MCP read_email)', async () => {
    before = await probeIsRead(target.id);
    const r = await call('read_email', { mailbox: MBX, id: target.id });
    assert.ok(!r.isError, r.text.slice(0, 300));
    console.log(`      read ok, ${r.text.length} chars returned (body not printed)`);
  });
  await step('4 isRead unchanged after read', async () => {
    const after = await probeIsRead(target.id);
    console.log(`      isRead before=${before} after=${after}`);
    assert.equal(after, before);
  });
}
{
  const glog = `${os.homedir()}/.email-agent-mcp/shared-mailbox-guard.log`;
  const lines = () => fs.existsSync(glog) ? fs.readFileSync(glog, 'utf8').trim().split('\n').length : 0;
  await step('5 write attempts refused locally (MCP mark_read, move_to_folder, flag_email, create_draft, send_email)', async () => {
    const n0 = lines();
    // Payloads chosen to be harmless even if the guard were broken: mark_read to the CURRENT state, move to a nonexistent folder.
    const id = target?.id ?? 'AAMk-FAKE-guard-test-id', state = before ?? true;
    const a = await call('mark_read', { mailbox: MBX, id, is_read: state });
    const b = await call('move_to_folder', { mailbox: MBX, id, folder: '__guard_test_nonexistent__' });
    // Harmless even if the guard broke: fake id; drafts/sends to an RFC 2606 .invalid address (token also lacks any Send scope for shared mailboxes).
    const c = await call('flag_email', { mailbox: MBX, id: 'AAMk-FAKE-guard-test-id', flagged: true });
    const d = await call('create_draft', { mailbox: MBX, to: 'guard-test@example.invalid', subject: 'guard test - must never be created', body: 'x' });
    const e = await call('send_email', { mailbox: MBX, to: 'guard-test@example.invalid', subject: 'guard test - must never be sent', body: 'x' });
    for (const [n, r] of [['mark_read', a], ['move_to_folder', b], ['flag_email', c], ['create_draft', d], ['send_email', e]]) {
      console.log(`      ${n}: ${r.text.slice(0, 120)}…`);
      assert.ok(r.isError && r.text.includes('SHARED_MAILBOX_READ_ONLY') && r.text.includes('No request was sent to Graph'), `${n} was not refused locally`);
    }
    assert.ok(lines() >= n0 + 5, 'guard log did not record the refusals');
    if (target && token && before !== null) assert.equal(await probeIsRead(target.id), before, 'isRead changed after write attempt');
  });
}
await client.close();
console.log(failures ? `\nRESULT: FAIL (${failures} step(s))` : '\nRESULT: PASS');
process.exit(failures ? 1 : 0);
