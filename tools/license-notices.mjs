// Make sure every bundled package carries license text, then write THIRD-PARTY-NOTICES.
// Usage: node tools/license-notices.mjs <prunedTree> <repoLICENSE>
// A package with no license/licence/copying/notice file gets, in order:
//  1. the verbatim upstream license file listed for it in licenses/upstream/SOURCES.json
//     (next to <repoLICENSE>; its sha256 is checked);
//  2. otherwise a LICENSE written from its package.json "license" field (Apache-2.0
//     from <repoLICENSE>; MIT, ISC and BSD-2-Clause from the standard text, with the
//     package author as the holder), marked as added by the team build.
// Any other case, or a vendored file whose sha256 does not match, fails the build.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';

const [TREE, APACHE] = process.argv.slice(2);
if (!TREE || !APACHE) { console.error('usage: license-notices.mjs <prunedTree> <repoLICENSE>'); process.exit(2); }
const N = join(TREE, 'node_modules');
const LIC = /^(licen[cs]e|copying|notice)/i;
const holder = (a) => String((typeof a === 'object' ? a?.name : a) || 'the package authors').replace(/\s*[<(].*$/, '').trim();
const TEXT = {
  MIT: (c) => `MIT License\n\nCopyright (c) ${c}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`,
  ISC: (c) => `ISC License\n\nCopyright (c) ${c}\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES\nWITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF\nMERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR\nANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES\nWHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN\nACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF\nOR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n`,
  'BSD-2-Clause': (c) => `BSD 2-Clause License\n\nCopyright (c) ${c}\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this\n   list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice,\n   this list of conditions and the following disclaimer in the documentation\n   and/or other materials provided with the distribution.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"\nAND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE\nIMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE\nDISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE\nFOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL\nDAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR\nSERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER\nCAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,\nOR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n`,
};
const pkgs = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.name.startsWith('@')) { walk(p); continue; }
    if (existsSync(join(p, 'package.json'))) pkgs.push(p);
    if (existsSync(join(p, 'node_modules'))) walk(join(p, 'node_modules'));
  }
};
walk(N);
const apache = readFileSync(APACHE, 'utf8');
const UP = join(dirname(APACHE), 'licenses', 'upstream');
const upstream = existsSync(join(UP, 'SOURCES.json')) ? JSON.parse(readFileSync(join(UP, 'SOURCES.json'), 'utf8')).packages : {};
const upstreamText = (name) => {
  const u = upstream[name];
  if (!u) return null;
  const buf = readFileSync(join(UP, u.file));
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== u.sha256) { console.error(`license-notices: licenses/upstream/${u.file} sha256 ${got} does not match ${u.sha256}`); process.exit(1); }
  return buf.toString('utf8');
};
let fromUpstream = 0, fromTemplate = 0;
const out = [];
let bad = 0;
for (const p of pkgs.sort()) {
  const j = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'));
  const declared = typeof j.license === 'string' ? j.license : (j.license?.type || '');
  let files = readdirSync(p).filter((f) => LIC.test(f));
  if (!files.length) {
    const up = upstreamText(j.name);
    if (up) { writeFileSync(join(p, 'LICENSE'), up); fromUpstream++; }
    else {
      const text = declared === 'Apache-2.0' ? apache : TEXT[declared]?.(holder(j.author));
      if (!text) { console.error(`license-notices: ${relative(N, p)} has no license file and no known declared license (${declared || 'none'})`); bad++; continue; }
      const note = `(Added by the team build: this package and its upstream source ship no license file; standard text for its declared license "${declared}".)\n\n`;
      writeFileSync(join(p, 'LICENSE'), note + text);
      fromTemplate++;
    }
    files = ['LICENSE'];
  }
  out.push({ rel: relative(TREE, p).split('\\').join('/'), name: j.name, version: j.version, declared, files });
}
if (bad) process.exit(1);
let doc = 'THIRD-PARTY NOTICES\n\nThis package bundles the npm packages below. Each one keeps its own license\nfile in its directory; the full texts follow the list.\n\n';
for (const o of out) doc += `${o.name}@${o.version} (${o.declared || 'see file'}): ${o.files.map((f) => `${o.rel}/${f}`).join(', ')}\n`;
for (const o of out) for (const f of o.files) doc += `\n${'='.repeat(78)}\n${o.name}@${o.version}: ${o.rel}/${f}\n${'='.repeat(78)}\n\n${readFileSync(join(TREE, o.rel, f), 'utf8').trimEnd()}\n`;
writeFileSync(join(TREE, 'THIRD-PARTY-NOTICES'), doc);
console.error(`license-notices: ${out.length} packages, all with license text (${fromUpstream} from licenses/upstream, ${fromTemplate} from the declared license)`);
