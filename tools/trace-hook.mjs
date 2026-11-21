// Logs every module file loaded (ESM + CJS) to $TRACE_OUT. Diagnostic only.
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const out = process.env.TRACE_OUT;
registerHooks({
  load(url, ctx, next) {
    if (out && url.startsWith('file:')) { try { appendFileSync(out, fileURLToPath(url) + '\n'); } catch {} }
    return next(url, ctx);
  },
});
// native addons via process.dlopen
const dl = process.dlopen;
process.dlopen = function (m, f, ...r) { if (out) appendFileSync(out, 'DLOPEN ' + f + '\n'); return dl.call(this, m, f, ...r); };
