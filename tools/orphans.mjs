// Print package dirs under <dir>/node_modules that become unreachable from the root package.json
// when the named packages are cut out of the dependency graph. Usage: node orphans.mjs <dir> name...
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
const [root, ...cut] = process.argv.slice(2); const CUT = new Set(cut);
const pj = p => JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'));
function resolveDep(from, name) { let d = from; for (;;) { const c = join(d, 'node_modules', name); if (existsSync(join(c, 'package.json'))) return c; if (d === root) return null; d = dirname(d); while (d !== root && d.endsWith('/node_modules')) d = dirname(d); if (!d.startsWith(root)) return null; } }
const seen = new Set(); const stack = [root];
while (stack.length) { const p = stack.pop(); const j = pj(p);
  const deps = { ...j.dependencies, ...j.optionalDependencies, ...j.peerDependencies };
  for (const n of Object.keys(deps)) { if (CUT.has(n)) continue; const r = resolveDep(p, n); if (r && !seen.has(r)) { seen.add(r); stack.push(r); } } }
const all = []; (function walk(nm) { if (!existsSync(nm)) return; for (const e of readdirSync(nm)) { if (e === '.bin') continue; const p = join(nm, e); if (e.startsWith('@')) { for (const s of readdirSync(p)) { all.push(join(p, s)); walk(join(p, s, 'node_modules')); } } else { all.push(p); walk(join(p, 'node_modules')); } } })(join(root, 'node_modules'));
for (const p of all) if (!seen.has(p) && existsSync(join(p, 'package.json'))) console.log(relative(root, p));
