// Offline unit test for the read-only shared-mailbox guard. No network, no tokens.
// Run: node <repo>/tools/guard-unit-test.mjs
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function resolveInstallDir(env = process.env) {
  const raw = env.EAM_INSTALL_DIR || env.EAM_NPX_DIR || join(homedir(), '.email-agent-mcp', 'patched-install');
  return String(raw).replace(/\/+$/, '');
}
const INSTALL = resolveInstallDir();
if (process.env.EAM_PRINT_INSTALL_DIR === '1') {
  process.stdout.write(INSTALL + '\n');
  process.exit(0);
}
if (!isDir(INSTALL)) {
  console.error(`guard-unit-test: install dir missing or not a directory: ${INSTALL}`);
  console.error('Set EAM_INSTALL_DIR to the team patched-install path (default: ~/.email-agent-mcp/patched-install).');
  process.exit(2);
}
if (!isDir(join(INSTALL, 'node_modules', '@usejunior'))) {
  console.error(`guard-unit-test: expected node_modules/@usejunior missing under ${INSTALL}`);
  console.error('Set EAM_INSTALL_DIR to the team patched-install path (default: ~/.email-agent-mcp/patched-install).');
  process.exit(2);
}
const PKG = join(INSTALL, 'node_modules');
const home = mkdtempSync(join(tmpdir(), 'eam-guard-'));
process.env.EMAIL_AGENT_MCP_HOME = home; // guard log goes to a temp dir
const pm = await import(pathToFileURL(join(PKG, '@usejunior/provider-microsoft/dist/index.js')).href);
const srv = await import(pathToFileURL(join(PKG, '@usejunior/email-mcp/dist/server.js')).href);

