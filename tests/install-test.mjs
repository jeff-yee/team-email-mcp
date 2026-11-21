// Offline install, refusal and tamper tests for the unpacked team package
// (Windows, macOS, Linux). Every install goes into a temp HOME (plus APPDATA on
// Windows). Every child node runs with tools/no-network.mjs, so nothing can
// reach Microsoft or anything else.
// Usage: node --import <no-network.mjs URL> tests/install-test.mjs <unpackedPackageDir>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, rmSync, cpSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = process.argv[2] && resolve(process.argv[2]);
if (!PKG || !existsSync(join(PKG, 'install.mjs'))) { console.error('usage: install-test.mjs <unpackedPackageDir>'); process.exit(2); }
const WIN = process.platform === 'win32';
const NO_NET = `--import=${pathToFileURL(join(ROOT, 'tools', 'no-network.mjs')).href}`;
const SCRATCH = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'install-test-'));
// Windows keeps loaded .node files locked until exit, so cleanup is best effort.
process.on('exit', () => { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* left for the OS temp cleaner */ } });
let passes = 0, fails = 0;
const check = (ok, m, extra = '') => { if (ok) { passes++; console.log(`PASS: ${m}`); } else { fails++; console.error(`FAIL: ${m}`); if (extra) console.error(String(extra).slice(-2000)); } };

let n = 0;
function newHome() {
  const h = join(SCRATCH, `home${++n}`);
  mkdirSync(join(h, 'AppData', 'Roaming'), { recursive: true }); mkdirSync(join(h, 'AppData', 'Local'), { recursive: true });
  return h;
}
function envFor(home, extra = {}) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: NO_NET };
  if (WIN) { e.APPDATA = join(home, 'AppData', 'Roaming'); e.LOCALAPPDATA = join(home, 'AppData', 'Local'); }
  for (const k of ['EMAIL_AGENT_MCP_HOME', 'EMAIL_AGENT_MCP_SCOPE_PROFILE', 'TEAM_EMAIL_MCP_BIN_DIR', 'TEAM_EMAIL_MCP_INSTALL_DIR', 'TEAM_EMAIL_MCP_MANIFEST']) delete e[k];
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete e[k]; else e[k] = v; }
  return e;
}
function node(args, env, input) {
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 120000, input });
  return { ec: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}
const install = (home, args = [], pkg = PKG, extra = {}) => node([join(pkg, 'install.mjs'), ...args], envFor(home, extra));
const eam = (home) => join(home, '.email-agent-mcp');
const launcher = (home) => join(eam(home), 'bin', 'team-email-agent-mcp-stdio.mjs');
const D = (home) => join(eam(home), 'patched-install');
const launch = (home, args, extra) => node([launcher(home), ...args], envFor(home, extra));
const refused = (r) => r.ec !== 0 && r.out.includes('REFUSING to start');

// 1. Fresh install, then the offline CLI and MCP stdio through the launcher.
const h1 = newHome();
let r = install(h1);
check(r.ec === 0 && existsSync(launcher(h1)) && existsSync(join(D(h1), 'TEAM-BUILD.json')), 'fresh install into a temp HOME', r.out);
check(readFileSync(join(eam(h1), 'send-allowlist.json'), 'utf8') === '{"entries": []}\n', 'empty send allowlist written');
check(existsSync(join(eam(h1), 'team-install.links')) && readFileSync(join(eam(h1), 'team-install.links'), 'utf8') === '', 'package has no symlinks (empty .links)');
{
  const tb = JSON.parse(readFileSync(join(D(h1), 'TEAM-BUILD.json'), 'utf8'));
  const next = r.out.split('\n').find((l) => l.startsWith('Next: ')) || '';
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tb.teamClientId) && next.endsWith(`--client-id ${tb.teamClientId}`),
    'install prints the configure hint with the GUID team client id from TEAM-BUILD.json', next);
  // The shipped install.mjs only prints a well-formed GUID; anything else falls back to the placeholder.
  const src = readFileSync(join(PKG, 'install.mjs'), 'utf8');
  const body = /\/\/ @@client-id-hint[^\n]*\n([\s\S]*?)\/\/ @@end-client-id-hint/.exec(src)?.[1];
  let hint = null;
  try { hint = new Function(`${body}; return clientIdHint;`)(); } catch { /* reported below */ }
  const G = '0000000a-0000-4000-8000-0000000000cc';
  const cases = [[G, G], [G.toUpperCase(), G], ['not-a-guid', '<team-client-id>'], [`${G} --tenant evil`, '<team-client-id>'], [`${G}\n`, '<team-client-id>'],
    ['', '<team-client-id>'], [undefined, '<team-client-id>'], [null, '<team-client-id>'], [42, '<team-client-id>'], [[G], '<team-client-id>']];
  check(typeof hint === 'function' && cases.every(([inp, want]) => hint(inp) === want), 'install.mjs GUID-checks the client id before printing it (non-GUIDs print the placeholder)');
}
r = launch(h1, ['help']);
check(r.ec === 0 && /USAGE/.test(r.out) && !/token |gmail|DELETE_ENABLED|client-secret/i.test(r.out), 'launcher help runs offline and has no token/Gmail/delete hints', r.out);
const stdio = (home, extra) => {
  const res = node([join(ROOT, 'tests', 'mcp-stdio-test.mjs'), launcher(home)], envFor(home, extra));
  try { return JSON.parse(res.stdout); } catch { return { started: false, raw: res.out }; }
};
let j = stdio(h1);
const refusedCalls = (x) => Object.values(x.calls || {}).filter((c) => /unavailable in the team build/.test(c)).length;
check(j.started && j.tools?.length === 16 && refusedCalls(j) === 6, 'MCP stdio (draft): 16 tools, 6 send/delete/rule calls refused', JSON.stringify(j));
j = stdio(h1, { EMAIL_AGENT_MCP_SCOPE_PROFILE: 'observe' });
check(j.started && j.tools?.length === 11, 'MCP stdio (observe): 11 tools', JSON.stringify(j));
r = launch(h1, ['configure', '--mailbox', 'user@example.com', '--provider', 'microsoft']);
check(r.ec !== 0 && r.out.includes('TEAM_CLIENT_ID_REQUIRED'), 'configure without a client id stops with TEAM_CLIENT_ID_REQUIRED', r.out);
r = launch(h1, ['configure', '--mailbox', 'x@example.net', '--provider', 'gmail']);
check(r.ec !== 0 && /microsoft only|gmail.*disabled|disabled in the team build/i.test(r.out), 'configure --provider gmail is refused', r.out);
r = launch(h1, ['help'], { EMAIL_AGENT_MCP_SCOPE_PROFILE: 'full' });
check(refused(r) && r.out.includes('must be draft or observe'), 'scope profile "full" is refused', r.out);
const emptyAllowlist = (home) => readFileSync(join(eam(home), 'send-allowlist.json'), 'utf8') === '{"entries": []}\n';
check(emptyAllowlist(h1), 'send-allowlist.json is still {"entries": []} after help, MCP stdio and configure attempts');
if (WIN) {
  r = launch(h1, ['help'], { APPDATA: undefined });
  check(refused(r) && r.out.includes('APPDATA'), 'Windows: launcher refuses without APPDATA', r.out);
}

