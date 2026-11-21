# Offline sandbox for repo checks

Offline tests and `tools/run-checks.sh` are meant to run with no network. The
r2 checks used bwrap with a read-only root, a private tmpfs `/tmp`, only a
scratch directory writable (outside this repo), `--unshare-pid --unshare-net
--die-with-parent`, and `--clearenv` plus an explicit `PATH`, `HOME`, `LANG`,
and `npm_config_cache`.

`tools/run-checks.sh` also runs each suite under an inner `unshare -rn`. That
is in addition to the bwrap network namespace, not a substitute for `--clearenv`.

A saved command that omits `--clearenv` is not what ran; include `--clearenv`
(and the `--setenv` values the scripts need) so the saved command matches the
run.
