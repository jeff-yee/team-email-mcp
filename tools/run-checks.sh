#!/usr/bin/env bash
# Offline checks against an install dir (scratch only). Usage: run-checks.sh <installDir> <label>
# Optional TRACE=1 records every loaded module file into $SP/trace-<label>.txt
# Exits non-zero if any suite fails.
set -u
ROOT="${TEAM_EMAIL_MCP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -z "${1:-}" ] || [ ! -d "$1" ]; then
  echo "usage: $0 <installDir> <label>" >&2
  echo "  label must be a non-empty [A-Za-z0-9._-]+ value, not '.' or '..'" >&2
  exit 2
fi
D="$(cd "$1" && pwd)"
L="${2-}"
if [ -z "$L" ] || [[ ! "$L" =~ ^[A-Za-z0-9._-]+$ ]] || [ "$L" = "." ] || [ "$L" = ".." ]; then
  echo "run-checks.sh: invalid label '${L:-}' (use only A-Za-z0-9._-; not empty, '.', '..', or a path)" >&2
  exit 2
fi
SP="$ROOT/scratch-prune"; T="$ROOT/tests"; TOOL="$ROOT/tools"
H="$SP/homes/$L"; rm -rf "$H"; mkdir -p "$H/.email-agent-mcp/bin"
NODEARGS=(); [ "${TRACE:-}" = 1 ] && { NODEARGS=(--import "$TOOL/trace-hook.mjs"); export TRACE_OUT="$SP/trace-$L.txt"; rm -f "$TRACE_OUT"; }
E=(env HOME="$H" EMAIL_AGENT_MCP_HOME="$H/.email-agent-mcp" TEAM_EMAIL_MCP_ROOT="$ROOT")
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails+1)); }

echo "### [$L] offline-test.mjs"
ot_out="$H/offline-test.out"; ot_err="$H/offline-test.err"
if "${E[@]}" unshare -rn node "${NODEARGS[@]}" "$T/offline-test.mjs" "$D" >"$ot_out" 2>"$ot_err"; then
  tail -1 "$ot_out"
else
  ec=$?
  tail -20 "$ot_out"
  cat "$ot_err" >&2
  fail "offline-test.mjs (exit $ec)"
fi

echo "### [$L] legacy guard"
lg_out="$H/legacy-guard.out"; lg_err="$H/legacy-guard.err"
if "${E[@]}" unshare -rn node "${NODEARGS[@]}" "$T/legacy-guard-unit-test.mjs" "$D" >"$lg_out" 2>"$lg_err"; then
  tail -1 "$lg_out"
else
  ec=$?
  tail -20 "$lg_out"
  cat "$lg_err" >&2
  fail "legacy guard (exit $ec)"
fi

echo "### [$L] serve-no-clientid (empty home)"
sn_out="$H/serve-no-clientid.out"; sn_err="$H/serve-no-clientid.err"
if "${E[@]}" unshare -rn node "${NODEARGS[@]}" "$T/serve-no-clientid.mjs" "$D" >"$sn_out" 2>"$sn_err"; then
  cat "$sn_out"
  if ! grep -q 'not_configured' "$sn_out"; then
    fail "serve-no-clientid (expected not_configured)"
  fi
else
  ec=$?
  cat "$sn_out"
  cat "$sn_err" >&2
  fail "serve-no-clientid (exit $ec)"
fi

echo "### [$L] device-code dry check"
dc_out="$H/devicecode-dry.out"; dc_err="$H/devicecode-dry.err"
if "${E[@]}" unshare -rn node "${NODEARGS[@]}" "$TOOL/devicecode-dry.mjs" "$D" >"$dc_out" 2>"$dc_err"; then
  tail -2 "$dc_out"
else
  ec=$?
  tail -20 "$dc_out"
  cat "$dc_err" >&2
  fail "device-code dry check (exit $ec)"
fi

