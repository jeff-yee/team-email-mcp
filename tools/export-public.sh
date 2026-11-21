#!/usr/bin/env bash
# Write the public copy of a reviewed commit to an empty directory.
#
# The export is exactly the file list in tools/public-manifest.txt (read from
# <commit>, one path per line). It fails, writing nothing, on ANY difference:
#  - a tracked file that is not listed (new files, renames, case variants such as
#    tools/Pilot/ or PILOT/), unless it is under internal/ or public-overlay/
#    or listed in internal/internal-only-paths.txt;
#  - a listed file that the commit does not have;
#  - a listed path that matches the deny list in any letter case (pilot*, home/,
#    homes/, .IdentityService, tokens/, scratch*, staging/, dist/, build/,
#    node_modules/, vendor/, internal/, public-overlay/, .env*, *.out, *.sha256,
#    team-build.config.json), or two listed paths that differ only in case;
#  - a symlink or submodule anywhere in the commit, an unsorted manifest, or an
#    output directory that is not empty.
# Internal-only files that keep their original paths (for example docs/REPORT.md)
# are listed in internal/internal-only-paths.txt: they are never exported, the
# manifest must not list them, and every entry must be a tracked file.
# Overlay: public-overlay/<path> replaces <path> in the export (the internal tree
# keeps internal values in AGENTS.md, README.md and the install skill; the public
# versions live in the overlay). Every overlay file must replace a listed, tracked
# file. internal/public-overlay-paths.txt lists every path that MUST come from the
# overlay: the export fails if a listed overlay file is missing (so the internal
# version can never go out in its place), if an overlay file is not listed, or
# if the list is missing or empty.
# internal/ and public-overlay/ themselves are never exported.
#
# Which tree is being exported is the operator's call, never guessed from the
# commit. By default (the internal repository) internal/internal-only-paths.txt
# and internal/public-overlay-paths.txt are both required, so a commit stripped
# of internal/, public-overlay/ and the internal-only files still fails.
# --public-tree is only for the public copy (its own CI passes it): the commit
# must then have no internal/ or public-overlay/ at all, and is exported as is.
# It reads only <commit> through git (ls-tree, cat-file), never the working
# directory, so untracked sign-in data or scratch files next to the checkout
# cannot leak.
#
# Usage: bash tools/export-public.sh [--public-tree] <commit> <emptyOutDir>
#        bash tools/export-public.sh [--public-tree] --print-manifest <commit>   (what the manifest should list)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=export TREE=internal
if [ "${1:-}" = --public-tree ]; then TREE=public; shift; fi
if [ "${1:-}" = --print-manifest ]; then MODE=print; shift; fi
C="${1:?usage: export-public.sh [--public-tree] <commit> <emptyOutDir> | [--public-tree] --print-manifest <commit>}"
O="${2:-}"
[ "$MODE" = print ] || [ -n "$O" ] || { echo "usage: export-public.sh [--public-tree] <commit> <emptyOutDir>" >&2; exit 2; }
[ $# -le 2 ] || { echo "usage: export-public.sh [--public-tree] <commit> <emptyOutDir>" >&2; exit 2; }
exec python3 - "$ROOT" "$C" "$MODE" "$O" "$TREE" <<'PY'
import os, re, subprocess, sys, hashlib
root, commit, mode, out, tree = sys.argv[1:6]
MANIFEST = 'tools/public-manifest.txt'
INTERNAL = ('internal/', 'public-overlay/')
OVERLAY = 'public-overlay/'
DENY = re.compile(r'(^|/)(pilot[^/]*|homes?|\.identityservice|tokens|scratch[^/]*|staging|dist|build|node_modules|vendor'
                  r'|internal|public-overlay|\.env[^/]*)(/|$)|\.out$|\.sha256$|(^|/)team-build\.config\.json$', re.I)
def die(msg, items=()):
    items = sorted(items)
    sys.stderr.write(f'export-public.sh: {msg}' + (':\n  ' + '\n  '.join(items[:50]) if items else '') + '\n')
    sys.exit(1)
def git(*a, binary=False):
    r = subprocess.run(['git', '-C', root, *a], capture_output=True)
    if r.returncode: die(f'git {" ".join(a)} failed: {r.stderr.decode(errors="replace").strip()}')
    return r.stdout if binary else r.stdout.decode()
r = subprocess.run(['git', '-C', root, 'rev-parse', '--verify', '--quiet', commit + '^{commit}'], capture_output=True, text=True)
if r.returncode: die(f'{commit} is not a commit')
sha = r.stdout.strip()
entries = {}
for rec in git('ls-tree', '-r', '-z', '--full-tree', sha, binary=True).split(b'\0'):
    if not rec: continue
    meta, path = rec.split(b'\t', 1)
    m, typ, obj = meta.decode().split()
    entries[path.decode('utf-8', 'surrogateescape')] = (m, typ, obj)
links = [p for p, (m, t, _) in entries.items() if m == '120000']
if links: die(f'{sha} has symlinks', links)
subs = [p for p, (m, t, _) in entries.items() if t != 'blob']
if subs: die(f'{sha} has submodules or non-file entries', subs)
ONLY = 'internal/internal-only-paths.txt'
REQ = 'internal/public-overlay-paths.txt'
if tree == 'public':
    inside = [p for p in entries if p.startswith(INTERNAL)]
    if inside: die(f'--public-tree, but {sha[:12]} has internal/ or public-overlay/ (export the internal repository without --public-tree)', inside)
else:
    lacking = [p for p in (ONLY, REQ) if p not in entries]
    if lacking: die(f'{sha[:12]} has no {" or ".join(lacking)}; the internal repository needs both (only the public copy may use --public-tree)')
only = set()
if ONLY in entries:
    only = {l.strip() for l in git('cat-file', 'blob', entries[ONLY][2]).split('\n') if l.strip() and not l.lstrip().startswith('#')}
    bad = [p for p in only if p.startswith(INTERNAL)]
    if bad: die(f'{ONLY} lists paths under internal/ or public-overlay/ (already internal)', bad)
    stale = only - set(entries)
    if stale: die(f'{ONLY} lists files that {sha[:12]} does not have', stale)
public = {p for p in entries if not p.startswith(INTERNAL) and p not in only}
overlay = {p[len(OVERLAY):]: entries[p] for p in entries if p.startswith(OVERLAY)}
if mode == 'print':
    print('\n'.join(sorted(public)))
    sys.exit(0)
if MANIFEST not in entries: die(f'{sha} has no {MANIFEST}')
lines = [l.rstrip('\r') for l in git('cat-file', 'blob', entries[MANIFEST][2]).split('\n')]
listed = [l for l in lines if l.strip() and not l.lstrip().startswith('#')]
if any(l != l.strip() for l in listed): die('manifest lines have surrounding spaces', [l for l in listed if l != l.strip()])
if listed != sorted(listed, key=lambda s: s.encode()) or len(set(listed)) != len(listed):
    die(f'{MANIFEST} must be sorted (C locale) with no duplicates')
M = set(listed)
bad = [p for p in M if p.startswith('/') or '\\' in p or any(x in ('', '.', '..') for x in p.split('/'))]
if bad: die('manifest paths must be plain relative paths', bad)
low = {}
for p in M: low.setdefault(p.lower(), []).append(p)
clash = [' / '.join(v) for v in low.values() if len(v) > 1]
if clash: die('manifest paths differ only in letter case', clash)
listed_only = M & only
if listed_only: die(f'manifest lists internal-only paths from {ONLY}', listed_only)
denied = [p for p in M if DENY.search(p)]
if denied: die('manifest lists denied paths', denied)
extra = public - M
if extra: die(f'tracked in {sha[:12]} but not in {MANIFEST} (add it to the manifest after review, or mark it internal-only)', extra)
missing = M - public
if missing: die(f'listed in {MANIFEST} but not in {sha[:12]}', missing)
stray = set(overlay) - public
if stray: die('public-overlay files that replace no tracked, listed file', stray)
if REQ in entries:
    req = [l.strip() for l in git('cat-file', 'blob', entries[REQ][2]).split('\n') if l.strip() and not l.lstrip().startswith('#')]
    if not req: die(f'{REQ} is empty')
    req = set(req)
    notlisted = req - M
    if notlisted: die(f'{REQ} lists paths that {MANIFEST} does not', notlisted)
    lost = req - set(overlay)
    if lost: die(f'required public-overlay files are missing (the internal version would be exported)', [OVERLAY + p for p in lost])
    unlisted = set(overlay) - req
    if unlisted: die(f'public-overlay files not listed in {REQ}', [OVERLAY + p for p in unlisted])
if os.path.lexists(out) and (not os.path.isdir(out) or os.path.islink(out) or os.listdir(out)): die(f'{out} is not an empty directory')
os.makedirs(out, exist_ok=True)
for p in sorted(M):
    m, _, obj = overlay.get(p, entries[p])
    dest = os.path.join(out, *p.split('/'))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'xb') as f: f.write(git('cat-file', 'blob', obj, binary=True))
    os.chmod(dest, 0o755 if entries[p][0] == '100755' else 0o644)
got = set()
for d, dirs, files in os.walk(out):
    for n in dirs + files:
        full = os.path.join(d, n)
        if os.path.islink(full): die('symlink in the export', [full])
    for n in files:
        full = os.path.join(d, n)
        if not os.path.isfile(full): die('non-regular file in the export', [full])
        got.add(os.path.relpath(full, out).replace(os.sep, '/'))
if got != M: die('exported files differ from the manifest', got ^ M)
mh = hashlib.sha256(git('cat-file', 'blob', entries[MANIFEST][2], binary=True)).hexdigest()
print(f'exported {len(M)} files of {sha} to {out} ({tree} tree; {len(overlay)} from public-overlay/; manifest sha256 {mh})')
PY
