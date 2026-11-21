// Offline argument, default and behavior checks for tools/verify-install.mjs
// (Windows, macOS, Linux). No Graph, no live verify, no live install.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JS = join(ROOT, 'tools', 'verify-install.mjs');
const STUB_DIR = join(ROOT, 'tests', 'verify-install-stub');
const STUB_LAUNCHER = join(STUB_DIR, 'launcher.mjs');
const SCRATCH = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'verify-install-'));
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));
let passes = 0, fails = 0;
const pass = (m) => { console.log(`PASS: ${m}`); passes++; };
const fail = (m, extra = '') => { console.error(`FAIL: ${m}`); if (extra) console.error(extra); fails++; };
const check = (ok, m, extra) => (ok ? pass(m) : fail(m, extra));

// Run a script with a clean env: drop the hooks the cases set themselves.
function run(script, args, env = {}, cwd = SCRATCH) {
  const base = { ...process.env };
  for (const k of ['VERIFY_INSTALL_PRINT_ARGS', 'EMAIL_AGENT_MCP_HOME', 'TEAM_EMAIL_LAUNCHER', 'STUB_SHARED_WRITE_ERROR']) delete base[k];
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env: { ...base, ...env }, encoding: 'utf8', timeout: 120000 });
  return { ec: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}
const home = join(SCRATCH, 'home');
const H = { HOME: home, USERPROFILE: home };
const lines = (s) => s.split(/\r?\n/);
const has = (s, l) => lines(s).includes(l);

// Missing required user mailbox → exit 2 with a message.
let r = run(JS, [], H);
check(r.ec === 2 && r.out.includes('user mailbox address is required'), 'no arguments exits 2', r.out);
r = run(JS, ['--launcher', join(SCRATCH, 'L')], H);
check(r.ec === 2 && r.out.includes('user mailbox address is required'), 'flags without a user mailbox exit 2', r.out);

// HOME / EMAIL_AGENT_MCP_HOME defaults and flag overrides (print hook; no live paths used).
const P = { ...H, VERIFY_INSTALL_PRINT_ARGS: '1' };
r = run(JS, ['user@example.com'], P);
const eamDefault = join(home, '.email-agent-mcp');
check(has(r.stdout, `launcher=${join(eamDefault, 'bin', 'team-email-agent-mcp-stdio.mjs')}`) && has(r.stdout, `install=${join(eamDefault, 'patched-install')}`)
  && has(r.stdout, 'mailbox=user@example.com') && has(r.stdout, 'shared='), 'defaults launcher and install from HOME, with no shared mailbox', r.out);
const eam = join(SCRATCH, 'eam-home');
r = run(JS, ['user@example.com'], { ...P, EMAIL_AGENT_MCP_HOME: eam });
check(has(r.stdout, `install=${join(eam, 'patched-install')}`) && has(r.stdout, `launcher=${join(eam, 'bin', 'team-email-agent-mcp-stdio.mjs')}`), 'honors EMAIL_AGENT_MCP_HOME for the defaults', r.out);
r = run(JS, ['--launcher', join(SCRATCH, 'L'), '--install', join(SCRATCH, 'I'), 'user@example.com', 'helpdesk=helpdesk@example.com'], P);
check(has(r.stdout, `launcher=${join(SCRATCH, 'L')}`) && has(r.stdout, `install=${join(SCRATCH, 'I')}`) && has(r.stdout, 'shared=helpdesk=helpdesk@example.com'), 'honors --launcher, --install, and shared name=address', r.out);
r = run(JS, ['user@example.com', 'helpdesk@example.com'], P);
check(has(r.stdout, 'shared=helpdesk@example.com'), 'accepts a bare shared email argument', r.out);

// Invalid shared arg (needs a launcher and install that exist).
const dummyLauncher = join(SCRATCH, 'dummy-launcher.mjs'); writeFileSync(dummyLauncher, '');
const dummyInstall = join(SCRATCH, 'dummy-install'); mkdirSync(dummyInstall, { recursive: true });
r = run(JS, ['--launcher', dummyLauncher, '--install', dummyInstall, 'user@example.com', 'not-a-mailbox'], H);
check(r.ec === 2 && r.out.includes('invalid shared mailbox argument'), 'rejects an invalid shared mailbox argument (exit 2)', r.out);

// Missing launcher / install on a real run → exit 2, no Graph.
r = run(JS, ['--stdout', '--launcher', join(SCRATCH, 'no-launcher'), '--install', join(SCRATCH, 'no-install'), 'user@example.com'], H);
check(r.ec === 2 && r.out.includes('launcher missing'), 'fails closed when the launcher is missing', r.out);
r = run(JS, ['--stdout', '--launcher', dummyLauncher, '--install', join(SCRATCH, 'no-install'), 'user@example.com'], H);
check(r.ec === 2 && r.out.includes('install dir missing'), 'fails closed when the install dir is missing', r.out);

