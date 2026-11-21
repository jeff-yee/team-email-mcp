#!/usr/bin/env bash
# Re-scan a public copy before anything is pushed or published.
#
# Scan target: the EXPORT (tools/export-public.sh output) and a release tgz
# built FROM that export. Not the internal repository tree: the internal tree
# keeps internal values (docs, internal/) by design, and only the export is
# meant to be public.
#
# Runs, over each target:
#  1. gitleaks (dir mode, redacted): any finding fails.
#  2. trufflehog (filesystem): any verified finding fails; unverified findings
#     fail unless they match a known false positive below (detector + path).
#  3. a grep set, over every file's contents (files that are not valid UTF-8
#     are decoded with replacement, never skipped) AND every file and directory
#     path (so names in the export, under node_modules/ and inside install.tar
#     are checked too): generic built-in patterns (IPv4 addresses, addresses outside
#     example.*, home-directory paths, dated approval notes) plus a PRIVATE
#     pattern file (names, mailboxes, tenant and app ids, internal paths). Keep
#     that file out of the public copy; it is itself sensitive.
# Grep hits in our files fail unless an allow rule matches. Hits in third-party
# files (node_modules/, THIRD-PARTY-NOTICES, licenses/upstream/, package-lock.json)
# only fail for patterns marked "all"; the rest are counted, not failed.
# Never prints secret values or matched text, only rule labels and file:line.
#
# Usage: bash tools/public-rescan.sh --export <dir> [--tgz <file.tgz>] [--patterns <file.tsv>] [--out <results.md>]
#   --patterns defaults to internal/public-rescan-patterns.tsv; without one the
#   scan refuses unless PUBLIC_RESCAN_NO_PRIVATE_PATTERNS=1.
#   Pattern file lines (tab-separated, # comments):
#     deny  <ours|all>  <label>  <python regex>
#     allow <label>     <path regex>  <match regex>
#   Tools: $GITLEAKS and $TRUFFLEHOG, else gitleaks / trufflehog on PATH.
# Exit 0 only when every target is clean.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPORT= TGZ= OUT= PATTERNS="$ROOT/internal/public-rescan-patterns.tsv"
while [ $# -gt 0 ]; do
  case "$1" in
    --export) EXPORT="$2"; shift 2;; --tgz) TGZ="$2"; shift 2;;
    --patterns) PATTERNS="$2"; shift 2;; --out) OUT="$2"; shift 2;;
    *) echo "public-rescan.sh: unknown argument $1" >&2; exit 2;;
  esac
done
[ -d "$EXPORT" ] || { echo "public-rescan.sh: --export <dir> is required" >&2; exit 2; }
[ -z "$TGZ" ] || [ -f "$TGZ" ] || { echo "public-rescan.sh: $TGZ not found" >&2; exit 2; }
if [ ! -f "$PATTERNS" ]; then
  [ "${PUBLIC_RESCAN_NO_PRIVATE_PATTERNS:-0}" = 1 ] || { echo "public-rescan.sh: no private pattern file at $PATTERNS (set --patterns, or PUBLIC_RESCAN_NO_PRIVATE_PATTERNS=1 to scan with the built-in set only)" >&2; exit 2; }
  PATTERNS=
