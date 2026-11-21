// Live install verification for the team build (Windows, macOS, Linux).
// Prints scope names and pass/fail only — never tokens or mail bodies.
// Usage: node verify-install.mjs [--launcher PATH] [--install DIR] [--out FILE] [--stdout]
//          <userMailbox> [sharedName=address | shared@address ...]
// Defaults: launcher ${EMAIL_AGENT_MCP_HOME:-<home>/.email-agent-mcp}/bin/team-email-agent-mcp-stdio.mjs
//           install  ${EMAIL_AGENT_MCP_HOME:-<home>/.email-agent-mcp}/patched-install
// Prints to stdout only. A file is written only when --out FILE is given.
// A user mailbox is required. Shared mailboxes are optional; with none, the
// shared-mailbox section is skipped. Missing required arguments fail closed (exit 2).
import { spawn } from 'node:child_process';
import { existsSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scrub = s => String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
function usage() {
  console.error('verify-install: usage: node verify-install.mjs [--launcher PATH] [--install DIR] [--out FILE] [--stdout] <userMailbox> [sharedName=address ...]');
  console.error('A user mailbox address is required. Shared mailboxes are optional.');
}
const bail = (msg) => { if (msg) console.error(`verify-install: ${msg}`); usage(); process.exit(2); };

function parseShared(arg) {
  const s = String(arg);
  if (!s) return null;
  const eq = s.indexOf('=');
  if (eq > 0) {
    const name = s.slice(0, eq).trim();
    const address = s.slice(eq + 1).trim();
    if (!name || !address) return null;
    return { name, address };
  }
  const at = s.indexOf('@');
  if (at > 0) {
    const name = s.slice(0, at).trim();
    const address = s.trim();
    if (!name || !address) return null;
    return { name, address };
  }
  return null;
}

const EAM_HOME = process.env.EMAIL_AGENT_MCP_HOME || join(homedir(), '.email-agent-mcp');
let LAUNCHER = process.env.TEAM_EMAIL_LAUNCHER || join(EAM_HOME, 'bin', 'team-email-agent-mcp-stdio.mjs');
let INSTALL = join(EAM_HOME, 'patched-install');
let OUT_FILE = '';
const argv = process.argv.slice(2);
while (argv.length) {
  const a = argv[0];
  if (a === '--launcher' || a === '--install' || a === '--out') {
    const v = argv[1];
    if (v === undefined || v === '' || v.startsWith('-')) bail(`${a} requires a non-empty path that does not start with -.`);
    if (a === '--launcher') LAUNCHER = v; else if (a === '--install') INSTALL = v; else OUT_FILE = v;
    argv.splice(0, 2);
  } else if (a === '--stdout') { OUT_FILE = ''; argv.shift(); }
  else if (a === '--help' || a === '-h') bail();
  else if (a === '--') { argv.shift(); break; }
  else if (a.startsWith('-')) bail(`unknown option: ${a}`);
  else break;
}
const [ME, ...sharedArgs] = argv;
if (!ME) bail('a user mailbox address is required.');
if (process.env.VERIFY_INSTALL_PRINT_ARGS === '1') {
  process.stdout.write(`launcher=${LAUNCHER}\ninstall=${INSTALL}\nmailbox=${ME}\nshared=${sharedArgs.join(' ')}\n`);
  process.exit(0);
}
if (!existsSync(LAUNCHER)) { console.error(`verify-install: launcher missing: ${LAUNCHER}`); process.exit(2); }
if (!existsSync(INSTALL) || !statSync(INSTALL).isDirectory()) { console.error(`verify-install: install dir missing or not a directory: ${INSTALL}`); process.exit(2); }
// Results go to stdout, and also to --out FILE when given (like tee).
if (OUT_FILE) writeFileSync(OUT_FILE, '');
// Exit only after stdout drains: process.exit() right after a large write can drop piped output (macOS).
const exitAfterFlush = (code) => new Promise(() => process.stdout.write('', () => process.exit(code)));
const emit = (text) => { process.stdout.write(text + '\n'); if (OUT_FILE) appendFileSync(OUT_FILE, text + '\n'); };

const shared = [];
for (const arg of sharedArgs) {
  const parsed = parseShared(arg);
  if (!parsed) {
    console.error(`verify-install: invalid shared mailbox argument: ${arg}`);
    console.error('Use name=address or an email address.');
    process.exit(2);
  }
  shared.push(parsed);
}

const SUBJECT = 'TEAM-EMAIL INSTALL TEST - delete me';
const results = []; let failed = 0;
const rec = (ok, label, note = '') => { if (!ok) failed++; results.push(`${ok ? 'PASS' : 'FAIL'}: ${label}${note ? ' — ' + note : ''}`); };

// 1. Scope names in the issued tokens (decoded claims, scp only; token never printed or stored)
try {
  const pm = await import(pathToFileURL(join(INSTALL, 'node_modules/@usejunior/provider-microsoft/dist/index.js')).href);
  const md = await pm.loadMailboxMetadata(ME);
  if (!md) throw new Error(`no saved sign-in for ${ME}; run configure first`);
  const auth = new pm.DelegatedAuthManager({ mode: 'delegated', clientId: md.clientId, tenantId: md.tenantId }, md.mailboxName);
  await auth.reconnect();
  const scp = t => (JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).scp || '').split(' ').sort();
  const own = scp(await auth.getAccessToken());
  results.push(`INFO: client id ${md.clientId}`);
  results.push(`INFO: own token scp = ${own.join(' ')}`);
  rec(!own.some(s => /^Mail\.Send|^MailboxSettings|EWS/i.test(s)), 'own token has no Mail.Send / MailboxSettings / EWS');
  rec(own.includes('Mail.ReadWrite') && own.includes('Mail.Read.Shared'), 'own token has Mail.ReadWrite + Mail.Read.Shared');
  const sh = scp(await auth.getAccessTokenForScopes(pm.SHARED_MAILBOX_SCOPES));
  results.push(`INFO: shared-mailbox token scp = ${sh.join(' ')}`);
} catch (e) { rec(false, 'token scope check', scrub(e.message).slice(0, 200)); }