// 2. Native modules load on this OS from the installed tree (no sign-in, no network).
const req = createRequire(join(D(h1), 'node_modules', 'x.js'));
try {
  const kt = req('keytar');
  check(typeof kt.getPassword === 'function' && typeof kt.setPassword === 'function', `keytar loads its ${process.platform}-${process.arch} prebuild`);
} catch (e) { check(false, `keytar loads its ${process.platform}-${process.arch} prebuild`, e.message); }
try {
  const ext = await import(pathToFileURL(req.resolve('@azure/msal-node-extensions')).href);
  check(typeof ext.PersistenceCreator === 'function' && typeof ext.FilePersistenceWithDataProtection === 'function', '@azure/msal-node-extensions imports');
  const icp = await import(pathToFileURL(req.resolve('@azure/identity-cache-persistence')).href);
  check(typeof icp.cachePersistencePlugin === 'object' || typeof icp.cachePersistencePlugin === 'function', '@azure/identity-cache-persistence imports');
  if (WIN) {
    // DPAPI round trip in a temp file (what the MSAL cache uses on Windows).
    const f = join(SCRATCH, 'dpapi-test', 'cache.bin');
    mkdirSync(dirname(f), { recursive: true });
    const p = await ext.FilePersistenceWithDataProtection.create(f, ext.DataProtectionScope.CurrentUser);
    await p.save('team-email-dpapi-check');
    const back = await p.load();
    check(back === 'team-email-dpapi-check' && !readFileSync(f).toString('latin1').includes('team-email-dpapi-check'), 'Windows: DPAPI-protected cache file round-trips and is not plain text');
  }
} catch (e) { check(false, 'msal-node-extensions / identity-cache-persistence import', e.stack); }
const pm = await import(pathToFileURL(join(D(h1), 'node_modules/@usejunior/provider-microsoft/dist/index.js')).href).catch((e) => e);
check(!(pm instanceof Error), 'provider-microsoft (auth + cache persistence) imports', pm instanceof Error ? pm.stack : '');

// 3. Launcher tamper and refusal cases (each on a fresh install).
const fresh = () => { const h = newHome(); const x = install(h); if (x.ec !== 0) throw new Error(x.out); return h; };
const someFile = (h) => join(D(h), 'node_modules', '@usejunior', 'provider-microsoft', 'dist', 'team-build-config.js');
let h = fresh(); appendFileSync(someFile(h), '\n');
check(refused(launch(h, ['help'])), 'tamper: one changed byte refuses');
h = fresh(); unlinkSync(someFile(h));
check(refused(launch(h, ['help'])), 'tamper: a removed file refuses');
h = fresh(); writeFileSync(join(D(h), 'node_modules', 'extra.js'), 'x');
check(refused(launch(h, ['help'])), 'tamper: an added file refuses');
h = fresh(); appendFileSync(join(eam(h), 'team-install.sha256'), '\n');
check(refused(launch(h, ['help'])), 'tamper: a changed manifest refuses');
h = fresh(); writeFileSync(join(eam(h), 'team-install.links'), './x -> y\n');
check(refused(launch(h, ['help'])), 'tamper: a changed symlink list refuses');
h = fresh();
let linked = true;
try { symlinkSync(someFile(h), join(D(h), 'node_modules', 'link.js'), 'file'); } catch { linked = false; }
if (linked) check(refused(launch(h, ['help'])), 'tamper: an added symlink refuses');
else console.log('SKIP: tamper with an added symlink (this OS user cannot create symlinks)');
h = fresh(); rmSync(join(eam(h), 'team-install.links'));
check(refused(launch(h, ['help'])), 'missing symlink list refuses');