fi
GL="${GITLEAKS:-$(command -v gitleaks || true)}"; TH="${TRUFFLEHOG:-$(command -v trufflehog || true)}"
[ -x "$GL" ] && [ -x "$TH" ] || { echo "public-rescan.sh: needs gitleaks and trufflehog (set GITLEAKS / TRUFFLEHOG)" >&2; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/public-rescan.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
TARGETS=("export=$(cd "$EXPORT" && pwd)")
if [ -n "$TGZ" ]; then
  mkdir -p "$WORK/tgz"; tar -xzf "$TGZ" -C "$WORK/tgz"
  # The release tgz carries install.tar; scan its contents.
  # The tar itself is removed after unpacking so each file is scanned once, as a file.
  while IFS= read -r t; do d="${t%.tar}.unpacked"; mkdir -p "$d"; tar -xf "$t" -C "$d"; rm -f "$t"; done < <(find "$WORK/tgz" -name '*.tar' -type f)
  TARGETS+=("tgz:$(basename "$TGZ")=$WORK/tgz")
fi
for t in "${TARGETS[@]}"; do
  name="${t%%=*}"; dir="${t#*=}"; key=$(printf '%s' "$name" | tr -c 'A-Za-z0-9' _)
  set +e
  "$GL" dir "$dir" --no-banner --redact -f json -r "$WORK/$key.gitleaks.json" >/dev/null 2>"$WORK/$key.gitleaks.err"; gl=$?
  "$TH" filesystem "$dir" --json --no-update >"$WORK/$key.trufflehog.json" 2>"$WORK/$key.trufflehog.err"; th=$?
  set -e
  [ "$gl" -le 1 ] || { echo "public-rescan.sh: gitleaks failed on $name" >&2; cat "$WORK/$key.gitleaks.err" >&2; exit 2; }
  [ "$th" = 0 ] || { echo "public-rescan.sh: trufflehog failed on $name" >&2; tail -5 "$WORK/$key.trufflehog.err" >&2; exit 2; }
  printf '%s\t%s\t%s\n' "$name" "$dir" "$key" >> "$WORK/targets.tsv"
done
GLV=$("$GL" version 2>/dev/null | head -1); THV=$("$TH" --version 2>&1 | head -1)
# Not exec: the EXIT trap above must still remove $WORK (it holds the unpacked tgz).
python3 - "$WORK" "${PATTERNS:-}" "${OUT:-}" "$GLV" "$THV" <<'PY'
import json, os, re, sys, collections, datetime
work, patfile, out, glv, thv = sys.argv[1:6]
# Built-in generic set (not sensitive). scope "ours": third-party hits are only counted.
DENY = [
  ('ours', 'IPv4 address', r'\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b'),
  ('ours', 'address outside example.*', r'(?i)[a-z0-9._%+-]+@(?!example\.(?:com|net|org|invalid)\b)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}'),
  ('ours', 'home-directory path', r'/home/[a-z][a-z0-9_-]*/|/Users/[A-Za-z][A-Za-z0-9_.-]*/|[A-Za-z]:\\\\?Users\\\\?[A-Za-z][A-Za-z0-9_.-]*'),
  ('all', 'dated approval note', r'(?i)"approved"\s*:|\bOK \d{1,2}:\d\d\b|\b\d{1,2}:\d\d ?[AP]M (?:PT|PST|PDT)\b'),
]
ALLOW = [
  # Synthetic test inputs: a userinfo URL the guard must refuse, and a short
  # address used for length checks.
  ('address outside example.*', r'^(tests/offline-test\.mjs|patches/patch-team-build\.diff)$', r'(?i)[a-z]+(:[a-z]+)?@graph\.microsoft\.com|a@b\.com'),
]
# Known trufflehog false positives (unverified only): detector, path regex.
TH_ALLOW = [
  ('URI', r'^tests/offline-test\.mjs$', 'user:pass@ guard fixtures'),
  ('URI', r'(^|/)node_modules/fast-uri/', 'fast-uri test vectors'),
  ('Parsers', r'(^|/)team-install\.sha256$', 'sha256 digests of package files'),
]
if patfile:
    for n, line in enumerate(open(patfile, encoding='utf-8'), 1):
        line = line.rstrip('\n')
        if not line.strip() or line.lstrip().startswith('#'): continue
        f = line.split('\t')
        if f[0] == 'deny' and len(f) == 4 and f[1] in ('ours', 'all'): DENY.append((f[1], f[2], f[3]))
        elif f[0] == 'allow' and len(f) == 4: ALLOW.append((f[1], f[2], f[3]))
        else: sys.exit(f'public-rescan.sh: {patfile}:{n}: bad line')
DENY = [(s, l, re.compile(r)) for s, l, r in DENY]
ALLOW = [(l, re.compile(p), re.compile(r)) for l, p, r in ALLOW]
def third(rel):
    return '/node_modules/' in '/' + rel or rel.endswith('THIRD-PARTY-NOTICES') or rel.startswith('licenses/upstream/') or rel.endswith('package-lock.json')
report, failed = [], False
def emit(s=''): report.append(s)
emit('# Public re-scan results'); emit()
emit(f'- When: {datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")}')
emit(f'- Tools: gitleaks {glv}; trufflehog {thv.split()[-1] if thv else "?"}; grep set: {len(DENY)} deny rules ({"built-in + private file" if patfile else "built-in only"}), {len(ALLOW)} allow rules')
emit('- Scope: the export and a tgz built from it; not the internal tree, which keeps internal data by design.'); emit()
for name, d, key in (l.rstrip('\n').split('\t') for l in open(os.path.join(work, 'targets.tsv'))):
    emit(f'## {name}'); emit()
    nfiles = sum(len(fs) for _, _, fs in os.walk(d))
    emit(f'- files scanned: {nfiles}')
    gl = json.load(open(os.path.join(work, key + '.gitleaks.json'))) if os.path.getsize(os.path.join(work, key + '.gitleaks.json')) else []
    emit(f'- gitleaks: {len(gl)} findings')
    for g in gl: emit(f'  - FAIL {g.get("RuleID")} {os.path.relpath(g.get("File", ""), d)}:{g.get("StartLine")}')
    if gl: failed = True
    ver, unv_ok, unv_bad = 0, collections.Counter(), []
    for line in open(os.path.join(work, key + '.trufflehog.json')):
        try: h = json.loads(line)
        except ValueError: continue
        if 'DetectorName' not in h: continue
        fsd = h.get('SourceMetadata', {}).get('Data', {}).get('Filesystem', {})
        rel = os.path.relpath(fsd.get('file', ''), d); det = h['DetectorName']
        if h.get('Verified'): ver += 1; unv_bad.append(f'VERIFIED {det} {rel}:{fsd.get("line")}'); continue
        why = next((w for dn, pr, w in TH_ALLOW if dn == det and re.search(pr, rel)), None)
        if why: unv_ok[f'{det} ({why})'] += 1
        else: unv_bad.append(f'{det} {rel}:{fsd.get("line")}')
    emit(f'- trufflehog: {ver} verified; {sum(unv_ok.values())} unverified known false positives' + (': ' + ', '.join(f'{k} x{v}' for k, v in sorted(unv_ok.items())) if unv_ok else '') + f'; {len(unv_bad) - ver} other unverified')
    for b in unv_bad: emit(f'  - FAIL {b}')
    if unv_bad: failed = True
    hits = collections.defaultdict(list)
    def check(text, rel, where, last=None):
        tp = 'third-party' if third(rel) else 'ours'
        for scope, label, rx in DENY:
            for m in rx.finditer(text):
                # A path match must end in the entry's own name, so a parent
                # directory's hit is reported once, at that directory.
                if last is not None and m.end() <= len(text) - len(last): continue
                ok = any(al == label and ap.search(rel) and ar.fullmatch(m.group(0)) for al, ap, ar in ALLOW)
                kind = 'allowed' if ok else ('fail' if tp == 'ours' or scope == 'all' else 'counted')
                hits[(label, tp, kind)].append(where)
    replaced = []
    for dp, dns, fs in os.walk(d):
        for n in dns + fs:
            # Every rule also runs on each file and directory path (export names,
            # node_modules entries, names inside install.tar), reported as <rel>:path.
            rel = os.path.relpath(os.path.join(dp, n), d).replace(os.sep, '/')
            check(rel, rel, f'{rel}:path', n)
        for fn in fs:
            p = os.path.join(dp, fn); rel = os.path.relpath(p, d).replace(os.sep, '/')
            # Not valid UTF-8: decode with replacement and scan anyway (never skipped).
            try: raw = open(p, 'rb').read()
            except OSError: emit(f'  - FAIL unreadable file {rel}'); failed = True; continue
            try: s = raw.decode('utf-8')
            except UnicodeDecodeError: s = raw.decode('utf-8', errors='replace'); replaced.append(rel)
            for i, ln in enumerate(s.split('\n'), 1): check(ln, rel, f'{rel}:{i}')
    emit(f'- names checked: every file and directory path; non-UTF-8 files scanned with replacement: {len(replaced)}')
    fails = {k: v for k, v in hits.items() if k[2] == 'fail'}
    emit(f'- grep set: {sum(len(v) for v in fails.values())} failing hits; '
         f'{sum(len(v) for k, v in hits.items() if k[2] == "allowed")} allowed; '
         f'{sum(len(v) for k, v in hits.items() if k[2] == "counted")} third-party hits counted (patterns scoped to our files)')
    for (label, tp, kind), v in sorted(hits.items()):
        if kind == 'fail':
            failed = True
            emit(f'  - FAIL {label} [{tp}] x{len(v)}: ' + ', '.join(v[:10]) + (' ...' if len(v) > 10 else ''))
    for (label, tp, kind), v in sorted(hits.items()):
        if kind == 'allowed': emit(f'  - allowed {label} [{tp}] x{len(v)}: ' + ', '.join(sorted(set(x.split(":")[0] for x in v))))
    for (label, tp, kind), v in sorted(hits.items()):
        if kind == 'counted': emit(f'  - counted {label} [{tp}] x{len(v)}')
    emit()
emit(f'Result: {"FAIL" if failed else "CLEAN"}')
text = '\n'.join(report) + '\n'
if out: open(out, 'w').write(text)
sys.stdout.write(text)
sys.exit(1 if failed else 0)
PY
