// Spawn the installed launcher (scratch HOME, no mailboxes => demo mode) and speak MCP over stdio.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
if (!process.argv[2]) { console.error('usage: mcp-stdio-test.mjs <launcher>'); process.exit(2); }
const launcher = resolve(process.argv[2]);
// Minimal env: HOME (+ the Windows profile vars the launcher needs) and the optional profile / test hooks.
const keep = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'EMAIL_AGENT_MCP_HOME', 'EMAIL_AGENT_MCP_SCOPE_PROFILE', 'NODE_OPTIONS', 'TRACE_OUT'];
const env = { PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin' };
for (const k of keep) if (process.env[k]) env[k] = process.env[k];
const p = spawn(process.execPath, [launcher], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', err = ''; const waiters = new Map();
p.stderr.on('data', d => err += d);
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); waiters.get(m.id)?.(m); } });
let id = 0;
const rpc = (method, params) => new Promise((res, rej) => { const myId = ++id; waiters.set(myId, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n'); setTimeout(() => rej(new Error('timeout ' + method)), 15000); });
const exit = new Promise(r => p.on('exit', c => r(c)));
const race = await Promise.race([rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }).then(r => ({ r })), exit.then(c => ({ exit: c }))]);
if (race.exit !== undefined) { console.log(JSON.stringify({ started: false, exitCode: race.exit, stderr: err.trim().split('\n').slice(-3) })); process.exit(1); }
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await rpc('tools/list', {});
const names = list.result.tools.map(t => t.name);
const calls = {};
for (const t of ['send_email', 'send_draft', 'reply_to_email', 'delete_email', 'list_inbox_rules', 'create_inbox_rule']) {
  const r = await rpc('tools/call', { name: t, arguments: {} });
  calls[t] = (r.error?.message ?? r.result?.content?.[0]?.text ?? '').slice(0, 120);
}
console.log(JSON.stringify({ started: true, stderrStart: err.split('\n').filter(l => /scope profile|allowlist|Delete policy/.test(l)), tools: names, calls }, null, 1));
p.kill();