// 2. Everything else through the real MCP stdio connector
const p = spawn(process.execPath, [LAUNCHER], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waiters = new Map(); let id = 0;
// If the launcher exits (e.g. it refused to start), fail now instead of waiting for the timeout.
p.on('exit', (c) => { const e = new Error(`launcher exited (code ${c})`); for (const w of waiters.values()) w.rej?.(e); waiters.clear(); });
p.stdin.on('error', () => {});
p.stderr.on('data', () => {});
p.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m && m.id != null) waiters.get(m.id)?.res(m);
  }
});
const rpc = (method, params) => new Promise((res, rej) => { const n = ++id; if (p.exitCode !== null) return rej(new Error('launcher exited')); waiters.set(n, { res, rej }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); setTimeout(() => rej(new Error('timeout ' + method)), 90000); });
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.error?.message ?? (r.result?.content ?? []).map(c => c.text ?? '').join('\n');
  let json = r.result?.structuredContent; if (!json) { try { json = JSON.parse(text); } catch { /* text */ } }
  return { isError: !!(r.error || r.result?.isError || json?.success === false), text: scrub(text), json };
};
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-install', version: '1' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
const banned = ['send_email', 'send_draft', 'reply_to_email', 'delete_email', 'create_inbox_rule', 'list_inbox_rules', 'delete_inbox_rule', 'delete_folder', 'create_folder', 'cancel_scheduled_send'];
rec(!banned.some(b => tools.includes(b)), 'tools/list has no send/delete/rules tools', `${tools.length} tools`);
const mbs = await call('list_mailboxes', {});
results.push(`INFO: list_mailboxes -> ${(mbs.json?.mailboxes ?? []).map(m => `${m.name}:${m.status}`).join(', ') || mbs.text.slice(0, 150)}`);
// Abort unless the user mailbox is really connected (demo mode returns fake mail and would give false passes).
const mbList = mbs.json?.mailboxes ?? [];
const conn = n => mbList.some(m => (m.name === n || m.emailAddress === n) && m.status === 'connected');
if (!conn(ME)) {
  rec(false, `precheck: ${ME} connected`, 'not connected; stopping before any mailbox call');
  p.kill(); emit(results.join('\n')); emit(`\nSUMMARY: aborted, ${failed} failed`); await exitAfterFlush(1);
}
rec(true, `precheck: ${ME} connected`);
const missingShared = shared.filter(s => !conn(s.name) && !conn(s.address));
if (missingShared.length) {
  rec(false, `precheck: requested shared mailbox(es) connected`, missingShared.map(s => s.address || s.name).join(', ') + ' not connected; stopping before any mailbox call');
  p.kill(); emit(results.join('\n')); emit(`\nSUMMARY: aborted, ${failed} failed`); await exitAfterFlush(1);
}
if (shared.length) rec(true, `precheck: ${shared.map(s => s.name).join(', ')} connected`);
// own inbox read
const own = await call('list_emails', { mailbox: ME, limit: 3 });
rec(!own.isError && Array.isArray(own.json?.emails), 'read own inbox (list_emails)', `${own.json?.emails?.length ?? 0} messages`);
if (own.json?.emails?.[0]) { const r = await call('read_email', { mailbox: ME, id: own.json.emails[0].id }); rec(!r.isError, 'read_email on own message'); }
// own draft
const d = await call('create_draft', { mailbox: ME, to: [ME], subject: SUBJECT, body: 'Install test of the team email-agent-mcp build. Safe to delete.' });
const draftId = d.json?.draftId;
rec(!d.isError && !!draftId, `create_draft in own mailbox ("${SUBJECT}")`, draftId ? 'draft created (delete it in Outlook)' : d.text.slice(0, 160));
// refusals on own mailbox
const s1 = await call('send_email', { mailbox: ME, to: [ME], subject: SUBJECT, body: 'must not send' });
rec(s1.isError && /unavailable/i.test(s1.text), 'send_email refused', s1.text.slice(0, 100));
const s2 = await call('send_draft', { mailbox: ME, draft_id: draftId ?? 'none' });
rec(s2.isError && /unavailable/i.test(s2.text), 'send_draft refused', s2.text.slice(0, 100));
// shared mailboxes: read with isRead unchanged; skip this section when none were given.
// Refusal probes must stay harmless even if the guard has regressed: every
// shared write uses a fake id, the current read state, a nonexistent folder,
// and an RFC 2606 .invalid recipient. Never send a real message id, never
// flip isRead, never move to a real folder, never use a real address.
for (const s of shared) {
  const box = s.name;
  const listed = await call('list_emails', { mailbox: box, limit: 3 });
  const m0 = listed.json?.emails?.[0];
  rec(!listed.isError && !!m0, `read ${box} (list_emails)`, m0 ? `${listed.json.emails.length} messages` : listed.text.slice(0, 160));
  if (m0) {
    const rd = await call('read_email', { mailbox: box, id: m0.id });
    rec(!rd.isError, `read_email on ${box}`);
  }
  const fakeId = 'AAMk-FAKE-guard-test-id';
  const state = m0?.isRead ?? true;
  for (const [tool, args] of [
    ['mark_read', { mailbox: box, id: fakeId, is_read: state }],
    ['move_to_folder', { mailbox: box, id: fakeId, folder: '__guard_test_nonexistent__' }],
    ['flag_email', { mailbox: box, id: fakeId, flagged: true }],
    ['create_draft', { mailbox: box, to: 'guard-test@example.invalid', subject: 'guard test - must never be created', body: 'x' }],
    ['send_email', { mailbox: box, to: 'guard-test@example.invalid', subject: 'guard test - must never be sent', body: 'x' }],
  ]) {
    const r = await call(tool, args);
    rec(r.isError && /SHARED_MAILBOX_READ_ONLY/.test(r.text), `${tool} on ${box} refused`, r.text.slice(0, 90));
  }
  if (m0) {
    const after = await call('list_emails', { mailbox: box, limit: 3 });
    const m1 = (after.json?.emails ?? []).find(e => e.id === m0.id);
    rec(!!m1 && m1.isRead === m0.isRead, `${box} isRead unchanged after read + refused writes`, `isRead ${m0.isRead} -> ${m1?.isRead}`);
  }
}
p.kill();
emit(results.join('\n'));
emit(`\nSUMMARY: ${results.filter(r => r.startsWith('PASS')).length} passed, ${failed} failed`);
await exitAfterFlush(failed ? 1 : 0);
