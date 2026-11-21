// OFFLINE tests for the team email-agent-mcp build. No network, no real tokens.
// Usage: node offline-test.mjs <installDir>   (HOME + EMAIL_AGENT_MCP_HOME must be scratch dirs)
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const ROOT = resolve(process.env.TEAM_EMAIL_MCP_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
function underRoot(p) {
  if (!p) return false;
  const n = resolve(p);
  return n === ROOT || n.startsWith(ROOT + sep);
}
const D = resolve(process.argv[2]);
if (!D) throw new Error('usage: offline-test.mjs <installDir>');
const home = process.env.EMAIL_AGENT_MCP_HOME;
if (!home || !underRoot(home)) throw new Error('EMAIL_AGENT_MCP_HOME must be a scratch dir under ' + ROOT);
if (!underRoot(process.env.HOME)) throw new Error('HOME must be scratch under ' + ROOT);
delete process.env.EMAIL_AGENT_MCP_SCOPE_PROFILE; // test the build default
const NM = join(D, 'node_modules');
const imp = (rel) => import(pathToFileURL(join(NM, rel)).href);
const pm = await imp('@usejunior/provider-microsoft/dist/index.js');
const core = await imp('@usejunior/email-core/dist/index.js');
const srv = await imp('@usejunior/email-mcp/dist/server.js');
const out = [];
let pass = 0, fail = 0;
async function t(label, fn) {
  try { const note = await fn(); pass++; out.push(`- PASS: ${label}${note ? ` — ${note}` : ''}`); }
  catch (e) { fail++; out.push(`- FAIL: ${label} — ${e && e.message}`); }
}
// ---- network mock: only graph.microsoft.com is "answered"; anything else is a hard failure
const fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const method = (init.method ?? 'GET').toUpperCase();
  fetchCalls.push({ method, path: u.pathname, host: u.hostname });
  if (u.hostname !== 'graph.microsoft.com') throw new Error(`UNEXPECTED NETWORK to ${u.hostname}`);
  const msg = (id, extra = {}) => ({ id, subject: 'Test subject', bodyPreview: 'hi', body: { contentType: 'text', content: 'hello' },
    from: { emailAddress: { address: 'sender@example.com', name: 'Sender' } }, toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
    ccRecipients: [], bccRecipients: [], receivedDateTime: '2026-11-17T20:00:00Z', isRead: false, hasAttachments: false,
    conversationId: 'c1', parentFolderId: 'inbox', isDraft: false, internetMessageId: '<x@y>', ...extra });
  const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const p = u.pathname.replace(/^\/v1\.0/, '');
  if (method === 'GET' && /\/messages$/.test(p)) return j({ value: [msg('m1')] });
  if (method === 'GET' && /\/mailFolders(\/[^/]+)?\/messages$/.test(p)) return j({ value: [msg('m1')] });
  if (method === 'GET' && /\/mailFolders(\/[^/]+\/childFolders)?$/.test(p)) return j({ value: [{ id: 'inbox', displayName: 'Inbox', totalItemCount: 1, unreadItemCount: 1, childFolderCount: 0 }, { id: 'archive', displayName: 'Archive', totalItemCount: 0, unreadItemCount: 0, childFolderCount: 0 }] });
  if (method === 'GET' && /\/mailFolders\/[^/]+$/.test(p)) return j({ id: p.split('/').pop(), displayName: p.split('/').pop(), totalItemCount: 0, unreadItemCount: 0, childFolderCount: 0 });
  if (method === 'GET' && /\/attachments$/.test(p)) return j({ value: [] });
  if (method === 'GET' && /\/messages\/[^/]+$/.test(p)) return j(msg(decodeURIComponent(p.split('/').pop())));
  if (method === 'POST' && /\/messages$/.test(p)) return j(msg('d1', { isDraft: true, subject: 'Draft subj' }), 201);
  if (method === 'POST' && /\/move$/.test(p)) return j(msg('m1-moved'), 201);
  if (method === 'PATCH') return new Response(null, { status: 200 });
  if (method === 'GET' && p === '/me') return j({ mail: 'me@example.com' });
  return j({ value: [] });
};
let tokenCalls = 0;
const getToken = async () => { tokenCalls++; return 'fake-token-not-real'; };
// ---------------------------------------------------------------------------
// 1. Scopes
await t('draft is the default scope profile', async () => { assert.equal(core.getEmailScopeProfile(), 'draft'); return `getEmailScopeProfile() = "${core.getEmailScopeProfile()}"`; });
await t('"full" profile refused in team build', async () => { assert.throws(() => core.getEmailScopeProfile('full'), /not available in the team build/); });
await t('draft profile requests exactly User.Read, offline_access, Mail.ReadWrite, Mail.Read.Shared', async () => {
  const a = new pm.DelegatedAuthManager({ mode: 'delegated', clientId: '11111111-2222-3333-4444-555555555555' }, 'me@example.com');
  const s = [...a.scopes];
  assert.deepEqual(s.map(x => x.replace('https://graph.microsoft.com/', '')).sort(), ['Mail.Read.Shared', 'Mail.ReadWrite', 'User.Read', 'offline_access'].sort());
  assert.ok(!s.some(x => /Mail\.Send|MailboxSettings/i.test(x)));
  return '`' + s.join(' ') + '`';
});
await t('shared-mailbox token scope unchanged (Mail.Read.Shared only)', async () => { assert.deepEqual([...pm.SHARED_MAILBOX_SCOPES], ['https://graph.microsoft.com/Mail.Read.Shared']); });
await t('shared target policy defaults to exchange (no address allowlist)', async () => {
  assert.equal(pm.SHARED_TARGET_POLICY, 'exchange');
  assert.equal(pm.getSharedTargetPolicy(), 'exchange');
  assert.equal(typeof pm.TEAM_SHARED_MAILBOX_ALLOWLIST, 'undefined');
  assert.equal(typeof pm.SHARED_MAILBOX_READONLY_ALLOWLIST, 'undefined');
  return 'sharedTargetPolicy=exchange';
});
// 2. Client id
await t('missing client id refused (DelegatedAuthManager)', async () => { assert.throws(() => new pm.DelegatedAuthManager({ mode: 'delegated' }, 'me@example.com'), /TEAM_CLIENT_ID_REQUIRED/); });
await t('vendor client id c4f91d3e refused', async () => { assert.throws(() => new pm.DelegatedAuthManager({ mode: 'delegated', clientId: 'c4f91d3e-d2d9-4f8b-826f-6a3c19280241' }, 'x'), /vendor default app/); });
const teamCfg = await imp('@usejunior/provider-microsoft/dist/team-build-config.js');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A client id under the build config's first denied prefix (any case).
const deniedIds = () => {
  const p = teamCfg.TEAM_FORBIDDEN_CLIENT_ID_PREFIXES[0];
  assert.ok(p, 'the build config lists at least one deniedClientIdPrefixes entry');
  const id = p + '0000-4000-8000-000000000000';
  return [id, id.toUpperCase()];
};
await t('build config filled in: tenant and team client id are GUIDs, no placeholders', async () => {
  assert.match(teamCfg.TEAM_TENANT_ID, GUID);
  assert.match(teamCfg.TEAM_CLIENT_ID, GUID);
  assert.doesNotThrow(() => teamCfg.assertTeamBuildConfig());
  return 'tenant and client id set at build time';
});
await t('TEAM-BUILD.json records the tenant, team client id and denied prefixes the build used', async () => {
  const tb = JSON.parse(readFileSync(join(D, 'TEAM-BUILD.json'), 'utf8'));
  assert.equal(tb.tenantId, teamCfg.TEAM_TENANT_ID);
  assert.equal(tb.teamClientId, teamCfg.TEAM_CLIENT_ID);
  assert.deepEqual(tb.deniedClientIdPrefixes, [...teamCfg.TEAM_FORBIDDEN_CLIENT_ID_PREFIXES]);
  assert.equal(tb.allowNoDeniedClients, teamCfg.TEAM_ALLOW_NO_DENIED_CLIENTS);
  assert.ok(tb.deniedClientIdPrefixes.length > 0 || tb.allowNoDeniedClients === true, 'no denied prefixes without the explicit opt-out');
  return `${tb.deniedClientIdPrefixes.length} denied prefix(es) recorded`;
});
await t('denied client id prefix from the build config refused (DelegatedAuthManager)', async () => {
  for (const id of deniedIds()) {
    assert.throws(() => new pm.DelegatedAuthManager({ mode: 'delegated', clientId: id }, 'x'), /TEAM_CLIENT_ID_REQUIRED.*denied app/);
    assert.throws(() => pm.assertTeamClientId(id, 'configure'), /denied app/);
  }
  return `${teamCfg.TEAM_FORBIDDEN_CLIENT_ID_PREFIXES[0]}* refused in any case`;
});
await t('client id error prints the configured team client id, not a placeholder', async () => {
  let msg = '';
  try { pm.assertTeamClientId('', 'configure'); } catch (e) { msg = e.message; }
  assert.ok(msg.includes(`--client-id ${teamCfg.TEAM_CLIENT_ID}`), msg);
  assert.ok(!msg.includes('<TEAM_APP_ID>') && !msg.includes('@@'));
  return `message names ${teamCfg.TEAM_CLIENT_ID}`;
});
await t('a tenant saved in an old config never overrides the pinned tenant', async () => {
  const cfg = await imp('@usejunior/provider-microsoft/dist/team-build-config.js');
  const CID = '11111111-2222-3333-4444-555555555555';
  const a = new pm.DelegatedAuthManager({ mode: 'delegated', clientId: CID, tenantId: 'stale-tenant-id' }, 'me@example.com');
  const viaConfig = a.createPersistentCredential({ clientId: CID, tenantId: a.config.tenantId, cacheName: 'c' });
  const viaOption = a.createPersistentCredential({ clientId: CID, tenantId: 'another-stale-tenant', cacheName: 'c' });
  const unset = a.createPersistentCredential({ clientId: CID, cacheName: 'c' });
  for (const c of [viaConfig, viaOption, unset]) assert.equal(c.tenantId, cfg.TEAM_TENANT_ID);
  return 'credential tenant = pinned team tenant in all three cases';
});
await t('createPersistentCredential refuses a denied client id prefix directly', async () => {
  const a = new pm.DelegatedAuthManager({ mode: 'delegated', clientId: '11111111-2222-3333-4444-555555555555' }, 'me@example.com');
  for (const id of deniedIds()) {
    assert.throws(() => a.createPersistentCredential({ clientId: id }), /TEAM_CLIENT_ID_REQUIRED.*denied app/);
    assert.throws(() => a.createPersistentCredential({ clientId: id, tenantId: 'organizations', cacheName: 'c' }), /denied app/);
  }
  assert.throws(() => a.createPersistentCredential({}), /TEAM_CLIENT_ID_REQUIRED/);
  return 'credential factory refuses denied prefixes (any case) without going through the constructor';
});
await t('tokens/ is created 0700 and the account file 0600, and looser ones are tightened (POSIX)', async () => {
  if (process.platform === 'win32') return 'skipped on Windows (no POSIX modes)';
  const { mkdtempSync, statSync, chmodSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const mode = (x) => (statSync(x).mode & 0o777).toString(8);
  const saved = process.env.EMAIL_AGENT_MCP_HOME, um = process.umask(0o022);
  const base = mkdtempSync(pjoin(tmpdir(), 'team-perm-'));
  try {
    process.env.EMAIL_AGENT_MCP_HOME = base;
    const a = new pm.DelegatedAuthManager({ mode: 'delegated', clientId: '11111111-2222-3333-4444-555555555555' }, 'perm@example.com');
    await a.saveMetadata();
    const dir = pjoin(base, 'tokens'), file = a.getMetadataPath();
    assert.equal(mode(dir), '700', 'tokens/ on create');
    assert.equal(mode(file), '600', 'account file on create');
    chmodSync(dir, 0o755); chmodSync(file, 0o644);
    await a.saveMetadata();
    assert.equal(mode(dir), '700', 'tokens/ tightened');
    assert.equal(mode(file), '600', 'account file tightened');
    return 'create: 700/600; rewrite of 755/644: 700/600';
  } finally {
    process.umask(um);
    if (saved === undefined) delete process.env.EMAIL_AGENT_MCP_HOME; else process.env.EMAIL_AGENT_MCP_HOME = saved;
    rmSync(base, { recursive: true, force: true });
  }
});
// ---- configure after device-code sign-in: success must read as success, real failure must fail
const CFG_RECORD = { authority: 'a', homeAccountId: 'h', clientId: '11111111-2222-3333-4444-555555555555', tenantId: 't', username: 'cfgtest@example.com', version: '1.0' };
async function runConfigureWithStub(silentMode) {
  const cli = await imp('@usejunior/email-mcp/dist/cli.js');
  const proto = pm.DelegatedAuthManager.prototype;
  const origCreate = proto.createPersistentCredential;
  const origFetch = globalThis.fetch, origErr = console.error;
  const lines = [], calls = [], creds = [];
  proto.createPersistentCredential = function (options) {
    const real = origCreate.call(this, options); // keeps the client-id refusal and the tenant pin in the path
    calls.push(options); creds.push(real);
    const err = (name, message) => Object.assign(new Error(message), { name });
    return {
      realTenantId: real.tenantId,
      async authenticate() {
        options.userPromptCallback?.({ verificationUri: 'https://example.invalid/device', userCode: 'ABCDEFGHI' });
        return CFG_RECORD;
      },
      async getToken() {
        // Like the real credential: with automatic sign-in off, only a record-based silent call can work.
        if (!options.authenticationRecord) throw err('AuthenticationRequiredError', 'Automatic authentication has been disabled. You may call the authentication() method.');
        if (silentMode === 'fail') throw err('AuthenticationRequiredError', 'silent token failed');
        return { token: 'fake-token-not-real', expiresOnTimestamp: Date.now() + 3600000 };
      },
    };
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ mail: 'cfgtest@example.com', displayName: 'Cfg Test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  console.error = (...a) => { lines.push(a.join(' ')); };
  let code;
  try { code = await cli.runConfigure({ mailbox: 'cfgtest@example.com', provider: 'microsoft', clientId: '11111111-2222-3333-4444-555555555555' }); }
  finally { proto.createPersistentCredential = origCreate; globalThis.fetch = origFetch; console.error = origErr; }
  return { code, text: lines.join('\n'), calls, creds };
}
await t('configure after a successful sign-in reads as success (exit 0, no failure line)', async () => {
  const cfg = await imp('@usejunior/provider-microsoft/dist/team-build-config.js');
  const alPath = join(home, 'send-allowlist.json');
  mkdirSync(home, { recursive: true });
  writeFileSync(alPath, '{"entries": []}\n');
  const before = readFileSync(alPath);
  const r = await runConfigureWithStub('ok');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Connected as/);
  assert.ok(!r.text.includes('Configuration failed'), r.text);
  // the new silent credential: automatic sign-in stays off and it carries the record authenticate() returned
  assert.equal(r.calls.length, 2, 'interactive credential then the silent one');
  assert.equal(r.calls[0].authenticationRecord, undefined);
  assert.equal(r.calls[1].disableAutomaticAuthentication, true);
  assert.equal(r.calls[1].authenticationRecord, CFG_RECORD);
  for (const c of r.creds) assert.equal(c.tenantId, cfg.TEAM_TENANT_ID); // pin ran on both
  // drafts only: configure must not enable sending
  assert.ok(readFileSync(alPath).equals(before), 'send-allowlist.json changed');
  assert.deepEqual(JSON.parse(readFileSync(alPath, 'utf8')), { entries: [] });
  assert.ok(!/outbound email enabled/i.test(r.text), r.text);
  assert.match(r.text, /Drafts only; sending is disabled in this build/);
  return 'exit 0; silent credential has automatic sign-in off + the record; send-allowlist.json unchanged';
});
await t('configure still fails (exit 1, failure line) when the silent token check really fails', async () => {
  const r = await runConfigureWithStub('fail');
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /Configuration failed: silent token failed/);
  assert.ok(!r.text.includes('Connected as'), r.text);
  return 'exit 1, Configuration failed';
});
// 3. Mocked Graph — build state the same way initProvider does
const ownClient = new pm.TeamOwnMailboxGraphClient(getToken, async () => false, 'me@example.com', 'draft');
const ownProvider = new pm.GraphEmailProvider(ownClient);
const shClient = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'sentlog@example.com', 'sentlog');
const shProvider = new pm.GraphEmailProvider(shClient, 'sentlog@example.com');
const state = srv.createLazyProviderState();
state.status = 'connected';
state.assertToolAllowedForSharedMailbox = pm.assertToolAllowedForSharedMailbox;
state.mailboxes = [
  { name: 'me@example.com', emailAddress: 'me@example.com', displayName: 'me@example.com', providerType: 'microsoft', provider: ownProvider, auth: { getTokenHealthWarning: () => undefined, tryReconnect: async () => false }, isDefault: true, status: 'connected' },
  { name: 'sentlog', emailAddress: 'sentlog@example.com', displayName: 'sentlog@example.com', providerType: 'microsoft', provider: shProvider, auth: { getTokenHealthWarning: () => undefined, tryReconnect: async () => false }, isDefault: false, status: 'connected', readOnlyShared: true },
];
// Even give it a permissive send allowlist: send tools must still be impossible.
const actions = await srv.buildLazyActions(state, () => ({ entries: ['*@example.com', '*'] }), () => ({ hardDeleteAllowed: true }));
const names = actions.map(a => a.name);
const MUST_BE_ABSENT = ['send_email', 'send_draft', 'reply_to_email', 'cancel_scheduled_send', 'list_scheduled_sends', 'delete_email', 'delete_folder', 'create_folder', 'list_inbox_rules', 'create_inbox_rule', 'delete_inbox_rule'];
await t('registry under draft: send/delete/rules/settings tools absent', async () => {
  for (const n of MUST_BE_ABSENT) assert.ok(!names.includes(n), n);
  return `${names.length} tools: ${names.join(', ')}`;
});
const call = (tool, args) => srv.executeTool(actions, {}, tool, args).then(r => r.result);
async function refusedNoNet(label, fn, re) {
  const f0 = fetchCalls.length, t0 = tokenCalls;
  let res, err;
  try { res = await fn(); } catch (e) { err = e; }
  const msg = err ? err.message : JSON.stringify(res);
  assert.ok(err || (res && res.success === false) || (res && res.error), `${label}: expected refusal, got ${msg}`);
  if (re) assert.match(msg, re);
  assert.equal(fetchCalls.length, f0, `${label}: fetch was called`);
  assert.equal(tokenCalls, t0, `${label}: token was requested`);
  return msg.slice(0, 140);
}
async function okCall(label, fn, expect) {
  const f0 = fetchCalls.length;
  const r = await fn();
  if (r && r.success === false) throw new Error(`${label}: ${JSON.stringify(r).slice(0, 300)}`);
  const reqs = fetchCalls.slice(f0).map(c => `${c.method} ${c.path}`);
  for (const r2 of reqs) assert.ok(r2.includes('/v1.0/me') || r2.includes('/v1.0/users/sentlog@example.com'), r2);
  if (expect) expect(reqs);
  return reqs.join('; ');
}
// own mailbox
await t('own: list_emails succeeds', () => okCall('list', () => call('list_emails', { limit: 3 }), rq => assert.ok(rq.every(r => r.startsWith('GET /v1.0/me/')))));
await t('own: read_email succeeds', () => okCall('read', () => call('read_email', { id: 'm1' })));
await t('own: search_emails succeeds', () => okCall('search', () => call('search_emails', { query: 'invoice', mailbox: 'me@example.com' })));
await t('own: list_folders succeeds', () => okCall('folders', () => call('list_folders', {})));
await t('own: create_draft succeeds (POST /me/messages, no /send)', () => okCall('draft', () => call('create_draft', { to: ['someone@example.com'], subject: 'Draft subj', body: 'Hello' }),
  rq => { assert.ok(rq.some(r => r === 'POST /v1.0/me/messages')); assert.ok(!rq.some(r => /\/send/i.test(r))); }));
