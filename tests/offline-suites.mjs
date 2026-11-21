// Run the offline suites (offline-test, legacy guard, serve-no-clientid) against a
// fresh install of the unpacked package, on any OS. The install and the scratch
// HOME live under <repo>/scratch-prune/homes/<label> (offline-test requires that).
// Every node child runs with tools/no-network.mjs.
// Usage: node tests/offline-suites.mjs <unpackedPackageDir> [label]
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = process.argv[2] && resolve(process.argv[2]);
const LABEL = process.argv[3] || 'offline-suites';
if (!PKG || !existsSync(join(PKG, 'install.mjs')) || !/^[A-Za-z0-9._-]+$/.test(LABEL)) { console.error('usage: offline-suites.mjs <unpackedPackageDir> [label]'); process.exit(2); }
const H = join(ROOT, 'scratch-prune', 'homes', LABEL);
rmSync(H, { recursive: true, force: true });
mkdirSync(join(H, 'AppData', 'Roaming'), { recursive: true }); mkdirSync(join(H, 'AppData', 'Local'), { recursive: true });
const EAM = join(H, '.email-agent-mcp');
const env = { ...process.env, HOME: H, USERPROFILE: H, EMAIL_AGENT_MCP_HOME: EAM, TEAM_EMAIL_MCP_ROOT: ROOT,
  NODE_OPTIONS: `--import=${pathToFileURL(join(ROOT, 'tools', 'no-network.mjs')).href}` };
if (process.platform === 'win32') { env.APPDATA = join(H, 'AppData', 'Roaming'); env.LOCALAPPDATA = join(H, 'AppData', 'Local'); }
delete env.EMAIL_AGENT_MCP_SCOPE_PROFILE;
// Child output goes to files, not pipes: a child that calls process.exit() right
// after a large console.log can lose buffered pipe output (seen on macOS).
let k = 0;
const run = (args) => {
  const o = join(H, `out-${++k}.txt`), e = join(H, `err-${k}.txt`);
  const fo = openSync(o, 'w'), fe = openSync(e, 'w');
  const r = spawnSync(process.execPath, args, { env, stdio: ['ignore', fo, fe], timeout: 300000 });
  closeSync(fo); closeSync(fe);
  return { status: r.status, stdout: readFileSync(o, 'utf8'), stderr: readFileSync(e, 'utf8') };
};
let fails = 0;
const inst = run([join(PKG, 'install.mjs')]);
if (inst.status !== 0) { console.error(inst.stdout + inst.stderr); process.exit(1); }
const D = join(EAM, 'patched-install');
for (const [label, args, ok] of [
  ['offline-test.mjs', [join(ROOT, 'tests', 'offline-test.mjs'), D], (o) => / 0 failed/.test(o)],
  ['legacy guard', [join(ROOT, 'tests', 'legacy-guard-unit-test.mjs'), D], () => true],
  ['serve-no-clientid', [join(ROOT, 'tests', 'serve-no-clientid.mjs'), D], (o) => o.includes('not_configured')],
]) {
  const r = run(args);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0 && ok(out)) console.log(`PASS: ${label} — ${(r.stdout || '').trim().split(/\r?\n/).pop().slice(0, 160)}`);
  else { fails++; console.error(`FAIL: ${label} (exit ${r.status})\n${(r.stdout || '').split(/\r?\n/).filter((l) => /FAIL|SUMMARY/.test(l)).join('\n')}\n${(r.stderr || '').slice(-3000)}`); }
}
try { rmSync(H, { recursive: true, force: true }); } catch { /* Windows may keep files locked */ }
console.log(`offline-suites.mjs: ${3 - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