let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
  return new Response(JSON.stringify({ value: [{ id: 'm1', subject: 's', from: { emailAddress: { address: 'a@b.c' } }, receivedDateTime: '2026-10-26T00:00:00Z', isRead: false, hasAttachments: false }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
let tokenCalls = 0;
const getToken = async () => { tokenCalls++; return 'fake-token'; };
const client = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'support@example.com', 'support');
const provider = new pm.GraphEmailProvider(client, 'support@example.com');
const results = [];
async function expectRefused(label, fn) {
  const f0 = fetchCalls.length, t0 = tokenCalls;
  await assert.rejects(fn, (e) => /SHARED_MAILBOX_READ_ONLY/.test(e.message));
  assert.equal(fetchCalls.length, f0, `${label}: fetch must not be called`);
  assert.equal(tokenCalls, t0, `${label}: token must not be requested`);
  results.push(`REFUSED locally (0 fetch, 0 token): ${label}`);
}
await expectRefused('provider.setReadState (mark read)', () => provider.setReadState('m1', true));
await expectRefused('provider.setReadState (mark unread)', () => provider.setReadState('m1', false));
await expectRefused('provider.moveToFolder', () => provider.moveToFolder('m1', 'archive'));
await expectRefused('provider.deleteMessage', () => provider.deleteMessage('m1'));
await expectRefused('client.patch isRead', () => client.patch('/users/support@example.com/messages/m1', { isRead: true }));
await expectRefused('client.post sendMail', () => client.post('/users/support@example.com/sendMail', {}));
await expectRefused('client.delete', () => client.delete('/users/support@example.com/messages/m1'));
await expectRefused('raw fetchWithAuthRetry PATCH', () => client.fetchWithAuthRetry('https://graph.microsoft.com/v1.0/users/support@example.com/messages/m1', { method: 'PATCH', headers: {} }));
await expectRefused('GET outside pinned mailbox (/me)', () => client.get('/me/messages'));
await expectRefused('GET other user', () => client.get('/users/owner@example.com/messages'));
await expectRefused('GET path traversal', () => client.get('/users/support@example.com/../owner@example.com/messages'));
assert.throws(() => new pm.ReadOnlySharedMailboxGraphClient(getToken, null, 'exec@example.com'), /allowlist/);
results.push('REFUSED: constructing client for a mailbox outside the hard-coded allowlist');

// allowed read: plain GET, under /users/support@example.com
const f0 = fetchCalls.length;
const msgs = await provider.listMessages({ limit: 3, folder: 'inbox' });
assert.equal(fetchCalls.length, f0 + 1);
assert.equal(fetchCalls.at(-1).method, 'GET');
assert.match(fetchCalls.at(-1).url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/support@example\.com\/mailFolders\/inbox\/messages\?/);
results.push(`ALLOWED: listMessages -> GET ${new URL(fetchCalls.at(-1).url).pathname} (${msgs.length} msg)`);

// Tool-level guard through the real MCP action registry (executeTool), with a fake connected state.
const state = srv.createLazyProviderState();
state.status = 'connected';
state.assertToolAllowedForSharedMailbox = pm.assertToolAllowedForSharedMailbox;
const ownFetchProvider = new pm.GraphEmailProvider(new pm.RealGraphApiClient(getToken), 'me');
state.mailboxes = [
  { name: 'owner@example.com', displayName: 'owner@example.com', providerType: 'microsoft', provider: ownFetchProvider, auth: null, isDefault: true, status: 'connected' },
  { name: 'support', emailAddress: 'support@example.com', displayName: 'support@example.com', providerType: 'microsoft', provider, auth: null, isDefault: false, status: 'connected', readOnlyShared: true },
];
const actions = await srv.buildLazyActions(state, () => ({ entries: ['*@example.com'] }), () => ({ enabled: true, hardDeleteAllowed: true }));
const writeTools = [
  ['mark_read', { id: 'm1', is_read: true }], ['mark_read', { id: 'm1', is_read: false }],
  ['move_to_folder', { id: 'm1', folder: 'archive' }], ['delete_email', { id: 'm1', user_explicitly_requested_deletion: true }],
  ['flag_email', { id: 'm1', flagged: true }], ['label_email', { id: 'm1', labels: ['x'] }],
  ['create_draft', { to: 'owner@example.com', subject: 's', body: 'b' }], ['reply_to_email', { message_id: 'm1', body: 'b' }],
  ['send_email', { to: 'owner@example.com', subject: 's', body: 'b' }], ['create_folder', { display_name: 'x' }],
];
for (const [tool, args] of writeTools) {
  if (!actions.find(a => a.name === tool)) { results.push(`(tool ${tool} not exposed in this profile)`); continue; }
  const f1 = fetchCalls.length, t1 = tokenCalls;
  let msg = '';
  try { await srv.executeTool(actions, {}, tool, { ...args, mailbox: 'support' }); msg = 'NOT REFUSED'; }
  catch (e) { msg = e.message; }
  assert.match(msg, /SHARED_MAILBOX_READ_ONLY/, `${tool}: ${msg}`);
  assert.equal(fetchCalls.length, f1); assert.equal(tokenCalls, t1);
  results.push(`REFUSED tool ${tool}(mailbox=support) before run: 0 fetch, 0 token`);
}
// owner@ regression: compose without a mailbox arg must NOT hit MAILBOX_REQUIRED because of the shared entry (fetch is mocked).
{
  const r = await srv.executeTool(actions, {}, 'create_draft', { to: 'owner@example.com', subject: 's', body: 'b' }).catch(e => ({ result: { error: { code: e.message } } }));
  const code = r.result?.error?.code ?? 'none';
  assert.notEqual(code, 'MAILBOX_REQUIRED');
  results.push(`owner@ create_draft without mailbox arg (mocked fetch): error code=${code} (not MAILBOX_REQUIRED) -> hits ${new URL(fetchCalls.at(-1).url).pathname}`);
}
// allMailboxes seen by owner@'s compose tools must not include support (no MAILBOX_REQUIRED regression)
const lst = await srv.executeTool(actions, {}, 'list_mailboxes', {});
results.push(`list_mailboxes: ${lst.result.mailboxes.map(m => m.name).join(', ')}`);
const logPath = join(home, 'shared-mailbox-guard.log');
const logLines = existsSync(logPath) ? readFileSync(logPath, 'utf-8').trim().split('\n').length : 0;
results.push(`guard log lines written: ${logLines} (${logPath})`);
assert.ok(!fetchCalls.some(c => c.method !== 'GET' && c.url.includes('support')), 'no non-GET fetch ever issued to support');
console.log(results.join('\n'));
console.log(`\nTotal fetch calls: ${fetchCalls.length} (support calls all GET: ${fetchCalls.filter(c=>c.url.includes('support')).every(c => c.method === 'GET')}); PASS`);
