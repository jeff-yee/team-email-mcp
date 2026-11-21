// Offline: the tenant id, team client id and denied client id prefixes come only
// from the build config. A missing or invalid config refuses (TEAM_BUILD_CONFIG_MISSING)
// at three points: tools/apply-team-config.mjs, build.sh, and sign-in in an unfilled
// tree. An empty or missing deniedClientIdPrefixes list refuses the same way
// (TEAM_BUILD_CONFIG_NO_DENIED_CLIENTS) unless the config sets "allowNoDeniedClients": true.
// Usage: node tests/team-config-test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'patches', 'team-build-config.js');
const FIX = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'team-build.config.test.json'), 'utf8'));
const T = mkdtempSync(join(tmpdir(), 'team-config-test-'));
let passes = 0, fails = 0, n = 0;
const check = (ok, label, detail = '') => { if (ok) { passes++; console.log(`PASS: ${label}`); } else { fails++; console.error(`FAIL: ${label}\n${detail}`); } };
const fresh = () => { const f = join(T, `cfg-${++n}.mjs`); copyFileSync(SRC, f); return f; };
const load = (f) => import(pathToFileURL(f).href);
const apply = (target, config, root = ROOT) => {
  const env = { ...process.env, TEAM_EMAIL_MCP_ROOT: root };
  if (config === undefined) delete env.TEAM_BUILD_CONFIG; else env.TEAM_BUILD_CONFIG = config;
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'apply-team-config.mjs'), target], { env, encoding: 'utf8' });
  return { ec: r.status, err: r.stderr };
};
const writeCfg = (name, obj) => { const f = join(T, name); writeFileSync(f, JSON.stringify(obj)); return f; };
const OTHER = '11111111-2222-4333-8444-555555555555';

