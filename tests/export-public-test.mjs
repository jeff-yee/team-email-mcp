// Offline: tools/export-public.sh exports exactly tools/public-manifest.txt (with
// public-overlay/ applied) and fails, writing nothing, on any difference.
// Builds a throwaway git repo from the manifest's files (plus public-overlay/ when
// present), then commits one bad change per case on its own branch.
// Usage: node tests/export-public-test.mjs   (needs git and python3; Linux or macOS)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAN = 'tools/public-manifest.txt';
const T = mkdtempSync(join(tmpdir(), 'export-public-test-'));
const R = join(T, 'repo');
let passes = 0, fails = 0, outN = 0;
const check = (ok, label, detail = '') => { if (ok) { passes++; console.log(`PASS: ${label}`); } else { fails++; console.error(`FAIL: ${label}\n${detail}`); } };
const git = (...a) => {
  const r = spawnSync('git', ['-c', 'user.name=export test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: R, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const listed = readFileSync(join(ROOT, MAN), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const walk = (d, pre = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]);
const rootOverlay = existsSync(join(ROOT, 'public-overlay')) ? walk(join(ROOT, 'public-overlay')).map((p) => `public-overlay/${p}`) : [];
const REQ = 'internal/public-overlay-paths.txt';
// Internal-only files that keep their original paths: the real list when this is
// the internal tree, otherwise a synthetic one so the mechanism is still tested.
const ONLY = 'internal/internal-only-paths.txt';
const realOnly = existsSync(join(ROOT, ONLY));
const onlyPaths = realOnly
  ? readFileSync(join(ROOT, ONLY), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : ['docs/INTERNAL-NOTES.md', 'pilot/pilot-env.sh'];
const realReq = existsSync(join(ROOT, REQ));
for (const p of [...listed, ...rootOverlay, ...(realOnly ? [ONLY, ...onlyPaths] : []), ...(realReq ? [REQ] : [])]) { mkdirSync(dirname(join(R, p)), { recursive: true }); copyFileSync(join(ROOT, p), join(R, p)); }
if (!realOnly) {
  for (const p of onlyPaths) { mkdirSync(dirname(join(R, p)), { recursive: true }); writeFileSync(join(R, p), 'internal only\n'); }
  mkdirSync(join(R, 'internal'), { recursive: true }); writeFileSync(join(R, ONLY), `# synthetic\n${onlyPaths.join('\n')}\n`);
}
if (!realReq) { // public copy: a synthetic required overlay so the overlay checks still run
  mkdirSync(join(R, 'public-overlay'), { recursive: true }); writeFileSync(join(R, 'public-overlay', 'README.md'), 'public readme\n');
  writeFileSync(join(R, REQ), '# synthetic\nREADME.md\n');
}
const overlay = walk(join(R, 'public-overlay')).map((p) => `public-overlay/${p}`);
const required = readFileSync(join(R, REQ), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
git('init', '-q', '-b', 'base'); git('add', '-A', '-f'); git('commit', '-q', '-m', 'base');
const exp = (commit = 'HEAD', out = join(T, `out-${++outN}`), flags = [], repo = R) => {
  const r = spawnSync('bash', [join(repo, 'tools', 'export-public.sh'), ...flags, commit, out], { cwd: repo, encoding: 'utf8' });
  return { ec: r.status, err: r.stderr, out, files: existsSync(out) ? walk(out).sort() : [] };
};
const setManifest = (fn) => { const lines = readFileSync(join(R, MAN), 'utf8').split('\n'); writeFileSync(join(R, MAN), fn(lines).join('\n')); };
const addListed = (p) => setManifest((lines) => {
  const head = lines.filter((l) => !l.trim() || l.startsWith('#')), body = lines.filter((l) => l.trim() && !l.startsWith('#'));
  return [...head.filter(Boolean), ...[...body, p].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1)), ''];
});
const write = (p, s = 'x\n') => { mkdirSync(dirname(join(R, p)), { recursive: true }); writeFileSync(join(R, p), s); };
const kase = (label, mutate, want, flags = []) => {
  git('checkout', '-q', '-f', 'base'); git('clean', '-qfdx'); git('checkout', '-q', '-B', 'case');
  mutate(); git('add', '-A', '-f'); git('commit', '-q', '--allow-empty', '-m', 'case');
  const r = exp('HEAD', undefined, flags);
  check(r.ec === 1 && r.err.includes(want) && r.files.length === 0, `refuses: ${label}`, `${r.ec} ${r.err}`);
};

// 1. A clean export is exactly the manifest, with the overlay applied and nothing internal.
let firstOut = '';
{
  write('internal/notes.txt', 'internal only\n'); git('add', '-A'); git('commit', '-q', '-m', 'internal file');
  write('docs/untracked-notes.md', 'never committed\n');
  const r = exp();
  firstOut = r.out;
  check(r.ec === 0 && JSON.stringify(r.files) === JSON.stringify([...listed].sort()), `clean export writes exactly the ${listed.length} manifest files`, `${r.ec} ${r.err}`);
  check(!r.files.some((f) => /^(internal|public-overlay)\//.test(f)) && !r.files.includes('docs/untracked-notes.md'), 'internal/, public-overlay/ and untracked files are not exported');
  const swapped = overlay.map((p) => p.slice('public-overlay/'.length));
  check(swapped.every((p) => readFileSync(join(r.out, p), 'utf8') === readFileSync(join(R, 'public-overlay', p), 'utf8')), `public-overlay/ replaces ${swapped.length} files in the export`);
  check(statSync(join(r.out, 'tools', 'export-public.sh')).isFile(), 'the export is plain files');
  check(onlyPaths.every((p) => !existsSync(join(r.out, p))) && !r.files.some((f) => /^pilot\//i.test(f)),
    `the ${onlyPaths.length} internal-only files (${realOnly ? 'internal/internal-only-paths.txt' : 'synthetic list'}) are not exported`);
  const ci = readFileSync(join(r.out, '.github', 'workflows', 'ci.yml'), 'utf8');
  const PUB_EXPORT = 'run: bash tools/export-public.sh --public-tree HEAD "$RUNNER_TEMP/public-export"';
  const INT_EXPORT = 'run: bash tools/export-public.sh HEAD "$RUNNER_TEMP/public-export"';
  check(!/internal\/|hashFiles/.test(ci), 'the exported ci.yml has no internal-only step and no hashFiles skip');
  check(ci.includes(PUB_EXPORT) && !ci.includes(INT_EXPORT), 'the exported ci.yml exports its own commit with --public-tree');
  if (existsSync(join(ROOT, 'public-overlay', '.github', 'workflows', 'ci.yml'))) {
    const internalCi = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const steps = /^ {6}- name: Internal-only check[^\n]*\n {8}run: node internal\/tests\/[a-z-]+-test\.mjs\n/gm;
    const internalOnly = (internalCi.match(steps) || []).join('');
    check(internalOnly.includes('run: node internal/tests/denied-prefix-test.mjs\n') && internalOnly.includes('run: node internal/tests/rescan-org-name-test.mjs\n')
      && internalCi.includes(INT_EXPORT) && !internalCi.includes('--public-tree')
      && internalCi.replace(steps, '').replace(INT_EXPORT, PUB_EXPORT) === ci,
      'the internal ci.yml runs denied-prefix-test and rescan-org-name-test and exports without --public-tree; otherwise it matches the public ci.yml line for line');
  }
  rmSync(join(R, 'docs', 'untracked-notes.md'));
}
// 2. Any path that differs from the manifest fails.
const NOT_LISTED = 'not in tools/public-manifest.txt';
kase('a new tracked file in an exported directory (docs/NEW-RUNBOOK.md)', () => write('docs/NEW-RUNBOOK.md'), NOT_LISTED);
kase('a new test fixture (tests/leak-config.json)', () => write('tests/leak-config.json', '{}\n'), NOT_LISTED);
kase('a case variant of a denied dir (tools/Pilot/x.sh)', () => write('tools/Pilot/x.sh'), NOT_LISTED);
kase('an upper-case top-level dir (PILOT/x)', () => write('PILOT/x'), NOT_LISTED);
kase('a nested home/ dir (tests/home/fake.json)', () => write('tests/home/fake.json', '{}\n'), NOT_LISTED);
kase('a nested .IdentityService dir', () => write('docs/.IdentityService/cache.json', '{}\n'), NOT_LISTED);
kase('a new top-level file (NOTES.md)', () => write('NOTES.md'), NOT_LISTED);
kase('a listed file that is missing (LICENSE)', () => unlinkSync(join(R, 'LICENSE')), 'listed in tools/public-manifest.txt but not in');
kase('a symlink', () => symlinkSync('../LICENSE', join(R, 'docs', 'LICENSE-link')), 'has symlinks');
kase('tools/Pilot/x.sh even when listed', () => { write('tools/Pilot/x.sh'); addListed('tools/Pilot/x.sh'); }, 'manifest lists denied paths');
kase('tests/home/fake.json even when listed', () => { write('tests/home/fake.json'); addListed('tests/home/fake.json'); }, 'manifest lists denied paths');
kase('docs/.IdentityService/x even when listed', () => { write('docs/.IdentityService/x'); addListed('docs/.IdentityService/x'); }, 'manifest lists denied paths');
kase('a nested build config even when listed', () => { write('docs/team-build.config.json', '{}\n'); addListed('docs/team-build.config.json'); }, 'manifest lists denied paths');
kase('saved test output even when listed', () => { write('tests/run.out'); addListed('tests/run.out'); }, 'manifest lists denied paths');
if (process.platform === 'linux') kase('two listed paths that differ only in case', () => { write('docs/readme.md'); write('docs/README.md'); addListed('docs/README.md'); addListed('docs/readme.md'); }, 'differ only in letter case');
// Internal-only files: refused when listed, and exported nowhere else.
const LISTS_ONLY = 'manifest lists internal-only paths';
for (const p of onlyPaths)
  kase(`internal-only ${p} added to the manifest`, () => addListed(p), LISTS_ONLY);
kase('an internal-only file dropped from internal-only-paths.txt', () => writeFileSync(join(R, ONLY), readFileSync(join(R, ONLY), 'utf8').split('\n').filter((l) => l.trim() !== onlyPaths[0]).join('\n')), NOT_LISTED);
kase('a stale internal-only entry', () => writeFileSync(join(R, ONLY), readFileSync(join(R, ONLY), 'utf8') + 'docs/GONE.md\n'), 'lists files that');
kase('an overlay copy of an internal-only file', () => write(`public-overlay/${onlyPaths[0]}`), 'replace no tracked, listed file');
// Required overlay files: a missing one must never let the internal version out.
const MISSING_OVERLAY = 'required public-overlay files are missing';
for (const p of required) kase(`required overlay public-overlay/${p} deleted`, () => unlinkSync(join(R, 'public-overlay', p)), MISSING_OVERLAY);
kase('the whole public-overlay/ deleted', () => rmSync(join(R, 'public-overlay'), { recursive: true }), MISSING_OVERLAY);
kase('an overlay file not in the required list (public-overlay/NOTICE)', () => write('public-overlay/NOTICE', 'other notice\n'), `public-overlay files not listed in ${REQ}`);
kase('the required-overlay list deleted', () => unlinkSync(join(R, REQ)), `has no ${REQ}`);
kase('the internal-only list deleted', () => unlinkSync(join(R, ONLY)), `has no ${ONLY}`);
kase('both internal lists deleted', () => { unlinkSync(join(R, REQ)); unlinkSync(join(R, ONLY)); }, `has no ${ONLY} or ${REQ}`);
kase('a commit stripped of internal/, public-overlay/ and every internal-only file', () => {
  rmSync(join(R, 'internal'), { recursive: true }); rmSync(join(R, 'public-overlay'), { recursive: true });
  for (const p of onlyPaths) unlinkSync(join(R, p));
}, `has no ${ONLY} or ${REQ}`);
kase('--public-tree on the internal tree', () => {}, '--public-tree, but', ['--public-tree']);
kase('the required-overlay list emptied', () => writeFileSync(join(R, REQ), '# nothing\n'), `${REQ} is empty`);
kase('the required-overlay list names an unlisted path', () => { write('public-overlay/docs/EXTRA2.md'); writeFileSync(join(R, REQ), readFileSync(join(R, REQ), 'utf8') + 'docs/EXTRA2.md\n'); }, 'replace no tracked, listed file');
kase('the required-overlay list names a path the manifest lacks', () => writeFileSync(join(R, REQ), readFileSync(join(R, REQ), 'utf8') + 'docs/NOT-LISTED.md\n'), `lists paths that ${MAN} does not`);
kase('an overlay file that replaces nothing', () => write('public-overlay/docs/EXTRA.md'), 'replace no tracked, listed file');
kase('an unsorted manifest', () => setManifest((l) => { const b = l.filter((x) => x.trim() && !x.startsWith('#')); return [...l.filter((x) => x.startsWith('#')), ...b.reverse(), '']; }), 'must be sorted');
// 3. Output and commit checks.
{
  git('checkout', '-q', '-f', 'base'); git('clean', '-qfdx');
  const busy = join(T, 'busy'); mkdirSync(busy); writeFileSync(join(busy, 'x'), 'x');
  const r = exp('HEAD', busy);
  check(r.ec === 1 && r.err.includes('is not an empty directory') && readdirSync(busy).length === 1, 'refuses: an output directory that is not empty');
  const b = exp('no-such-commit');
  check(b.ec === 1 && b.err.includes('is not a commit') && b.files.length === 0, 'refuses: a bad commit');
}
// 4. The public copy (the export, imported as its own repository) passes only with --public-tree.
{
  const P = join(T, 'public-copy');
  const pgit = (...a) => { const r = spawnSync('git', ['-c', 'user.name=export test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: P, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  mkdirSync(P);
  for (const f of walk(firstOut)) { mkdirSync(dirname(join(P, f)), { recursive: true }); copyFileSync(join(firstOut, f), join(P, f)); }
  pgit('init', '-q', '-b', 'main'); pgit('add', '-A', '-f'); pgit('commit', '-q', '-m', 'Initial public release');
  const ok = exp('HEAD', join(T, `out-${++outN}`), ['--public-tree'], P);
  check(ok.ec === 0 && JSON.stringify(ok.files) === JSON.stringify(walk(firstOut).sort())
    && ok.files.every((f) => readFileSync(join(ok.out, f)).equals(readFileSync(join(firstOut, f)))), 'the public copy re-exports itself unchanged with --public-tree', `${ok.ec} ${ok.err}`);
  const plain = exp('HEAD', join(T, `out-${++outN}`), [], P);
  check(plain.ec === 1 && plain.err.includes(`has no ${ONLY} or ${REQ}`) && plain.files.length === 0, 'the public copy without --public-tree refuses (no internal lists)', `${plain.ec} ${plain.err}`);
  mkdirSync(join(P, 'internal')); writeFileSync(join(P, 'internal', 'x.txt'), 'x\n'); pgit('add', '-A', '-f'); pgit('commit', '-q', '-m', 'internal');
  const mixed = exp('HEAD', join(T, `out-${++outN}`), ['--public-tree'], P);
  check(mixed.ec === 1 && mixed.err.includes('--public-tree, but') && mixed.files.length === 0, '--public-tree refuses a commit that has internal/');
}
rmSync(T, { recursive: true, force: true });
console.log(`export-public-test.mjs: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