// 4. Reinstall, non-team installs and --replace-existing.
h = fresh(); r = install(h);
check(r.ec === 0 && readdirSync(eam(h)).some((f) => f.startsWith('patched-install.bak-')) && r.out.includes('Previous install moved to'), 'reinstall over a team build moves the old one to patched-install.bak-*', r.out);
h = newHome(); mkdirSync(D(h), { recursive: true }); writeFileSync(join(D(h), 'personal.txt'), 'x');
r = install(h);
check(r.ec !== 0 && r.out.includes('is not a team build') && existsSync(join(D(h), 'personal.txt')), 'refuses to replace a non-team install', r.out);
r = install(h, ['--bogus', '--replace-existing']);
check(r.ec !== 0 && r.out.includes('unexpected argument') && existsSync(join(D(h), 'personal.txt')), '--replace-existing only counts as the first argument', r.out);
r = install(h, ['--replace-existing']);
check(r.ec === 0 && existsSync(join(D(h), 'TEAM-BUILD.json')) && readdirSync(eam(h)).some((f) => f.startsWith('patched-install.bak-')), '--replace-existing replaces it and keeps a backup', r.out);
h = newHome(); mkdirSync(eam(h), { recursive: true }); writeFileSync(join(eam(h), 'send-allowlist.json'), '{"entries": ["x@example.com"]}\n');
r = install(h);
check(r.ec === 0 && readFileSync(join(eam(h), 'send-allowlist.json'), 'utf8') === '{"entries": []}\n' && readdirSync(eam(h)).some((f) => f.startsWith('send-allowlist.json.bak-')), 'a non-empty send allowlist is backed up and emptied', r.out);
h = newHome(); mkdirSync(eam(h), { recursive: true }); writeFileSync(join(eam(h), 'send-allowlist.json'), '{"entries":["x"],"old":{"entries":[]}}\n');
r = install(h);
check(r.ec === 0 && readFileSync(join(eam(h), 'send-allowlist.json'), 'utf8') === '{"entries": []}\n' && readdirSync(eam(h)).some((f) => f.startsWith('send-allowlist.json.bak-')), 'an allowlist with a non-empty entries and a nested empty one is backed up and emptied', r.out);
h = newHome(); mkdirSync(eam(h), { recursive: true }); writeFileSync(join(eam(h), 'send-allowlist.json'), 'not json');
r = install(h);
check(r.ec === 0 && emptyAllowlist(h) && readdirSync(eam(h)).some((f) => f.startsWith('send-allowlist.json.bak-')), 'an unparseable allowlist is backed up and emptied', r.out);
h = newHome(); const custom = join(h, 'isolated-eam');
r = install(h, [], PKG, { EMAIL_AGENT_MCP_HOME: custom });
check(r.ec === 0 && existsSync(join(custom, 'patched-install', 'TEAM-BUILD.json')) && existsSync(join(custom, 'bin', 'team-email-agent-mcp-stdio.mjs')), 'EMAIL_AGENT_MCP_HOME moves the install and launcher', r.out);

if (!WIN) {
  h = newHome(); const sh = spawnSync('sh', [join(PKG, 'install.sh')], { env: envFor(h), encoding: 'utf8' });
  check(sh.status === 0 && existsSync(join(D(h), 'TEAM-BUILD.json')) && emptyAllowlist(h), 'install.sh shim runs node install.mjs', (sh.stdout || '') + (sh.stderr || ''));
}

// 5. Package tamper: install.mjs refuses before writing anything.
const pkgCopy = (mutate) => { const p = join(SCRATCH, `pkg${++n}`); cpSync(PKG, p, { recursive: true }); mutate(p); return p; };
for (const [label, mutate] of [
  ['a changed byte in install.tar', (p) => { const b = readFileSync(join(p, 'install.tar')); b[b.length - 2000] ^= 1; writeFileSync(join(p, 'install.tar'), b); }],
  ['a changed launcher', (p) => appendFileSync(join(p, 'team-email-agent-mcp-stdio.mjs'), '\n')],
  ['a missing manifest', (p) => rmSync(join(p, 'team-install.sha256'))],
  ['an edited package-files.sha256', (p) => appendFileSync(join(p, 'package-files.sha256'), 'garbage\n')],
]) {
  h = newHome(); r = install(h, [], pkgCopy(mutate));
  check(r.ec !== 0 && !existsSync(D(h)), `package tamper refused: ${label}`, r.out);
}

console.log(`install-test.mjs: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