// 1. An unfilled tree refuses sign-in: no fallback tenant or app.
{
  const m = await load(fresh());
  let code = '';
  try { m.assertTeamClientId(OTHER, 'configure'); } catch (e) { code = e.code; }
  check(code === 'TEAM_BUILD_CONFIG_MISSING', 'unfilled config: assertTeamClientId refuses with TEAM_BUILD_CONFIG_MISSING', code);
  check(!/^[0-9a-f-]{36}$/.test(m.TEAM_TENANT_ID) && !/^[0-9a-f-]{36}$/.test(m.TEAM_CLIENT_ID), 'unfilled config carries no tenant or client id');
}
// 2. apply-team-config refuses missing and invalid configs, leaving the file unfilled.
const MISSING = 'TEAM_BUILD_CONFIG_MISSING', NONE = 'TEAM_BUILD_CONFIG_NO_DENIED_CLIENTS';
const { deniedClientIdPrefixes: _d, ...NO_DENIED_KEY } = FIX;
const refusals = {
  'no config at the default path': [undefined, T, MISSING],
  'TEAM_BUILD_CONFIG points at a missing file': [join(T, 'nope.json'), ROOT, MISSING],
  'the committed example (placeholders)': [join(ROOT, 'team-build.config.example.json'), ROOT, MISSING],
  'not JSON': [(() => { const f = join(T, 'bad.json'); writeFileSync(f, '{'); return f; })(), ROOT, MISSING],
  'tenantId not a GUID': [writeCfg('t.json', { ...FIX, tenantId: 'organizations' }), ROOT, MISSING],
  'clientId missing': [writeCfg('c.json', { tenantId: FIX.tenantId, deniedClientIdPrefixes: FIX.deniedClientIdPrefixes }), ROOT, MISSING],
  'clientId is the vendor app': [writeCfg('v.json', { ...FIX, clientId: 'c4f91d3e-d2d9-4f8b-826f-6a3c19280241' }), ROOT, MISSING],
  'clientId under a denied prefix': [writeCfg('d.json', { ...FIX, clientId: FIX.deniedClientIdPrefixes[0] + '0000-4000-8000-000000000000' }), ROOT, MISSING],
  'bad denied prefix': [writeCfg('p.json', { ...FIX, deniedClientIdPrefixes: ['abc'] }), ROOT, MISSING],
  'deniedClientIdPrefixes missing': [writeCfg('n1.json', NO_DENIED_KEY), ROOT, NONE],
  'deniedClientIdPrefixes null': [writeCfg('n2.json', { ...FIX, deniedClientIdPrefixes: null }), ROOT, NONE],
  'deniedClientIdPrefixes empty': [writeCfg('n3.json', { ...FIX, deniedClientIdPrefixes: [] }), ROOT, NONE],
  'deniedClientIdPrefixes empty, allowNoDeniedClients false': [writeCfg('n4.json', { ...FIX, deniedClientIdPrefixes: [], allowNoDeniedClients: false }), ROOT, NONE],
  'allowNoDeniedClients not a boolean': [writeCfg('n5.json', { ...FIX, deniedClientIdPrefixes: [], allowNoDeniedClients: 'yes' }), ROOT, MISSING],
};
for (const [label, [config, root, code]] of Object.entries(refusals)) {
  const f = fresh(), before = readFileSync(f, 'utf8');
  const r = apply(f, config, root);
  check(r.ec === 2 && r.err.includes(`${code}:`) && readFileSync(f, 'utf8') === before, `apply refuses (${code}): ${label}`, `${r.ec} ${r.err}`);
}
// 2b. The explicit opt-out is honoured, and recorded in the filled file.
{
  const f = fresh();
  const r = apply(f, writeCfg('optout.json', { ...FIX, deniedClientIdPrefixes: [], allowNoDeniedClients: true }));
  const m = await load(f);
  let threw = '';
  try { m.assertTeamBuildConfig(); } catch (e) { threw = e.code; }
  check(r.ec === 0 && m.TEAM_FORBIDDEN_CLIENT_ID_PREFIXES.length === 0 && m.TEAM_ALLOW_NO_DENIED_CLIENTS === true && !threw,
    '"allowNoDeniedClients": true allows an empty denied list', `${r.ec} ${r.err} ${threw}`);
}
// 2c. A tree whose denied list was emptied by hand (no opt-out) refuses at sign-in.
{
  const f = fresh();
  writeFileSync(f, readFileSync(f, 'utf8').replace("'@@TEAM_TENANT_ID@@'", `'${FIX.tenantId}'`).replace("'@@TEAM_CLIENT_ID@@'", `'${FIX.clientId}'`)
    .replace("'@@TEAM_ALLOW_NO_DENIED_CLIENTS@@'", 'false'));
  const m = await load(f);
  let code = '';
  try { m.assertTeamClientId(OTHER, 'configure'); } catch (e) { code = e.code; }
  check(code === NONE, 'filled tree with no denied prefixes and no opt-out refuses sign-in', code);
}
// 3. A provided config is used as is.
{
  const f = fresh();
  const r = apply(f, join(ROOT, 'tests', 'fixtures', 'team-build.config.test.json'));
  const m = await load(f);
  check(r.ec === 0 && m.TEAM_TENANT_ID === FIX.tenantId && m.TEAM_CLIENT_ID === FIX.clientId
    && JSON.stringify(m.TEAM_FORBIDDEN_CLIENT_ID_PREFIXES) === JSON.stringify(FIX.deniedClientIdPrefixes) && m.TEAM_ALLOW_NO_DENIED_CLIENTS === false,
    'provided tenant, client id and denied prefixes are used (no opt-out)', r.err);
  let ok = false, denied = '';
  try { ok = m.assertTeamClientId(OTHER, 'configure') === OTHER; } catch { /* ok stays false */ }
  try { m.assertTeamClientId(FIX.deniedClientIdPrefixes[0] + '0000-4000-8000-000000000000'); } catch (e) { denied = e.code; }
  check(ok && denied === 'TEAM_CLIENT_ID_REQUIRED', 'filled config accepts a team GUID and refuses a denied prefix');
  let msg = '';
  try { m.assertTeamClientId(''); } catch (e) { msg = e.message; }
  check(msg.includes(`--client-id ${FIX.clientId}`), 'the setup hint names the configured client id', msg);
  const again = apply(f, join(ROOT, 'tests', 'fixtures', 'team-build.config.test.json'));
  check(again.ec === 2, 'apply refuses a file that is already filled', again.err);
}
// 4. build.sh refuses a patched tree whose config was never filled (or lost its
// denied prefixes), before writing anything. The tree path has a quote in it:
// build.sh passes it to node as an argument, so it cannot break the JS.
if (process.platform !== 'win32') {
  const buildRefuses = (label, js, code) => {
    const root = join(T, `root-${++n}`), tree = join(T, `tr'ee "${n}"`), dist = join(tree, 'node_modules', '@usejunior', 'provider-microsoft', 'dist');
    mkdirSync(root); mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'team-build-config.js'), js);
    writeFileSync(join(dist, '..', 'package.json'), '{"type": "module"}\n');
    const r = spawnSync('bash', [join(ROOT, 'build.sh'), '20000101'], { env: { ...process.env, TEAM_EMAIL_MCP_ROOT: root, BUILD_DIR: tree }, encoding: 'utf8' });
    check(r.status === 2 && r.stderr.includes(`${code}:`) && !existsSync(join(root, 'staging')) && !existsSync(join(root, 'dist')),
      `build.sh refuses ${label} and writes nothing`, `${r.status} ${r.stderr}`);
  };
  const src = readFileSync(SRC, 'utf8');
  buildRefuses('an unfilled tree (path with quotes)', src, MISSING);
  buildRefuses('a tree with no denied prefixes and no opt-out', src.replace("'@@TEAM_TENANT_ID@@'", `'${FIX.tenantId}'`)
    .replace("'@@TEAM_CLIENT_ID@@'", `'${FIX.clientId}'`).replace("'@@TEAM_ALLOW_NO_DENIED_CLIENTS@@'", 'false'), NONE);
}
rmSync(T, { recursive: true, force: true });
console.log(`team-config-test.mjs: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