await t('own: mark_read succeeds', () => okCall('mark_read', () => call('mark_read', { id: 'm1', is_read: true }), rq => assert.ok(rq.some(r => r.startsWith('PATCH /v1.0/me/messages/')))));
await t('own: flag_email succeeds', () => okCall('flag', () => call('flag_email', { id: 'm1', flagged: true })));
await t('own: move_to_folder succeeds', () => okCall('move', () => call('move_to_folder', { id: 'm1', folder: 'archive' }), rq => assert.ok(rq.some(r => /POST .*\/move$/.test(r)))));
// send / delete tools refused when called
for (const [tool, args] of [
  ['send_email', { to: ['x@example.com'], subject: 's', body: 'b' }],
  ['send_draft', { draft_id: 'd1' }],
  ['reply_to_email', { message_id: 'm1', body: 'b' }],
  ['delete_email', { id: 'm1' }],
  ['create_inbox_rule', { name: 'r' }],
  ['list_inbox_rules', {}],
  ['delete_folder', { id: 'f' }],
]) await t(`tool ${tool} refused if called (no fetch, no token)`, () => refusedNoNet(tool, () => call(tool, args), /unavailable in the team build/));
// second layer: request guard on own client even if a send path were reached
await t('own guard: provider.sendMessage refused locally', () => refusedNoNet('sendMessage', () => ownProvider.sendMessage({ to: [{ email: 'x@example.com' }], subject: 's', body: 'b' }), /"code":"TEAM_BUILD_REFUSED".*not delivered/));
await t('own guard: provider.sendDraft refused locally', () => refusedNoNet('sendDraft', () => ownProvider.sendDraft('d1'), /"code":"TEAM_BUILD_REFUSED"/));
for (const [m, u] of [['POST', '/me/sendMail'], ['POST', '/me/messages/m1/send'], ['POST', '/me/messages/m1/reply'], ['POST', '/me/messages/m1/replyAll'], ['POST', '/me/messages/m1/forward'],
  ['POST', '/me/messages/m1/permanentDelete'], ['DELETE', '/me/messages/m1'], ['DELETE', '/me/mailFolders/f1'], ['GET', '/me/mailFolders/inbox/messageRules'],
  ['POST', '/me/mailFolders/inbox/messageRules'], ['GET', '/me/mailboxSettings'], ['PATCH', '/me/mailboxSettings'], ['GET', '/users/owner@example.com/messages'],
  ['GET', '/me/../users/owner@example.com/messages']])
  await t(`own guard: ${m} ${u} refused`, () => refusedNoNet(`${m} ${u}`, () => m === 'GET' ? ownClient.get(u) : m === 'POST' ? ownClient.post(u, {}) : m === 'PATCH' ? ownClient.patch(u, {}) : ownClient.delete(u), /TEAM_BUILD_REFUSED/));