# simulated install with a manifest + launcher regenerated for THIS copy (scratch only)
I="$H/.email-agent-mcp/patched-install"; cp -a "$D" "$I"
(cd "$I" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$H/.email-agent-mcp/team-install.sha256"
(cd "$I" && find . -type l -printf '%p -> %l\n' | LC_ALL=C sort) > "$H/.email-agent-mcp/team-install.links"
MS=$(sha256sum < "$H/.email-agent-mcp/team-install.sha256" | cut -d' ' -f1); LS=$(sha256sum < "$H/.email-agent-mcp/team-install.links" | cut -d' ' -f1)
sed -e "s/@@BUILD_TAG@@/prune-$L/" -e "s/@@MANIFEST_SHA256@@/$MS/" -e "s/@@LINKS_SHA256@@/$LS/" "$ROOT/src/team-email-agent-mcp-stdio.mjs.in" > "$H/.email-agent-mcp/bin/team-email-agent-mcp-stdio.mjs"
LN="$H/.email-agent-mcp/bin/team-email-agent-mcp-stdio.mjs"
# The launcher runs the CLI in-process, so TRACE=1 hooks it through NODE_OPTIONS.
[ "${TRACE:-}" = 1 ] && export NODE_OPTIONS="--import $TOOL/trace-hook.mjs"

echo "### [$L] MCP stdio via launcher (draft)"
md_out="$H/mcp-draft.out"; md_err="$H/mcp-draft.err"
if HOME="$H" EMAIL_AGENT_MCP_HOME="$H/.email-agent-mcp" TEAM_EMAIL_MCP_ROOT="$ROOT" TRACE_OUT="${TRACE_OUT:-}" unshare -rn node "$T/mcp-stdio-test.mjs" "$LN" >"$md_out" 2>"$md_err"; then
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({started:j.started,tools:j.tools?.length,refusedCalls:Object.values(j.calls||{}).filter(x=>/unavailable in the team build/.test(x)).length+"/6",stderr:j.stderrStart?.slice(-1)})); if(!j.started) process.exit(1); if((j.tools||[]).length!==16) process.exit(1); const n=Object.values(j.calls||{}).filter(x=>/unavailable in the team build/.test(x)).length; if(n!==6) process.exit(1);})' <"$md_out" || fail "MCP stdio draft (unexpected tool/refusal counts)"
else
  ec=$?
  cat "$md_out"
  cat "$md_err" >&2
  fail "MCP stdio via launcher (draft) (exit $ec)"
fi

echo "### [$L] startup text (no delete-enable or Gmail hints)"
if node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.stderrStart||[]).join("\n");if(!/Delete policy: disabled/.test(t)){console.error("startup text missing the delete-policy line");process.exit(1)}if(/DELETE_ENABLED|gmail/i.test(t)){console.error(t);process.exit(1)}console.log("startup text clean ("+(j.stderrStart||[]).length+" lines)")})' <"$md_out"; then :; else
  fail "startup text mentions DELETE_ENABLED or Gmail (or lacks the delete-policy line)"
fi

echo "### [$L] MCP stdio via launcher (observe)"
mo_out="$H/mcp-observe.out"; mo_err="$H/mcp-observe.err"
if HOME="$H" EMAIL_AGENT_MCP_HOME="$H/.email-agent-mcp" TEAM_EMAIL_MCP_ROOT="$ROOT" EMAIL_AGENT_MCP_SCOPE_PROFILE=observe unshare -rn node "$T/mcp-stdio-test.mjs" "$LN" >"$mo_out" 2>"$mo_err"; then
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({started:j.started,tools:j.tools?.length})); if(!j.started) process.exit(1); if((j.tools||[]).length!==11) process.exit(1);})' <"$mo_out" || fail "MCP stdio observe (unexpected tool count)"
else
  ec=$?
  cat "$mo_out"
  cat "$mo_err" >&2
  fail "MCP stdio via launcher (observe) (exit $ec)"
fi

