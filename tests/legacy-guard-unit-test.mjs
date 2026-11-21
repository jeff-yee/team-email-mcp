// Offline unit test for the read-only shared-mailbox guard. No network, no tokens.
// Run: node tests/legacy-guard-unit-test.mjs [installDir]
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const ROOT = resolve(process.env.TEAM_EMAIL_MCP_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
const PKG = (process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'build')) + '/node_modules/';
mkdirSync(join(ROOT, 'scratch'), { recursive: true });
const home = mkdtempSync(join(ROOT, 'scratch/eam-guard-'));
process.env.EMAIL_AGENT_MCP_HOME = home; // guard log goes to a temp dir
const req = createRequire(PKG);
const pm = await import(pathToFileURL(PKG + '@usejunior/provider-microsoft/dist/index.js').href);
const srv = await import(pathToFileURL(PKG + '@usejunior/email-mcp/dist/server.js').href);

let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
  return new Response(JSON.stringify({ value: [{ id: 'm1', subject: 's', from: { emailAddress: { address: 'a@b.c' } }, receivedDateTime: '2026-10-26T00:00:00Z', isRead: false, hasAttachments: false }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
let tokenCalls = 0;
const getToken = async () => { tokenCalls++; return 'fake-token'; };
const client = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'sentlog@example.com', 'sentlog');
const provider = new pm.GraphEmailProvider(client, 'sentlog@example.com');
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
await expectRefused('client.patch isRead', () => client.patch('/users/sentlog@example.com/messages/m1', { isRead: true }));
await expectRefused('client.post sendMail', () => client.post('/users/sentlog@example.com/sendMail', {}));
await expectRefused('client.delete', () => client.delete('/users/sentlog@example.com/messages/m1'));
await expectRefused('raw fetchWithAuthRetry PATCH', () => client.fetchWithAuthRetry('https://graph.microsoft.com/v1.0/users/sentlog@example.com/messages/m1', { method: 'PATCH', headers: {} }));
await expectRefused('GET outside pinned mailbox (/me)', () => client.get('/me/messages'));
await expectRefused('GET other user', () => client.get('/users/owner@example.com/messages'));
await expectRefused('GET path traversal', () => client.get('/users/sentlog@example.com/../owner@example.com/messages'));
const execClient = new pm.ReadOnlySharedMailboxGraphClient(getToken, null, 'exec@example.com', 'exec');
results.push('ALLOWED under policy exchange: constructing client for exec@example.com (no local allowlist)');
assert.throws(() => new pm.ReadOnlySharedMailboxGraphClient(getToken, null, 'exec@example.com', 'exec', 'shared-mailbox-only'), /SHARED_TARGET_REFUSED/);
results.push('REFUSED under policy shared-mailbox-only: exec@ cannot be classified with current scopes (fail closed)');
await expectRefused('exec client.post sendMail', () => execClient.post('/users/exec@example.com/sendMail', {}));

// allowed read: plain GET, under /users/sentlog@example.com
const f0 = fetchCalls.length;
const msgs = await provider.listMessages({ limit: 3, folder: 'inbox' });
assert.equal(fetchCalls.length, f0 + 1);
assert.equal(fetchCalls.at(-1).method, 'GET');
assert.match(fetchCalls.at(-1).url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/sentlog@example\.com\/mailFolders\/inbox\/messages\?/);
results.push(`ALLOWED: listMessages -> GET ${new URL(fetchCalls.at(-1).url).pathname} (${msgs.length} msg)`);

// Tool-level guard through the real MCP action registry (executeTool), with a fake connected state.
const state = srv.createLazyProviderState();
state.status = 'connected';
state.assertToolAllowedForSharedMailbox = pm.assertToolAllowedForSharedMailbox;
const ownFetchProvider = new pm.GraphEmailProvider(new pm.RealGraphApiClient(getToken), 'me');
state.mailboxes = [
  { name: 'owner@example.com', displayName: 'owner@example.com', providerType: 'microsoft', provider: ownFetchProvider, auth: null, isDefault: true, status: 'connected' },
  { name: 'sentlog', emailAddress: 'sentlog@example.com', displayName: 'sentlog@example.com', providerType: 'microsoft', provider, auth: null, isDefault: false, status: 'connected', readOnlyShared: true },
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
  try { await srv.executeTool(actions, {}, tool, { ...args, mailbox: 'sentlog' }); msg = 'NOT REFUSED'; }
  catch (e) { msg = e.message; }
  assert.match(msg, /SHARED_MAILBOX_READ_ONLY/, `${tool}: ${msg}`);
  assert.equal(fetchCalls.length, f1); assert.equal(tokenCalls, t1);
  results.push(`REFUSED tool ${tool}(mailbox=sentlog) before run: 0 fetch, 0 token`);
}
// owner@ regression: compose without a mailbox arg must NOT hit MAILBOX_REQUIRED because of the shared entry (fetch is mocked).
{
  const r = await srv.executeTool(actions, {}, 'create_draft', { to: 'owner@example.com', subject: 's', body: 'b' }).catch(e => ({ result: { error: { code: e.message } } }));
  const code = r.result?.error?.code ?? 'none';
  assert.notEqual(code, 'MAILBOX_REQUIRED');
  results.push(`owner@ create_draft without mailbox arg (mocked fetch): error code=${code} (not MAILBOX_REQUIRED) -> hits ${new URL(fetchCalls.at(-1).url).pathname}`);
}
// allMailboxes seen by owner@'s compose tools must not include sentlog (no MAILBOX_REQUIRED regression)
const lst = await srv.executeTool(actions, {}, 'list_mailboxes', {});
results.push(`list_mailboxes: ${lst.result.mailboxes.map(m => m.name).join(', ')}`);
const logPath = join(home, 'shared-mailbox-guard.log');
const logLines = existsSync(logPath) ? readFileSync(logPath, 'utf-8').trim().split('\n').length : 0;
results.push(`guard log lines written: ${logLines} (${logPath})`);
assert.ok(!fetchCalls.some(c => c.method !== 'GET' && c.url.includes('sentlog')), 'no non-GET fetch ever issued to sentlog');
console.log(results.join('\n'));
console.log(`\nTotal fetch calls: ${fetchCalls.length} (sentlog calls all GET: ${fetchCalls.filter(c=>c.url.includes('sentlog')).every(c => c.method === 'GET')}); PASS`);
