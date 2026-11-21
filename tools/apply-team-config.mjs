// Fill the tenant and client id placeholders in a copy of team-build-config.js.
// Usage: node tools/apply-team-config.mjs <team-build-config.js in the patched tree>
// Reads $TEAM_BUILD_CONFIG, else <repo>/team-build.config.json (untracked; copy
// team-build.config.example.json). A missing or invalid config refuses with exit 2
// and TEAM_BUILD_CONFIG_MISSING; there is no built-in fallback tenant or app.
// deniedClientIdPrefixes must list at least one prefix unless the config sets
// "allowNoDeniedClients": true; otherwise it refuses with TEAM_BUILD_CONFIG_NO_DENIED_CLIENTS.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.TEAM_EMAIL_MCP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const die = (m, code = 'TEAM_BUILD_CONFIG_MISSING') => { process.stderr.write(`apply-team-config: ${code}: ${m}\n`); process.exit(2); };
if (!target || !existsSync(target)) { process.stderr.write('usage: apply-team-config.mjs <team-build-config.js>\n'); process.exit(2); }
const file = resolve(process.env.TEAM_BUILD_CONFIG || join(ROOT, 'team-build.config.json'));
if (!existsSync(file)) die(`no build config at ${file}. Copy team-build.config.example.json to team-build.config.json (or set TEAM_BUILD_CONFIG) and fill in your tenant id and team app client id.`);
let cfg;
try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { die(`${file} is not valid JSON (${e.message}).`); }
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VENDOR = 'c4f91d3e-d2d9-4f8b-826f-6a3c19280241';
const tenantId = String(cfg?.tenantId ?? '').trim().toLowerCase();
const clientId = String(cfg?.clientId ?? '').trim().toLowerCase();
const denied = cfg?.deniedClientIdPrefixes ?? [];
const allowNone = cfg?.allowNoDeniedClients ?? false;
if (!GUID.test(tenantId)) die(`tenantId in ${file} must be your Entra tenant id (a GUID).`);
if (!GUID.test(clientId)) die(`clientId in ${file} must be the team app's client id (a GUID).`);
if (clientId === VENDOR) die('clientId must be your own team app, not the vendor default app.');
if (!Array.isArray(denied) || !denied.every((p) => typeof p === 'string' && /^[0-9a-f]{8}-$/.test(p.toLowerCase())))
  die(`deniedClientIdPrefixes in ${file} must be a list of 9-character prefixes like "0123abcd-".`);
if (typeof allowNone !== 'boolean') die(`allowNoDeniedClients in ${file} must be true or false.`);
if (denied.length === 0 && allowNone !== true)
  die(`deniedClientIdPrefixes in ${file} is missing or empty. List the client id prefixes this build must refuse (for example another app in the tenant that holds Mail.Send), or set "allowNoDeniedClients": true if there are none.`, 'TEAM_BUILD_CONFIG_NO_DENIED_CLIENTS');
if (denied.some((p) => clientId.startsWith(p.toLowerCase()))) die('clientId matches one of deniedClientIdPrefixes.');
let src = readFileSync(target, 'utf8');
const fill = { "'@@TEAM_TENANT_ID@@'": `'${tenantId}'`, "'@@TEAM_CLIENT_ID@@'": `'${clientId}'`,
  '/* @@TEAM_DENIED_CLIENT_ID_PREFIXES@@ */': denied.map((p) => `'${p.toLowerCase()}'`).join(', '),
  "'@@TEAM_ALLOW_NO_DENIED_CLIENTS@@'": String(allowNone) };
for (const [k, v] of Object.entries(fill)) {
  if (src.split(k).length !== 2) die(`${target} does not contain exactly one ${k} placeholder (already filled?).`);
  src = src.replace(k, v);
}
writeFileSync(target, src);
process.stderr.write(`apply-team-config: filled tenant, client id and ${denied.length} denied prefix(es) from ${file}\n`);
