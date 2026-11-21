// Install the TEAM build of email-agent-mcp for the current user.
// Windows, macOS and Linux:  node install.mjs [--replace-existing]
// (run from the unpacked package directory; --replace-existing only counts as the first argument)
// Puts the install at $EMAIL_AGENT_MCP_HOME/patched-install (default
// <home>/.email-agent-mcp/patched-install) and the launcher at
// $EMAIL_AGENT_MCP_HOME/bin/team-email-agent-mcp-stdio.mjs.
// Does NOT sign in, call Microsoft, or touch tokens.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const die = (m) => { process.stderr.write(`install.mjs: ${m}\n`); process.exit(1); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const HERE = dirname(fileURLToPath(import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 20) die('node >= 20 is required');
const args = process.argv.slice(2);
const FORCE = args[0] === '--replace-existing';
if (args.length > (FORCE ? 1 : 0)) die(`unexpected argument(s): ${args.slice(FORCE ? 1 : 0).join(' ')} (only --replace-existing, as the first argument)`);
const HOME = homedir();
if (!HOME) die('HOME not set');
const EAM_HOME = resolve(process.env.EMAIL_AGENT_MCP_HOME || join(HOME, '.email-agent-mcp'));
const D = join(EAM_HOME, 'patched-install');
const BIN = resolve(process.env.TEAM_EMAIL_MCP_BIN_DIR || join(EAM_HOME, 'bin'));
const LAUNCHER = join(BIN, 'team-email-agent-mcp-stdio.mjs');

// 1. Package files match package-files.sha256 (strict: every line well formed, every file present).
const REQUIRED = ['install.tar', 'team-install.sha256', 'team-install.links', 'team-email-agent-mcp-stdio.mjs', 'package-files.sha256'];
for (const f of REQUIRED) if (!existsSync(join(HERE, f))) die(`missing ${f}`);
const listed = new Set();
for (const line of readFileSync(join(HERE, 'package-files.sha256'), 'utf8').split('\n')) {
  if (!line) continue;
  const m = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
  if (!m) die('package files failed their sha256 check (malformed package-files.sha256)');
  let buf;
  try { buf = readFileSync(join(HERE, m[2])); } catch { die(`package files failed their sha256 check (${m[2]} missing)`); }
  if (sha(buf) !== m[1]) die(`package files failed their sha256 check (${m[2]})`);
  listed.add(m[2]);
}
for (const f of REQUIRED.filter((f) => f !== 'package-files.sha256')) if (!listed.has(f)) die(`package files failed their sha256 check (${f} not listed)`);

// 2. Never overwrite a non-team install (e.g. a personal/full email-agent-mcp).
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
if (existsSync(D)) {
  if (!existsSync(join(D, 'TEAM-BUILD.json')) && !FORCE) die(`${D} exists and is not a team build. Refusing to replace it. Re-run with --replace-existing only if you are sure.`);
  const BK = `${D}.bak-${stamp()}`;
  renameSync(D, BK);
  process.stderr.write(`Previous install moved to ${BK}\n`);
}

// 3. Extract install.tar (ustar/GNU tar: regular files and directories only; links and odd paths refuse).
if (!WIN) process.umask(0o077);
mkdirSync(EAM_HOME, { recursive: true, mode: 0o700 }); mkdirSync(BIN, { recursive: true, mode: 0o700 });
if (!WIN) chmodSync(EAM_HOME, 0o700);
mkdirSync(D, { recursive: true });
function extract(tar, dest) {
  const str = (b, o, n) => { const s = b.subarray(o, o + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString('utf8'); };
  const num = (b, o, n) => parseInt(str(b, o, n).trim() || '0', 8);
  let off = 0, longName = null, paxPath = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== num(h, 148, 8)) die('install.tar is corrupt (header checksum)');
    const type = String.fromCharCode(h[156] || 48), size = num(h, 124, 12), mode = num(h, 100, 8);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(body, 0, body.length); continue; }
    if (type === 'x') { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    const prefix = str(h, 345, 155);
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = paxPath = null;
    const parts = name.split('/').filter((p) => p && p !== '.');
    if (name.startsWith('/') || name.includes('\\') || parts.some((p) => p === '..' || p.includes(':'))) die(`install.tar has an unsafe path: ${name}`);
    const out = join(dest, ...parts);
    if (type === '5') { mkdirSync(out, { recursive: true }); continue; }
    if (type !== '0') die(`install.tar has an unsupported entry (type ${type}): ${name}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body, { mode: WIN ? undefined : mode & 0o700 });
  }
}
extract(readFileSync(join(HERE, 'install.tar')), D);
const copy = (f, to, mode) => { writeFileSync(to, readFileSync(join(HERE, f)), { mode }); if (!WIN) chmodSync(to, mode); };
copy('team-install.sha256', join(EAM_HOME, 'team-install.sha256'), 0o600);
copy('team-install.links', join(EAM_HOME, 'team-install.links'), 0o600);
copy('team-email-agent-mcp-stdio.mjs', LAUNCHER, 0o700);

// 4. Empty send allowlist by default (the team build has no send tools anyway).
const SA = join(EAM_HOME, 'send-allowlist.json');
const emptyAllowlist = () => { try { const e = JSON.parse(readFileSync(SA, 'utf8')).entries; return Array.isArray(e) && e.length === 0; } catch { return false; } };
if (existsSync(SA) && !emptyAllowlist()) {
  renameSync(SA, `${SA}.bak-${stamp()}`);
  process.stderr.write('Non-empty send-allowlist.json backed up and replaced with an empty one\n');
}
if (!existsSync(SA)) writeFileSync(SA, '{"entries": []}\n', { mode: 0o600 });

// 5. Verify: launcher integrity check + offline help (no network, no sign-in).
const v = spawnSync(process.execPath, [LAUNCHER, 'help'], { stdio: 'ignore', env: { ...process.env, EMAIL_AGENT_MCP_HOME: EAM_HOME } });
if (v.status !== 0) die('post-install verification failed');
const old = join(HOME, '.local', 'bin', 'team-email-agent-mcp-stdio');
if (!WIN && existsSync(old) && statSync(old).isFile()) process.stderr.write(`Note: the old bash launcher ${old} no longer matches this install and will refuse to start. Point the connector at the new launcher below.\n`);
process.stderr.write(`Installed team build to ${D}; launcher ${LAUNCHER}\n`);
process.stderr.write(`Connector: command "node", args ["${LAUNCHER.split(sep).join(WIN ? '\\\\' : '/')}"]\n`);
// @@client-id-hint: only a well-formed GUID from TEAM-BUILD.json is printed (tests/install-test.mjs).
const CLIENT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function clientIdHint(raw) { return typeof raw === 'string' && CLIENT_GUID.test(raw) ? raw.toLowerCase() : '<team-client-id>'; }
// @@end-client-id-hint
let CID = '<team-client-id>';
try { CID = clientIdHint(JSON.parse(readFileSync(join(D, 'TEAM-BUILD.json'), 'utf8')).teamClientId); } catch { /* keep the placeholder */ }
process.stderr.write(`Next: node "${LAUNCHER}" configure --mailbox <user>@example.com --provider microsoft --client-id ${CID}\n`);