await t('own guard: raw fetchWithAuthRetry POST /sendMail refused', () => refusedNoNet('raw', () => ownClient.fetchWithAuthRetry('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: {} }), /TEAM_BUILD_REFUSED/));
await t('own guard: createReply (draft only) allowed', async () => { const r = pm.classifyOwnMailboxRequest('POST', '/me/messages/m1/createReplyAll', 'draft'); assert.equal(r, null); });
// shared mailbox
await t('shared: list_emails allowed (GET /users/support@...)', () => okCall('sh list', () => call('list_emails', { mailbox: 'sentlog', limit: 2 }), rq => assert.ok(rq.length > 0 && rq.every(r => r.startsWith('GET /v1.0/users/sentlog@example.com/')))));
await t('shared: read_email allowed', () => okCall('sh read', () => call('read_email', { mailbox: 'sentlog', id: 'm1' }), rq => assert.ok(rq.every(r => r.startsWith('GET ')))));
for (const [tool, args] of [
  ['mark_read', { mailbox: 'sentlog', id: 'm1', is_read: true }],
  ['move_to_folder', { mailbox: 'sentlog', id: 'm1', folder: 'archive' }],
  ['flag_email', { mailbox: 'sentlog', id: 'm1', flagged: true }],
  ['label_email', { mailbox: 'sentlog', id: 'm1', labels: ['x'] }],
  ['create_draft', { mailbox: 'sentlog', to: ['x@example.com'], subject: 's', body: 'b' }],
  ['update_draft', { mailbox: 'sentlog', draft_id: 'd1', subject: 's' }],
]) await t(`shared: ${tool} refused (no fetch, no token)`, () => refusedNoNet(tool, () => call(tool, args), /^SHARED_MAILBOX_READ_ONLY:/));
await t('shared: a guard refusal is not labelled PROVIDER_UNAVAILABLE, a real failure still is', async () => {
  const guard = await call('mark_read', { mailbox: 'sentlog', id: 'm1', is_read: true }).then(() => '', e => e.message);
  assert.match(guard, /^SHARED_MAILBOX_READ_ONLY:/);
  assert.ok(!guard.includes('PROVIDER_UNAVAILABLE'), guard);
  const outage = await call('mark_read', { mailbox: 'no-such-mailbox', id: 'm1', is_read: true }).then(() => '', e => e.message);
  assert.match(outage, /^PROVIDER_UNAVAILABLE:/);
  return 'guard refusal starts with SHARED_MAILBOX_READ_ONLY; unknown mailbox keeps PROVIDER_UNAVAILABLE';
});
await t('a TEAM_BUILD_REFUSED thrown before the action runs is not labelled PROVIDER_UNAVAILABLE', async () => {
  const guardErr = await ownClient.post('/me/sendMail', {}).then(() => null, e => e);
  assert.equal(guardErr && guardErr.code, 'TEAM_BUILD_REFUSED');
  const realAssert = state.assertToolAllowedForSharedMailbox;
  state.assertToolAllowedForSharedMailbox = () => { throw guardErr; };
  try {
    const msg = await call('mark_read', { mailbox: 'sentlog', id: 'm1', is_read: true }).then(() => '', e => e.message);
    assert.match(msg, /^TEAM_BUILD_REFUSED:/);
    assert.ok(!msg.includes('PROVIDER_UNAVAILABLE'), msg);
  } finally { state.assertToolAllowedForSharedMailbox = realAssert; }
  return 'guard refusal keeps its TEAM_BUILD_REFUSED code';
});
await t('shared: send_email refused', () => refusedNoNet('sh send', () => call('send_email', { mailbox: 'sentlog', to: ['x@example.com'], subject: 's', body: 'b' }), /unavailable/));
await t('shared: client-level POST sendMail refused', () => refusedNoNet('sh post', () => shClient.post('/users/sentlog@example.com/sendMail', {}), /SHARED_MAILBOX_READ_ONLY/));
// any Exchange-permitted address may be listed; writes stay refused; Graph errors are surfaced
await t('shared-mailboxes.json loads any read-only address; read-write entries still ignored', async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'shared-mailboxes.json'), JSON.stringify({ mailboxes: [
    { name: 'exec', emailAddress: 'exec@example.com', viaSignedInMailbox: 'me@example.com', access: 'read-only' },
    { name: 'support', emailAddress: 'support@example.com', viaSignedInMailbox: 'me@example.com', access: 'read-only' },
    { name: 'os-rw', emailAddress: 'sentlog@example.com', viaSignedInMailbox: 'me@example.com', access: 'read-write' },
    { name: 'sentlog', emailAddress: 'SentLog@example.com', viaSignedInMailbox: 'me@example.com', access: 'read-only' }] }));
  const loaded = pm.loadSharedMailboxConfig();
  assert.deepEqual(loaded.map(x => x.name), ['exec', 'support', 'sentlog']);
  return 'exec@ and support@ now load under policy exchange; sentlog@ "read-write" entry ignored; sentlog@ read-only kept';
});
await t('shared: a mailbox that was not on the old allowlist can be read', async () => {
  const c = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'support@example.com', 'support');
  const p = new pm.GraphEmailProvider(c, 'support@example.com');
  const f0 = fetchCalls.length, t0 = tokenCalls;
  const msgs = await p.listMessages({ limit: 2, folder: 'inbox' });
  assert.ok(Array.isArray(msgs));
  const reqs = fetchCalls.slice(f0);
  assert.ok(reqs.length > 0);
  assert.ok(reqs.every(r => r.method === 'GET' && r.path.includes('/users/support@example.com/')));
  assert.ok(tokenCalls > t0);
  return reqs.map(r => `${r.method} ${r.path}`).join('; ');
});
await t('shared: writes to a non-own target that was not on the old allowlist are refused before fetch/token', async () => {
  const c = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'exec@example.com', 'exec');
  return refusedNoNet('exec post', () => c.post('/users/exec@example.com/sendMail', {}), /SHARED_MAILBOX_READ_ONLY/);
});
await t('shared: Graph 403 on an unpermitted mailbox is surfaced', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'graph.microsoft.com' && u.pathname.includes('/users/unpermitted@example.com/')) {
      const body = JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });
      return new Response(body, { status: 403, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  try {
    const c = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'unpermitted@example.com', 'unpermitted');
    const provider = new pm.GraphEmailProvider(c, 'unpermitted@example.com');
    await assert.rejects(() => provider.listMessages({ limit: 1 }), (e) => {
      assert.equal(e.name, 'GraphApiError');
      assert.equal(e.status, 403);
      assert.match(String(e.message), /403/);
      assert.match(String(e.message), /ErrorAccessDenied/);
      assert.match(String(e.body ?? e.message), /ErrorAccessDenied/);
      return true;
    });
    return 'GraphApiError status=403 body includes ErrorAccessDenied';
  } finally { globalThis.fetch = prev; }
});
await t('shared: Graph 404 on a missing mailbox is surfaced', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'graph.microsoft.com' && u.pathname.includes('/users/missing@example.com/')) {
      const body = JSON.stringify({ error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } });
      return new Response(body, { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  try {
    const c = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'missing@example.com', 'missing');
    const provider = new pm.GraphEmailProvider(c, 'missing@example.com');
    await assert.rejects(() => provider.listMessages({ limit: 1 }), (e) => {
      assert.equal(e.name, 'GraphApiError');
      assert.equal(e.status, 404);
      assert.match(String(e.message), /404/);
      assert.match(String(e.message), /ErrorItemNotFound/);
      assert.match(String(e.body ?? e.message), /ErrorItemNotFound/);
      return true;
    });
    return 'GraphApiError status=404 body includes ErrorItemNotFound';
  } finally { globalThis.fetch = prev; }
});
await t('shared-mailbox-only policy fails closed when the target cannot be classified', async () => {
  assert.equal(pm.classifySharedTarget('sentlog@example.com'), 'unknown');
  assert.throws(() => pm.assertSharedTargetAllowed('sentlog@example.com', 'shared-mailbox-only'), (e) => {
    assert.equal(e.name, 'SharedTargetRefusedError');
    assert.equal(e.code, 'SHARED_TARGET_REFUSED');
    assert.match(e.message, /SHARED_TARGET_REFUSED/);
    assert.match(e.message, /cannot confirm/);
    return true;
  });
  assert.throws(() => new pm.ReadOnlySharedMailboxGraphClient(getToken, null, 'sentlog@example.com', 'sentlog', 'shared-mailbox-only'), /SHARED_TARGET_REFUSED/);
  assert.equal(pm.assertSharedTargetAllowed('exec@example.com'), 'exec@example.com');
  assert.throws(() => pm.assertSharedTargetAllowed(''), /SHARED_TARGET_REFUSED/);
  assert.throws(() => pm.assertSharedTargetAllowed('sentlog@example.com', 'not-a-policy'), /unknown sharedTargetPolicy/);
  return 'classifier=unknown; shared-mailbox-only refuses even sentlog@; exchange still allows exec@';
});
await t('shared: list_mailboxes and get_mailbox_status mark configured shared entries unverified', async () => {
  const listed = await call('list_mailboxes', {});
  const own = listed.mailboxes.find(m => m.emailAddress === 'me@example.com');
  const sh = listed.mailboxes.find(m => m.emailAddress === 'sentlog@example.com');
  assert.equal(own.status, 'connected');
  assert.equal(sh.status, 'unverified');
  const stOwn = await call('get_mailbox_status', { mailbox: 'me@example.com' });
  const stSh = await call('get_mailbox_status', { mailbox: 'sentlog' });
  assert.equal(stOwn.status, 'connected');
  assert.equal(stSh.status, 'unverified');
  assert.ok(stSh.warnings.some(w => /unverified/i.test(w)));
  return 'own=connected; sentlog=unverified (no probe)';
});
await t('shared: strict SMTP address validation rejects slash, query, hash, percent, and whitespace', async () => {
  for (const addr of ['', 'no-at-sign', '   ', 'a@b.com/messages', 'a@b.com/../me', 'a@b.com?x=1', 'a@b.com#frag', 'a@b.com%2e%2e', 'a@b.com trailing']) {
    assert.equal(pm.isStrictSharedTargetAddress(addr), false, addr);
    assert.throws(() => pm.assertSharedTargetAllowed(addr), /SHARED_TARGET_REFUSED/, addr);
    assert.throws(() => new pm.ReadOnlySharedMailboxGraphClient(getToken, null, addr, 'x'), /SHARED_TARGET_REFUSED/, addr);
  }
  assert.equal(pm.isStrictSharedTargetAddress('exec@example.com'), true);
  assert.equal(pm.assertSharedTargetAllowed('exec@example.com'), 'exec@example.com');
  const local64 = 'a'.repeat(64) + '@example.com';
  const local65 = 'a'.repeat(65) + '@example.com';
  const total254 = 'a'.repeat(64) + '@' + 'x'.repeat(63) + '.' + 'y'.repeat(63) + '.' + 'z'.repeat(57) + '.com';
  const total255 = total254 + 'x';
  assert.equal(local64.length, 76);
  assert.equal(total254.length, 254);
  assert.equal(total255.length, 255);
  assert.equal(pm.isStrictSharedTargetAddress(local64), true);
  assert.equal(pm.isStrictSharedTargetAddress(local65), false);
  assert.equal(pm.isStrictSharedTargetAddress(total254), true);
  assert.equal(pm.isStrictSharedTargetAddress(total255), false);
  assert.throws(() => pm.assertSharedTargetAllowed(local65), /SHARED_TARGET_REFUSED/);
  assert.throws(() => pm.assertSharedTargetAllowed(total255), /SHARED_TARGET_REFUSED/);
  assert.throws(() => new pm.ReadOnlySharedMailboxGraphClient(getToken, null, local65, 'x'), /SHARED_TARGET_REFUSED/);
  return 'path/query/hash/percent/whitespace refused; 64/254 caps enforced; exec@ still allowed';
});
await t('shared: own address in shared-mailboxes.json is skipped; own mailbox stays read+draft on /me', async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'shared-mailboxes.json'), JSON.stringify({ mailboxes: [
    { name: 'self', emailAddress: 'me@example.com', viaSignedInMailbox: 'me@example.com', access: 'read-only' },
    { name: 'bob', emailAddress: ' Bob@ExAmple.com ', viaSignedInMailbox: 'me@example.com', access: 'read-only' },
    { name: 'x', emailAddress: 'x@example.com', viaSignedInMailbox: 'me@example.com' }] }));
  const loaded = pm.loadSharedMailboxConfig();
  assert.deepEqual(loaded.map(x => x.emailAddress), ['bob@example.com']);
  const listed = await call('list_mailboxes', {});
  const mes = listed.mailboxes.filter(m => (m.emailAddress ?? '').toLowerCase() === 'me@example.com');
  assert.equal(mes.length, 1);
  assert.equal(mes[0].status, 'connected');
  await okCall('own-by-address', () => call('list_emails', { mailbox: 'me@example.com', limit: 1 }), rq => assert.ok(rq.every(r => r.startsWith('GET /v1.0/me/'))));
  await okCall('own-draft-still', () => call('create_draft', { mailbox: 'me@example.com', to: ['someone@example.com'], subject: 'Draft subj', body: 'Hello' }),
    rq => { assert.ok(rq.some(r => r === 'POST /v1.0/me/messages')); assert.ok(!rq.some(r => /\/send/i.test(r))); });
  return 'self entry skipped; bob@ loaded; read-write x@ ignored; me@ still /me read+draft';
});
await t('shared: every exposed tool against exec@ (not on the old allowlist) is GET-only and pinned, or refused with 0 fetch 0 token', async () => {
  const execClient = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'exec@example.com', 'exec');
  const execProv = new pm.GraphEmailProvider(execClient, 'exec@example.com');
  const st = srv.createLazyProviderState();
  st.status = 'connected';
  st.assertToolAllowedForSharedMailbox = pm.assertToolAllowedForSharedMailbox;
  st.mailboxes = [
    state.mailboxes[0],
    { name: 'exec', emailAddress: 'exec@example.com', displayName: 'exec@example.com', providerType: 'microsoft', provider: execProv, auth: { getTokenHealthWarning: () => undefined, tryReconnect: async () => false }, isDefault: false, status: 'connected', readOnlyShared: true },
  ];
  const acts = await srv.buildLazyActions(st, () => ({ entries: ['*'] }), () => ({ enabled: true, hardDeleteAllowed: true }));
  const RO = pm.SHARED_MAILBOX_READONLY_TOOLS;
  const generic = { id: 'm1', message_id: 'm1', draft_id: 'd1', is_read: true, folder: 'archive', flagged: true, labels: ['x'], to: ['x@example.com'], subject: 's', body: 'b', query: 'x', name: 'f', attachment_id: 'a1' };
  let roN = 0, writeN = 0;
  for (const a of acts) {
    for (const sel of ['exec', 'exec@example.com', 'EXEC@EXAMPLE.COM']) {
      const f0 = fetchCalls.length, t0 = tokenCalls;
      let err = null;
      try { await a.run({}, { ...generic, mailbox: sel }); } catch (e) { err = e; }
      const calls = fetchCalls.slice(f0);
      const writes = calls.filter(c => c.method !== 'GET');
      const foreign = calls.filter(c => !String(c.path).includes('/users/exec@example.com/') && !String(c.path).includes('/v1.0/me') && !String(c.path).includes('/me/'));
      if (RO.has(a.name)) {
        assert.equal(writes.length, 0, `${a.name}(${sel}) sent non-GET: ${JSON.stringify(calls)}`);
        assert.equal(foreign.length, 0, `${a.name}(${sel}) left the pinned mailbox: ${JSON.stringify(calls)}`);
        roN++;
      } else {
        assert.ok(err, `${a.name}(${sel}) expected refusal, got success`);
        assert.equal(calls.length, 0, `${a.name}(${sel}) fetched: ${JSON.stringify(calls)}`);
        assert.equal(tokenCalls, t0, `${a.name}(${sel}) requested a token`);
        writeN++;
      }
    }
  }
  return `${acts.length} tools × 3 selectors; ${roN} RO, ${writeN} write/other refusals`;
});
await t('shared: download_* maps a mailbox-level 404 to not accessible, not item-not-found', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'graph.microsoft.com' && u.pathname.includes('/users/ghost@example.com/')) {
      const body = JSON.stringify({ error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } });
      return new Response(body, { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  try {
    const c = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'ghost@example.com', 'ghost');
    const provider = new pm.GraphEmailProvider(c, 'ghost@example.com');
    await assert.rejects(() => provider.getRawMessage('m1'), (e) => {
      assert.equal(e.name, 'SharedMailboxNotAccessibleError');
      assert.equal(e.code, 'SHARED_MAILBOX_NOT_ACCESSIBLE');
      assert.equal(e.status, 404);
      assert.match(String(e.message), /not accessible/);
      assert.ok(!/not found/i.test(String(e.message)) || /not accessible/i.test(String(e.message)));
      return true;
    });
    await assert.rejects(() => provider.downloadAttachment('m1', 'a1'), (e) => {
      assert.equal(e.name, 'SharedMailboxNotAccessibleError');
      assert.match(String(e.message), /not accessible/);
      assert.doesNotMatch(String(e.message), /Attachment a1 not found/);
      return true;
    });
    return 'ErrorInvalidUser 404 -> SharedMailboxNotAccessibleError on getRawMessage and downloadAttachment';
  } finally { globalThis.fetch = prev; }
});
await t('shared: initProvider skips own address even when via is empty or not connected', async () => {
  const P = pm.DelegatedAuthManager.prototype;
  const saved = {
    reconnect: P.reconnect,
    getAccessToken: P.getAccessToken,
    getAccessTokenForScopes: P.getAccessTokenForScopes,
    tryReconnect: P.tryReconnect,
    getTokenHealthWarning: P.getTokenHealthWarning,
  };
  P.reconnect = async function () {};
  P.getAccessToken = async () => { tokenCalls++; return 'fake-token-not-real'; };
  P.getAccessTokenForScopes = async () => { tokenCalls++; return 'fake-token-not-real'; };
  P.tryReconnect = async () => false;
  P.getTokenHealthWarning = () => undefined;
  const notes = [];
  try {
    const variants = [
      ['exact', 'me@example.com', 'me@example.com'],
      ['upper', 'ME@EXAMPLE.COM', 'me@example.com'],
      ['mixed+ws', '  Me@ExAmple.Com ', ' ME@example.com'],
      ['via-empty', 'me@example.com', ''],
      ['via-upper-own-lower', 'me@example.com', 'ME@EXAMPLE.COM'],
      ['via-other-connected', 'Me@ExAmple.com', 'peer@example.com'],
      ['via-not-connected', 'me@example.com', 'nobody@example.com'],
    ];
    for (const [label, addr, via] of variants) {
      rmSync(join(home, 'tokens'), { recursive: true, force: true });
      mkdirSync(join(home, 'tokens'), { recursive: true });
      for (const m of ['me@example.com', 'peer@example.com']) {
        writeFileSync(join(home, 'tokens', pm.toFilesystemSafeKey(m) + '.json'), JSON.stringify({
          mailboxName: m, emailAddress: m, provider: 'microsoft',
          clientId: '11111111-2222-3333-4444-555555555555',
          tenantId: '00000000-0000-4000-8000-0000000000ee',
        }));
      }
      writeFileSync(join(home, 'shared-mailboxes.json'), JSON.stringify({ mailboxes: [
        { name: 'self', emailAddress: addr, viaSignedInMailbox: via, access: 'read-only' },
        { name: 'exec', emailAddress: 'exec@example.com', viaSignedInMailbox: 'me@example.com', access: 'read-only' },
      ] }));
      const st = srv.createLazyProviderState();
      await srv.initProvider(st);
      const acts = await srv.buildLazyActions(st, () => ({ entries: ['*'] }), () => ({}));
      const run = async (n, inp) => {
        const f0 = fetchCalls.length;
        try { return { r: await acts.find(a => a.name === n).run({}, inp), f0 }; }
        catch (e) { return { e, f0 }; }
      };
      const lm = (await run('list_mailboxes', {})).r.mailboxes;
      const mes = lm.filter(m => (m.emailAddress ?? '').trim().toLowerCase() === 'me@example.com');
      assert.equal(mes.length, 1, `${label}: own listed ${mes.length} times: ${lm.map(m => m.name + ':' + m.status).join(',')}`);
      assert.equal(mes[0].status, 'connected', label);
      assert.ok(!lm.some(m => m.name === 'self'), `${label}: 'self' was registered: ${lm.map(m => m.name + ':' + m.status).join(',')}`);
      for (const sel of ['me@example.com', 'ME@EXAMPLE.COM']) {
        const x = await run('list_emails', { mailbox: sel, limit: 1 });
        assert.ok(!x.e, `${label}: select ${sel}: ${x.e && x.e.message}`);
        const reqs = fetchCalls.slice(x.f0).map(c => `${c.method} ${c.path}`);
        assert.ok(reqs.length > 0 && reqs.every(c => c.startsWith('GET /v1.0/me/')), `${label}: select ${sel} path ${reqs.join(',')}`);
      }
      const d = await run('create_draft', { mailbox: 'me@example.com', to: ['x@example.com'], subject: 's', body: 'b' });
      assert.ok(!d.e, `${label}: draft: ${d.e && d.e.message}`);
      const dreq = fetchCalls.slice(d.f0).map(c => `${c.method} ${c.path}`);
      assert.ok(dreq.some(c => c === 'POST /v1.0/me/messages'), `${label}: draft path ${dreq.join(',')}`);
      assert.ok(!dreq.some(c => /send/i.test(c)), `${label}: draft sent ${dreq.join(',')}`);
      const exec = lm.find(m => m.name === 'exec');
      assert.ok(exec && exec.status === 'unverified', `${label}: exec status ${exec && exec.status}`);
      notes.push(label);
    }
    return `initProvider variants: ${notes.join(', ')}; own listed once, selectable and draftable by address`;
  } finally {
    Object.assign(P, saved);
    rmSync(join(home, 'tokens'), { recursive: true, force: true });
    try { rmSync(join(home, 'shared-mailboxes.json')); } catch {}
  }
});
await t('shared: initProvider skips a failed-auth own address listed through another mailbox', async () => {
  const P = pm.DelegatedAuthManager.prototype;
  const saved = {
    reconnect: P.reconnect,
    getAccessToken: P.getAccessToken,
    getAccessTokenForScopes: P.getAccessTokenForScopes,
    tryReconnect: P.tryReconnect,
    getTokenHealthWarning: P.getTokenHealthWarning,
  };
  P.reconnect = async function () {
    if (String(this.mailboxName ?? '').toLowerCase() === 'peer@example.com')
      throw new Error('simulated auth failure');
  };
  P.getAccessToken = async () => { tokenCalls++; return 'fake-token-not-real'; };
  P.getAccessTokenForScopes = async () => { tokenCalls++; return 'fake-token-not-real'; };
  P.tryReconnect = async () => false;
  P.getTokenHealthWarning = () => undefined;
  try {
    rmSync(join(home, 'tokens'), { recursive: true, force: true });
    mkdirSync(join(home, 'tokens'), { recursive: true });
    for (const m of ['me@example.com', 'peer@example.com']) {
      writeFileSync(join(home, 'tokens', pm.toFilesystemSafeKey(m) + '.json'), JSON.stringify({
        mailboxName: m, emailAddress: m, provider: 'microsoft',
        clientId: '11111111-2222-3333-4444-555555555555',
        tenantId: '00000000-0000-4000-8000-0000000000ee',
      }));
    }
    writeFileSync(join(home, 'shared-mailboxes.json'), JSON.stringify({ mailboxes: [
      { name: 'pp', emailAddress: 'peer@example.com', viaSignedInMailbox: 'me@example.com', access: 'read-only' },
    ] }));
    const st = srv.createLazyProviderState();
    await srv.initProvider(st);
    const acts = await srv.buildLazyActions(st, () => ({ entries: ['*'] }), () => ({}));
    const listed = (await acts.find(a => a.name === 'list_mailboxes').run({}, {})).mailboxes;
    const peps = listed.filter(m => (m.emailAddress ?? '').trim().toLowerCase() === 'peer@example.com' || m.name === 'pp');
    assert.equal(peps.length, 1, `pep listed ${peps.length} times: ${listed.map(m => m.name + ':' + m.status).join(',')}`);
    assert.equal(peps[0].status, 'error');
    assert.ok(!listed.some(m => m.name === 'pp'), `shared 'pp' was registered: ${listed.map(m => m.name + ':' + m.status).join(',')}`);
    let selErr = null;
    try { await acts.find(a => a.name === 'list_emails').run({}, { mailbox: 'peer@example.com', limit: 1 }); }
    catch (e) { selErr = e; }
    assert.ok(selErr, 'select peer@ should not succeed');
    assert.match(String(selErr.message), /not connected|auth failure|simulated auth/i);
    assert.doesNotMatch(String(selErr.message), /not configured/);
    return `peer@ listed once as error (${peps[0].status}); select by address is not "not configured"`;
  } finally {
    Object.assign(P, saved);
    rmSync(join(home, 'tokens'), { recursive: true, force: true });
    try { rmSync(join(home, 'shared-mailboxes.json')); } catch {}
  }
});
await t('shared: folder-root and store-ID ErrorItemNotFound map to mailbox not accessible; item-level stays not found', async () => {
  const cases = [
    ['Default folder Inbox not found', { error: { code: 'ErrorItemNotFound', message: 'Default folder Inbox not found' } }, true],
    ['Default folder Root not found', { error: { code: 'ErrorItemNotFound', message: 'Default folder Root not found' } }, true],
    ['store ID', { error: { code: 'ErrorItemNotFound', message: 'The store ID provided is not a valid store ID for this mailbox or you do not have access.' } }, true],
    ['item not found in the store', { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, false],
  ];
  const notes = [];
  for (const [label, body, mailboxLevel] of cases) {
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.hostname === 'graph.microsoft.com' && u.pathname.includes('/users/ghost2@example.com/')) {
        return new Response(JSON.stringify(body), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return prev(url, init);
    };
    try {
      const c = new pm.ReadOnlySharedMailboxGraphClient(getToken, async () => false, 'ghost2@example.com', 'ghost2');
      const provider = new pm.GraphEmailProvider(c, 'ghost2@example.com');
      if (mailboxLevel) {
        await assert.rejects(() => provider.listMessages({ folder: 'inbox', limit: 1 }), (e) => {
          assert.equal(e.name, 'SharedMailboxNotAccessibleError');
          assert.equal(e.code, 'SHARED_MAILBOX_NOT_ACCESSIBLE');
          assert.match(String(e.message), /not accessible/);
          return true;
        });
        await assert.rejects(() => provider.listFolders(), (e) => {
          assert.equal(e.name, 'SharedMailboxNotAccessibleError');
          return true;
        });
        await assert.rejects(() => provider.getMessage('m1'), (e) => {
          assert.equal(e.name, 'SharedMailboxNotAccessibleError');
          return true;
        });
      } else {
        await assert.rejects(() => provider.getMessage('m1'), (e) => {
          assert.equal(e.name, 'GraphApiError');
          assert.equal(e.status, 404);
          assert.match(String(e.body ?? e.message), /ErrorItemNotFound/);
          assert.notEqual(e.name, 'SharedMailboxNotAccessibleError');
          return true;
        });
        await assert.rejects(() => provider.getRawMessage('m1'), (e) => {
          // getRawMessage wraps a leftover item-level 404 as MessageNotFoundError.
          assert.equal(e.name, 'MessageNotFoundError');
          assert.notEqual(e.name, 'SharedMailboxNotAccessibleError');
          assert.match(String(e.message), /not found/i);
          return true;
        });
      }
      notes.push(label + (mailboxLevel ? '->not-accessible' : '->item-not-found'));
    } finally { globalThis.fetch = prev; }
  }
  return notes.join('; ');
});
await t('search_emails: pages via @odata.nextLink, never $skip; offset stays compatible', async () => {
  const mk = (id) => ({ id, subject: `S${id}`, bodyPreview: 'p', body: { contentType: 'text', content: 'c' },
    from: { emailAddress: { address: 'a@b.com', name: 'A' } }, toRecipients: [],
    receivedDateTime: '2026-11-17T00:00:00Z', isRead: true, conversationId: 'c1',
    parentFolderId: 'inbox', isDraft: false, internetMessageId: `<${id}@y>` });
  const page1UrlSuffix = '/messages?';
  const nextLink = 'https://graph.microsoft.com/v1.0/me/messages?$search=%22hello%22&$skiptoken=PAGE2';
  const seen = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'graph.microsoft.com' && u.searchParams.has('$search')) {
      if (u.searchParams.has('$skip'))
        return new Response(JSON.stringify({ error: { code: 'SearchWithSkip', message: 'The query parameter $skip is not supported with $search.' } }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      seen.push(u.href);
      if (u.searchParams.get('$skiptoken') === 'PAGE2')
        return new Response(JSON.stringify({ value: [mk('s4'), mk('s5'), mk('s6')] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ value: [mk('s1'), mk('s2'), mk('s3')], '@odata.nextLink': nextLink }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  try {
    const r0 = await call('search_emails', { query: 'hello', mailbox: 'me@example.com', limit: 3, offset: 0 });
    const ids0 = (r0.emails ?? []).map(m => m.id);
    assert.deepEqual(ids0, ['s1', 's2', 's3']);
    assert.equal(seen.length, 1, `offset 0 should not follow nextLink: ${seen.join(' | ')}`);
    assert.ok(!seen[0].includes('$skip='), seen[0]);
    const first = seen[0];
    seen.length = 0;
    const r1 = await call('search_emails', { query: 'hello', mailbox: 'me@example.com', limit: 2, offset: 3 });
    const ids1 = (r1.emails ?? []).map(m => m.id);
    assert.deepEqual(ids1, ['s4', 's5']);
    assert.equal(seen.length, 2, `offset 3 should follow nextLink: ${seen.join(' | ')}`);
    assert.ok(!seen[0].includes('$skip='), seen[0]);
    assert.ok(!seen[1].includes('$skip='), seen[1]);
    assert.equal(seen[1], nextLink);
    return `offset 0: 3 from page 1 (1 GET); offset 3: s4,s5 (2 GETs, nextLink, no $skip)`;
  } finally { globalThis.fetch = prev; }
});
await t('guards refuse a non-default Graph port and http, including nextLink', async () => {
  const okMe = 'https://graph.microsoft.com/v1.0/me/messages';
  const defaultPort = 'https://graph.microsoft.com:443/v1.0/me/messages';
  const portMe = 'https://graph.microsoft.com:8443/v1.0/me/messages';
  const httpMe = 'http://graph.microsoft.com/v1.0/me/messages';
  assert.equal(pm.classifyOwnMailboxRequest('GET', okMe, 'draft'), null);
  assert.equal(pm.classifyOwnMailboxRequest('GET', defaultPort, 'draft'), null);
  assert.match(pm.classifyOwnMailboxRequest('GET', portMe, 'draft'), /origin other than https:\/\/graph\.microsoft\.com/);
  assert.match(pm.classifyOwnMailboxRequest('GET', httpMe, 'draft'), /origin other than https:\/\/graph\.microsoft\.com/);
  const t0 = tokenCalls, f0 = fetchCalls.length;
  await assert.rejects(() => ownClient.get(portMe), (e) => {
    assert.equal(e.name, 'OwnMailboxRequestRefusedError');
    assert.match(String(e.message), /origin other than https:\/\/graph\.microsoft\.com/);
    return true;
  });
  await assert.rejects(() => ownClient.get(httpMe), (e) => {
    assert.equal(e.name, 'OwnMailboxRequestRefusedError');
    return true;
  });
  const shPort = 'https://graph.microsoft.com:8443/v1.0/users/sentlog@example.com/messages';
  const shHttp = 'http://graph.microsoft.com/v1.0/users/sentlog@example.com/messages';
  await assert.rejects(() => shClient.get(shPort), (e) => {
    assert.match(String(e.message), /refused/);
    assert.match(String(e.message), /URL outside the pinned shared mailbox/);
    return true;
  });
  await assert.rejects(() => shClient.get(shHttp), (e) => {
    assert.match(String(e.message), /refused/);
    return true;
  });
  assert.equal(tokenCalls, t0);
  assert.equal(fetchCalls.length, f0);
  const nextLink = 'https://graph.microsoft.com:8443/v1.0/me/messages?$search=%22hello%22&$skiptoken=PAGE2';
  const prev = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    seen.push(u.href);
    if (u.origin !== 'https://graph.microsoft.com')
      throw new Error(`UNEXPECTED NETWORK to ${u.origin}`);
    if (u.hostname === 'graph.microsoft.com' && u.searchParams.has('$search')) {
      return new Response(JSON.stringify({
        value: [{ id: 's1', subject: 'S1', bodyPreview: 'p', body: { contentType: 'text', content: 'c' },
          from: { emailAddress: { address: 'a@b.com', name: 'A' } }, toRecipients: [],
          receivedDateTime: '2026-11-17T00:00:00Z', isRead: true, conversationId: 'c1',
          parentFolderId: 'inbox', isDraft: false, internetMessageId: '<s1@y>' }],
        '@odata.nextLink': nextLink,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  try {
    await assert.rejects(() => call('search_emails', { query: 'hello', mailbox: 'me@example.com', limit: 2, offset: 0 }), (e) => {
      assert.equal(e.name, 'OwnMailboxRequestRefusedError');
      return true;
    });
    assert.ok(seen.every(u => !u.includes(':8443')), `port URL was fetched: ${seen.join(' | ')}`);
  } finally { globalThis.fetch = prev; }
  return 'port and http refused on own and shared clients; hostile nextLink not followed';
});
await t('guards refuse Graph URLs that carry a username or password, including nextLink', async () => {
  const userPass = 'https://user:pass@graph.microsoft.com/v1.0/me/messages';
  const userOnly = 'https://user@graph.microsoft.com/v1.0/me/messages';
  const passOnly = 'https://:pass@graph.microsoft.com/v1.0/me/messages';
  assert.match(pm.classifyOwnMailboxRequest('GET', userPass, 'draft'), /username or password/);
  assert.match(pm.classifyOwnMailboxRequest('GET', userOnly, 'draft'), /username or password/);
  assert.match(pm.classifyOwnMailboxRequest('GET', passOnly, 'draft'), /username or password/);
  const t0 = tokenCalls, f0 = fetchCalls.length;
  await assert.rejects(() => ownClient.get(userPass), (e) => {
    assert.equal(e.name, 'OwnMailboxRequestRefusedError');
    assert.match(String(e.message), /username or password/);
    return true;
  });
  const shUser = 'https://user:pass@graph.microsoft.com/v1.0/users/sentlog@example.com/messages';
  await assert.rejects(() => shClient.get(shUser), (e) => {
    assert.equal(e.name, 'SharedMailboxRequestRefusedError');
    assert.match(String(e.message), /URL outside the pinned shared mailbox/);
    return true;
  });
  assert.equal(tokenCalls, t0);
  assert.equal(fetchCalls.length, f0);
  const nextLink = 'https://user:pass@graph.microsoft.com/v1.0/me/messages?$search=%22hello%22&$skiptoken=PAGE2';
  const prev = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    seen.push(u.origin + u.pathname);
    if (u.username || u.password)
      throw new Error('UNEXPECTED NETWORK to a URL with userinfo');
    if (u.origin !== 'https://graph.microsoft.com')
      throw new Error(`UNEXPECTED NETWORK to ${u.origin}`);
    if (u.hostname === 'graph.microsoft.com' && u.searchParams.has('$search')) {
      return new Response(JSON.stringify({
        value: [{ id: 's1', subject: 'S1', bodyPreview: 'p', body: { contentType: 'text', content: 'c' },
          from: { emailAddress: { address: 'a@b.com', name: 'A' } }, toRecipients: [],
          receivedDateTime: '2026-11-17T00:00:00Z', isRead: true, conversationId: 'c1',
          parentFolderId: 'inbox', isDraft: false, internetMessageId: '<s1@y>' }],
        '@odata.nextLink': nextLink,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  try {
    await assert.rejects(() => call('search_emails', { query: 'hello', mailbox: 'me@example.com', limit: 2, offset: 0 }), (e) => {
      assert.equal(e.name, 'OwnMailboxRequestRefusedError');
      assert.match(String(e.message), /username or password/);
      return true;
    });
    assert.ok(seen.every(s => !s.includes('user')), `userinfo URL was fetched: ${seen.join(' | ')}`);
  } finally { globalThis.fetch = prev; }
  return 'userinfo refused on own and shared clients; hostile nextLink not followed';
});
await t('shared: a refused GET is not labelled as a write refusal', async () => {
  const t0 = tokenCalls, f0 = fetchCalls.length;
  await assert.rejects(() => shClient.get('https://graph.microsoft.com:8443/v1.0/users/sentlog@example.com/messages'), (e) => {
    assert.equal(e.name, 'SharedMailboxRequestRefusedError');
    assert.notEqual(e.name, 'SharedMailboxWriteRefusedError');
    assert.equal(e.code, 'SHARED_MAILBOX_READ_ONLY');
    assert.match(String(e.message), /^SHARED_MAILBOX_READ_ONLY:/);
    assert.equal(e instanceof pm.SharedMailboxRequestRefusedError, true);
    assert.equal(e instanceof pm.SharedMailboxWriteRefusedError, false);
    return true;
  });
  await assert.rejects(() => shClient.post('/users/sentlog@example.com/sendMail', {}), (e) => {
    assert.equal(e.name, 'SharedMailboxWriteRefusedError');
    assert.equal(e instanceof pm.SharedMailboxWriteRefusedError, true);
    assert.equal(e instanceof pm.SharedMailboxRequestRefusedError, true);
    assert.equal(e.code, 'SHARED_MAILBOX_READ_ONLY');
    return true;
  });
  assert.equal(tokenCalls, t0);
  assert.equal(fetchCalls.length, f0);
  return 'GET -> SharedMailboxRequestRefusedError; POST still SharedMailboxWriteRefusedError';
});
await t('shared: unknown mailbox name in a tool call refused', () => refusedNoNet('unknown', () => call('list_emails', { mailbox: 'support@example.com' }), /not configured/));
// Receive allowlist for `watch` (upstream #267 backport): an existing file that is
// malformed or unreadable blocks every sender; a missing file keeps accept-all.
const raDir = join(home, 'receive-allowlist-test'); mkdirSync(raDir, { recursive: true });
const raFile = (name, body) => { const p = join(raDir, name); if (body !== undefined) writeFileSync(p, body); return p; };
const raNoWatch = () => ({ on() { return this; }, unref() {}, close() {} });
const raStart = async (p) => { const w = new core.WatchedAllowlist(p, core.loadReceiveAllowlist, 150, raNoWatch); await w.start(); return w; };
await t('watch: malformed or unreadable receive allowlist at startup accepts no sender', async () => {
  const cases = { 'bad-json': '{"entries": [', 'no-entries': '{}', 'entries-not-array': '{"entries": "*"}', 'non-string-entry': '{"entries": ["*", 1]}', 'array-root': '[]' };
  const unreadable = join(raDir, 'is-a-dir'); mkdirSync(unreadable, { recursive: true });
  const paths = [...Object.entries(cases).map(([n, b]) => raFile(n + '.json', b)), unreadable];
  for (const p of paths) {
    const w = await raStart(p);
    for (const who of ['anyone@example.com', 'sender@example.org', '']) assert.equal(core.isAllowedSender(who, w.config), false, `${p}: ${who || '(empty)'} accepted`);
    assert.ok(w.config && w.config.invalid === true, `${p}: not marked invalid`);
    w.close();
  }
  return `${paths.length} bad files -> no sender accepted`;
});
await t('watch: valid receive allowlist still filters; missing file and explicit [] keep accept-all', async () => {
  const w = await raStart(raFile('good.json', JSON.stringify({ entries: ['*@example.com', 'person@example.org'] })));
  assert.equal(w.config.invalid, undefined);
  assert.equal(core.isAllowedSender('a@example.com', w.config), true);
  assert.equal(core.isAllowedSender('person@example.org', w.config), true);
  assert.equal(core.isAllowedSender('other@example.org', w.config), false);
  w.close();
  const missing = await raStart(join(raDir, 'missing.json'));
  assert.equal(missing.config, undefined); assert.equal(core.isAllowedSender('x@example.net', missing.config), true); missing.close();
  const empty = await raStart(raFile('empty.json', '{"entries": []}'));
  assert.equal(core.isAllowedSender('x@example.net', empty.config), true); empty.close();
});
await t('watch: a malformed reload keeps the last good receive allowlist', async () => {
  const p = raFile('reload.json', JSON.stringify({ entries: ['*@example.com'] }));
  const w = await raStart(p);
  writeFileSync(p, '{"entries": [');
  await w.reload();
  assert.deepEqual(w.config.entries, ['*@example.com']);
  assert.equal(core.isAllowedSender('a@example.com', w.config), true);
  assert.equal(core.isAllowedSender('b@example.org', w.config), false);
  w.close();
});
await t('watch: startup with a malformed receive allowlist warns it is blocking senders', async () => {
  const { spawnSync } = await import('node:child_process');
  const wh = join(raDir, 'watch-home'); mkdirSync(join(wh, '.email-agent-mcp'), { recursive: true });
  const env = { ...process.env, HOME: wh, USERPROFILE: wh, EMAIL_AGENT_MCP_HOME: join(wh, '.email-agent-mcp'), AGENT_EMAIL_RECEIVE_ALLOWLIST: raFile('bad-json.json') };
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'tools', 'no-network.mjs')).href, join(NM, 'email-agent-mcp', 'bin', 'email-agent-mcp.js'), 'watch'], { env, encoding: 'utf8', timeout: 60000 });
  const err = r.stderr || '';
  assert.match(err, /WARNING: Invalid receive allowlist at .*Malformed allowlist JSON.*blocking all senders/);
  assert.doesNotMatch(err, /accepting all senders/);
  assert.match(err, /No configured mailboxes found/);
  assert.equal(r.status, 1);
  return 'exit 1 before any mailbox is polled';
});
await t('no request ever left for a non-Graph host', async () => { assert.ok(fetchCalls.every(c => c.host === 'graph.microsoft.com')); return `${fetchCalls.length} mocked Graph requests total`; });
const guardLog = existsSync(join(home, 'shared-mailbox-guard.log')) ? readFileSync(join(home, 'shared-mailbox-guard.log'), 'utf-8').trim().split('\n').length : 0;
out.push(`\nGuard log lines written to scratch: ${guardLog}`);
console.log(out.join('\n'));
console.log(`\nSUMMARY: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
