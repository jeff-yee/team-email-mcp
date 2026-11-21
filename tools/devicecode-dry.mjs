// Dry check of the device-code sign-in code path. NO network: fetch is blocked, run under `unshare -rn`.
// Loads provider-microsoft (auth.js -> @azure/identity + cache-persistence plugin), builds the
// DeviceCodeCredential the configure command uses, then builds an MSAL PublicClientApplication with
// the same persistence cache plugin @azure/identity uses and reads its (empty) cache. Never calls getToken.
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const D = process.argv[2]; const NM = join(D, 'node_modules');
const ROOT = resolve(process.env.TEAM_EMAIL_MCP_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
if (!process.env.HOME || !resolve(process.env.HOME).startsWith(ROOT + '/scratch-prune/')) throw new Error('HOME must be scratch under ' + ROOT + '/scratch-prune/');

let net = 0; globalThis.fetch = async (u) => { net++; throw new Error('network blocked ' + u); };
const res = [];
const ok = (l) => res.push('PASS ' + l);
const pm = await import(join(NM, '@usejunior/provider-microsoft/dist/index.js')); ok('provider-microsoft + auth.js import (identity, cache-persistence plugin registered)');
const FAKE = '11111111-2222-3333-4444-555555555555';
const a = new pm.DelegatedAuthManager({ mode: 'delegated', clientId: FAKE }, 'prune@example.com');
const cred = a.createPersistentCredential({ clientId: FAKE, cacheName: 'prune-dry', disableAutomaticAuthentication: true, userPromptCallback: () => {} });
assert.equal(cred.constructor.name, 'DeviceCodeCredential'); ok('DeviceCodeCredential constructed (team tenant, persistence enabled)');
assert.throws(() => a.createPersistentCredential({ clientId: 'c4f91d3e-d2d9-4f8b-826f-6a3c19280241' }), /TEAM_CLIENT_ID_REQUIRED/); ok('vendor client id still refused');
const req = (await import('node:module')).createRequire(join(NM, '@azure/identity/package.json'));
const msal = req('@azure/msal-node');
const prov = await import(join(NM, '@azure/identity-cache-persistence/dist/esm/provider.js'));
const plugin = await prov.createPersistenceCachePlugin({ name: 'prune-dry', unsafeAllowUnencryptedStorage: true }); ok('persistence cache plugin created (' + plugin.persistence?.constructor?.name + ')');
const pca = new msal.PublicClientApplication({ auth: { clientId: FAKE, authority: 'https://login.microsoftonline.com/' + pm.TEAM_TENANT_ID }, cache: { cachePlugin: plugin } });
ok('MSAL PublicClientApplication constructed');
const accts = await pca.getTokenCache().getAllAccounts(); assert.deepEqual(accts, []); ok('PCA token cache read through persistence plugin (0 accounts)');
assert.equal(typeof pca.acquireTokenByDeviceCode, 'function'); ok('acquireTokenByDeviceCode present (not called)');
let brokerNote; try { const r2 = req('@azure/msal-node-extensions'); brokerNote = 'msal-node-extensions loaded; NativeBrokerPlugin.isBrokerAvailable=' + new r2.NativeBrokerPlugin().isBrokerAvailable; } catch (e) { brokerNote = 'extensions load error: ' + e.message; }
res.push('INFO ' + brokerNote);
assert.equal(net, 0); ok('0 fetch calls');
console.log(res.join('\n')); console.log(`SUMMARY: ${res.filter(x=>x.startsWith('PASS')).length} passed`);
