// Runs the REAL device-code flow (identity DeviceCodeCredential -> msal-node acquireTokenByDeviceCode,
// with the persistence cache plugin) against an in-process fake HTTP client. Nothing leaves the
// process: fetch is blocked and this is run under `unshare -rn`. The fake token endpoint answers
// "authorization_declined", so no token is ever produced.
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const D = process.argv[2]; const NM = join(D, 'node_modules');
const ROOT = resolve(process.env.TEAM_EMAIL_MCP_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
if (!process.env.HOME || !resolve(process.env.HOME).startsWith(ROOT + '/scratch-prune/')) throw new Error('HOME must be scratch under ' + ROOT + '/scratch-prune/');

globalThis.fetch = async (u) => { throw new Error('network blocked ' + u); };
const pm = await import(join(NM, '@usejunior/provider-microsoft/dist/index.js'));   // registers cache plugin
const req = createRequire(join(NM, '@azure/identity/package.json'));
const { createHttpHeaders } = await import(join(NM, '@azure/core-rest-pipeline/dist/esm/index.js'));
const { DeviceCodeCredential } = await import(join(NM, '@azure/identity/dist/esm/index.js'));
const T = pm.TEAM_TENANT_ID, H = 'https://login.microsoftonline.com';
const seen = [];
const httpClient = { async sendRequest(request) {
  const u = new URL(request.url); seen.push(`${request.method} ${u.pathname}`);
  const json = (o, status = 200) => ({ request, status, headers: createHttpHeaders({ 'content-type': 'application/json' }), bodyAsText: JSON.stringify(o) });
  if (u.pathname.endsWith('/discovery/instance')) return json({ tenant_discovery_endpoint: `${H}/${T}/v2.0/.well-known/openid-configuration`, 'api-version': '1.1', metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com', 'sts.windows.net'] }] });
  if (u.pathname.endsWith('/openid-configuration')) return json({ token_endpoint: `${H}/${T}/oauth2/v2.0/token`, authorization_endpoint: `${H}/${T}/oauth2/v2.0/authorize`, device_authorization_endpoint: `${H}/${T}/oauth2/v2.0/devicecode`, end_session_endpoint: `${H}/${T}/oauth2/v2.0/logout`, issuer: `${H}/${T}/v2.0`, jwks_uri: `${H}/${T}/discovery/v2.0/keys` });
  if (u.pathname.endsWith('/devicecode')) return json({ device_code: 'FAKE-DEVICE-CODE', user_code: 'FAKE1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1, message: 'FAKE: To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code FAKE1234.' });
  if (u.pathname.endsWith('/token')) return json({ error: 'authorization_declined', error_description: 'FAKE: user declined (offline mock)', error_codes: [70000] }, 400);
  return json({ error: 'unexpected', path: u.pathname }, 404);
} };
let prompt;
const cred = new DeviceCodeCredential({ clientId: '11111111-2222-3333-4444-555555555555', tenantId: T, httpClient,
  userPromptCallback: (i) => { prompt = i; }, tokenCachePersistenceOptions: { enabled: true, name: 'prune-flow', unsafeAllowUnencryptedStorage: true } });
let err; try { await cred.getToken(['https://graph.microsoft.com/User.Read', 'offline_access', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Read.Shared']); } catch (e) { err = e; }
assert.equal(prompt?.userCode, 'FAKE1234', 'device-code prompt callback fired with user code');
assert.ok(err && /declined|authorization_declined|70000/i.test(String(err.message)), 'token step ended with the mocked decline: ' + err?.message?.slice(0, 120));
console.log('PASS device-code flow ran end to end against the in-process mock: prompt userCode=' + prompt.userCode + ', then mocked decline (' + err.name + ')');
console.log('requests (all in-process): ' + [...new Set(seen)].join(' | '));
