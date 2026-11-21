import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const D = resolve(process.argv[2]);
let net = 0; globalThis.fetch = async (u) => { net++; throw new Error('network blocked ' + u); };
const srv = await import(pathToFileURL(join(D, 'node_modules/@usejunior/email-mcp/dist/server.js')).href);
const st = srv.createLazyProviderState(); await srv.initProvider(st);
console.log(JSON.stringify({ status: st.status, mailboxes: st.mailboxes.map(m => ({ name: m.name, status: m.status, error: (m.error || '').slice(0, 110) })), fetchCalls: net }));