// Default is stdout only: no file in cwd. --out FILE writes only that file.
const cwd = join(SCRATCH, 'out-cwd'); mkdirSync(cwd, { recursive: true });
run(JS, ['--launcher', dummyLauncher, '--install', dummyInstall, 'user@example.com'], H, cwd);
check(readdirSync(cwd).length === 0, 'default run writes no file in cwd (stdout only)', readdirSync(cwd).join(' '));
const outFile = join(SCRATCH, 'explicit-verify.out');
run(JS, ['--launcher', dummyLauncher, '--install', dummyInstall, '--out', outFile, 'user@example.com'], H, cwd);
check(existsSync(outFile), '--out FILE writes the explicit file');
check(readdirSync(cwd).length === 0, '--out does not also write a file in cwd', readdirSync(cwd).join(' '));
for (const [args, msg, label] of [
  [['--out', '', 'user@example.com'], '--out requires a non-empty path', 'empty --out exits 2 with a message'],
  [['--out', '--stdout', 'user@example.com'], '--out requires a non-empty path', '--out rejects a value that starts with -'],
  [['--launcher'], '--launcher requires a non-empty path', '--launcher with no value exits 2'],
  [['--install'], '--install requires a non-empty path', '--install with no value exits 2'],
  [['--launcher', '--install', dummyInstall, 'user@example.com'], '--launcher requires a non-empty path', '--launcher rejects a value that starts with -'],
  [['--bogus', 'user@example.com'], 'unknown option: --bogus', 'unknown option exits 2'],
]) {
  r = run(JS, args, H, cwd);
  check(r.ec === 2 && r.out.includes(msg) && !existsSync(join(cwd, '--stdout')), label, r.out);
}

// Behavior test: verify-install.mjs against the offline stub MCP server, which
// records every tools/call. Require exact allowlist equality and the right
// PASS/FAIL verdicts for the five shared write probes.
const STUB_INSTALL = join(SCRATCH, 'stub-install'); mkdirSync(STUB_INSTALL, { recursive: true });
const PROBES = ['mark_read', 'move_to_folder', 'flag_email', 'create_draft', 'send_email'];
const verdicts = (stdout, expect) => PROBES.every((t) => new RegExp(`^${expect}: ${t} on shared refused`, 'm').test(stdout));
function runStub(mjs, prefix, writeErr) {
  const log = `${prefix}.calls`; writeFileSync(log, '');
  // Token import is expected to fail on the empty install; verdicts and the call log are what we judge.
  const res = run(mjs, ['--launcher', STUB_LAUNCHER, '--install', STUB_INSTALL, 'user@example.com', 'shared=shared@example.com'],
    { ...H, STUB_LOG: log, ...(writeErr ? { STUB_SHARED_WRITE_ERROR: writeErr } : {}) });
  const chk = spawnSync(process.execPath, [join(STUB_DIR, 'check-calls.mjs'), log, 'user@example.com', 'shared', 'false'], { encoding: 'utf8' });
  return { ...res, allow: chk.status === 0, chkOut: (chk.stdout || '') + (chk.stderr || ''), calls: readFileSync(log, 'utf8') };
}
const behaviorOk = (mjs, prefix) => {
  const a = runStub(mjs, prefix, '');
  if (!a.allow || !verdicts(a.stdout, 'PASS')) return false;
  const b = runStub(mjs, `${prefix}.denied`, 'ErrorAccessDenied');
  return b.allow && verdicts(b.stdout, 'FAIL') && b.ec !== 0;
};
let a = runStub(JS, join(SCRATCH, 'head'), '');
check(a.allow && verdicts(a.stdout, 'PASS'), 'shared write probes match the exact allowlist and PASS under SHARED_MAILBOX_READ_ONLY', `${a.calls}\n${a.chkOut}\n${a.out}`);
a = runStub(JS, join(SCRATCH, 'head.denied'), 'ErrorAccessDenied');
check(a.allow && verdicts(a.stdout, 'FAIL') && a.ec !== 0, 'shared write probes FAIL and verify-install exits non-zero under ErrorAccessDenied', `${a.calls}\n${a.chkOut}\n${a.out}`);

// Prove the behavior test kills payload and refusal-check mutants (each on a temp copy).
const src = readFileSync(JS, 'utf8');
const MR = "['mark_read', { mailbox: box, id: fakeId, is_read: state }]";
const FL = "['flag_email', { mailbox: box, id: fakeId, flagged: true }]";
const CD = "['create_draft', { mailbox: box, to: 'guard-test@example.invalid'";
const SE = "['send_email', { mailbox: box, to: 'guard-test@example.invalid'";
const REC = 'rec(r.isError && /SHARED_MAILBOX_READ_ONLY/.test(r.text)';
const MUTANTS = {
  M1_flip_via_state: ['is_read: state }', 'is_read: !state }'],
  M3_flag_real_id: [FL, "['flag_email', { mailbox: box, id: m0.id, flagged: true }]"],
  M4_send_to_real_shared_addr: [SE, "['send_email', { mailbox: box, to: s.address"],
  M5_send_to_ME_bare_array: [SE, "['send_email', { mailbox: box, to: [ ME ]"],
  M6_assert_any_error: [REC, 'rec(r.isError'],
  N4_update_draft_real_id: [MR, MR + ",\n    ['update_draft', { mailbox: box, draft_id: m0.id, to: 'guard-test@example.invalid' }]"],
  N5_cc_real_addr: [CD, "['create_draft', { mailbox: box, cc: [ME], to: 'guard-test@example.invalid'"],
};
for (const [name, [from, to]] of Object.entries(MUTANTS)) {
  if (!src.includes(from)) { fail(`mutant ${name}: source pattern not found`); continue; }
  const mut = join(SCRATCH, `${name}.mjs`);
  writeFileSync(mut, src.replace(from, to));
  const caught = !behaviorOk(mut, join(SCRATCH, name));
  rmSync(mut);
  check(caught, `mutant ${name} was caught by the behavior test`);
}

// No machine-specific paths and no hardcoded real mailboxes in the tool.
check(!/\/(?:home|Users)\/[a-z0-9_-]+\/|[a-z0-9._-]+@(?!example\.(com|net|org|invalid)\b)[a-z0-9-]+\.[a-z]{2,}/i.test(src), 'verify-install.mjs has no home-directory paths and no real mailbox addresses');

console.log(`verify-install-test.mjs: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
