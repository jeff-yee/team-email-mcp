# Publishing a public copy

A public copy is a **new, empty repository** holding **one import commit** made
from `tools/export-public.sh` output. It never carries this repository's history.
Each step below needs the maintainers' explicit go-ahead, and so does creating
the repository, changing any visibility, or publishing a release asset.

## What is public

- The export, and a release tgz built from the export, are the only public
  artifacts. `tools/public-manifest.txt` lists every exported file, and
  `public-overlay/<path>` (in the internal repository only) replaces `<path>` in
  the export: for example the internal install guide keeps the live release pin,
  while the public guide uses placeholders. Internal files that keep their
  original paths are listed in `internal/internal-only-paths.txt`; the export
  skips them and fails if the manifest lists one.
- The internal repository is **not** a public scan target. It keeps internal
  values on purpose (the internal docs and `internal/`), stays private, and is
  never pushed, mirrored, forked or transferred to the public side.

## Steps

1. **Pick a reviewed commit** of the internal repository with green CI.
2. **Export it** to an empty directory:
   `bash tools/export-public.sh <commit> <exportDir>`.
   This is the internal repository, so no flag: both lists in `internal/`
   (`internal-only-paths.txt`, `public-overlay-paths.txt`) are required, and a
   commit without them fails. `--public-tree` is only for the public copy,
   whose own CI re-exports itself with it; it refuses any commit that has
   `internal/` or `public-overlay/`.
   It fails on any difference from `tools/public-manifest.txt`. When a file is
   added on purpose, review it, add it to the manifest (sorted;
   `bash tools/export-public.sh --print-manifest <commit>` lists the candidates),
   and commit before exporting.
3. **Build a test package from the export**, never from the internal tree, in
   a copy so the export itself stays clean:
   ```bash
   cp -a <exportDir> <buildSrc> && cd <buildSrc>
   TEAM_BUILD_CONFIG=tests/fixtures/team-build.config.test.json bash tools/make-build-tree.sh <tree>
   BUILD_DIR=<tree> TAG=<new-test-name> bash build.sh
   ```
   Use a new `TAG` that matches no existing package. A tgz built with a real
   `team-build.config.json` carries the real tenant and client id; publishing
   one as a release asset is its own decision.
4. **Scan the export and that tgz** before anything is pushed:
   ```bash
   GITLEAKS=<gitleaks> TRUFFLEHOG=<trufflehog> bash tools/public-rescan.sh \
     --export <exportDir> --tgz <buildSrc>/dist/<new-test-name>.tgz \
     --patterns <private pattern file> --out <results.md>
   ```
   It must end with `Result: CLEAN`. The private pattern file (names,
   mailboxes, tenant and app ids, internal paths) is itself sensitive: keep it
   out of the public copy.
5. **Create the new repository empty**: no README, license or .gitignore from
   the hosting site, no template, no fork. The old repository stays private.
6. **Make one import commit** from the export with a neutral identity:
   ```bash
   cd <exportDir>
   git init -b main
   git add -A
   WHEN="$(date -u +%Y-%m-%dT%H:%M:%S+0000)"   # UTC, so the commit carries no local offset
   GIT_AUTHOR_NAME='team-email-mcp maintainers' GIT_AUTHOR_EMAIL='<NOREPLY_EMAIL>' GIT_AUTHOR_DATE="$WHEN" \
   GIT_COMMITTER_NAME='team-email-mcp maintainers' GIT_COMMITTER_EMAIL='<NOREPLY_EMAIL>' GIT_COMMITTER_DATE="$WHEN" \
     git -c user.useConfigOnly=true commit -m 'Initial public release'
   git log -1 --format='%an <%ae> %ad | %cn <%ce> %cd' --date=iso-strict   # check: neutral identity, both dates in UTC (Z)
   git ls-files | diff - <(grep -v '^#' tools/public-manifest.txt | grep .)   # must print nothing
   ```
   `<NOREPLY_EMAIL>` is the hosting account's no-reply address chosen for the
   public repository. Both dates are set in UTC (`+0000`), so the commit does
   not reveal the maintainer's local time zone.
7. **Push only that branch** to the new repository: `git push <newRemote> main`.
   No tags, no `--mirror`, no `--all`, no `refs/pull/*`, and never from a clone
   of the internal repository.
8. **Releases** come later, from the public repository, after their own review.
