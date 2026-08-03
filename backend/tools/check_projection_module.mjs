import fs from 'node:fs';
import vm from 'node:vm';

const target = process.argv[2] || 'projection3d.html';
const htmlPath = new URL(`../../frontend/${target}`, import.meta.url);
const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!match) throw new Error(`${target}_module_script_missing`);
new vm.SourceTextModule(match[1], { identifier: htmlPath.href });
console.log(`${target} module syntax OK`);