echo "### [$L] CLI configure w/o client id (expect TEAM_CLIENT_ID_REQUIRED)"
cfg_out="$H/configure-noid.out"
if HOME="$H" EMAIL_AGENT_MCP_HOME="$H/.email-agent-mcp" TEAM_EMAIL_MCP_ROOT="$ROOT" TRACE_OUT="${TRACE_OUT:-}" unshare -rn node "$LN" configure --mailbox prune@example.com --provider microsoft >"$cfg_out" 2>&1; then
  cat "$cfg_out" | cut -c1-200
  fail "CLI configure without client id exited 0; expected TEAM_CLIENT_ID_REQUIRED"
else
  grep -o 'TEAM_CLIENT_ID_REQUIRED' "$cfg_out" | head -1
  if ! grep -q 'TEAM_CLIENT_ID_REQUIRED' "$cfg_out"; then
    cat "$cfg_out" >&2
    fail "CLI configure without client id (missing TEAM_CLIENT_ID_REQUIRED)"
  fi
fi

echo "### [$L] CLI configure gmail (expect disabled)"
gm_out="$H/configure-gmail.out"
if HOME="$H" EMAIL_AGENT_MCP_HOME="$H/.email-agent-mcp" TEAM_EMAIL_MCP_ROOT="$ROOT" unshare -rn node "$LN" configure --mailbox x@example.net --provider gmail >"$gm_out" 2>&1; then
  tail -2 "$gm_out" | cut -c1-160
  fail "CLI configure gmail exited 0; expected a refusal"
else
  tail -2 "$gm_out" | cut -c1-160
  if ! grep -qiE 'microsoft only|gmail.*disabled|disabled in the team build' "$gm_out"; then
    cat "$gm_out" >&2
    fail "CLI configure gmail (expected microsoft-only / disabled refusal)"
  fi
fi

echo "### [$L] help text (no token, Gmail, or delete hints)"
help_out="$H/help-text.out"
HOME="$H" EMAIL_AGENT_MCP_HOME="$H/.email-agent-mcp" TEAM_EMAIL_MCP_ROOT="$ROOT" unshare -rn node "$LN" help >"$help_out" 2>&1 || true
if [ ! -s "$help_out" ] || grep -qiE 'token |gmail|DELETE_ENABLED|client-secret' "$help_out"; then
  cat "$help_out" >&2
  fail "help text still mentions token, Gmail, or delete settings (or was empty)"
else
  echo "help text clean"
fi

echo "### [$L] verify-mailbox guard path (scratch only)"
vg_out="$H/verify-mailbox-guard.out"; vg_err="$H/verify-mailbox-guard.err"
if "${E[@]}" unshare -rn bash "$T/verify-mailbox-guard-test.sh" >"$vg_out" 2>"$vg_err"; then
  tail -1 "$vg_out"
else
  ec=$?
  cat "$vg_out"
  cat "$vg_err" >&2
  fail "verify-mailbox guard path (exit $ec)"
fi

echo "### [$L] verify-install args (scratch only)"
vi_out="$H/verify-install-test.out"; vi_err="$H/verify-install-test.err"
if "${E[@]}" unshare -rn node "$T/verify-install-test.mjs" >"$vi_out" 2>"$vi_err"; then
  tail -1 "$vi_out"
else
  ec=$?
  cat "$vi_out"
  cat "$vi_err" >&2
  fail "verify-install args (exit $ec)"
fi

echo "### [$L] launcher tamper (1 byte) refuses"
echo >> "$I/node_modules/@usejunior/provider-microsoft/dist/team-build-config.js"
tmp_out="$H/tamper.out"
HOME="$H" EMAIL_AGENT_MCP_HOME="$H/.email-agent-mcp" TEAM_EMAIL_MCP_ROOT="$ROOT" node "$LN" --help >"$tmp_out" 2>&1 || true
c=$(grep -c REFUSING "$tmp_out" || true)
echo "$c"
if [ "$c" -lt 1 ]; then
  cat "$tmp_out" >&2
  fail "launcher tamper did not print REFUSING"
fi

if [ "$fails" -ne 0 ]; then
  echo "run-checks.sh: $fails suite(s) failed [$L]" >&2
  exit 1
fi
echo "run-checks.sh: all suites passed [$L]"
