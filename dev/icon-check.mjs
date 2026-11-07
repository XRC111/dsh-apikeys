/**
 * Icon checks for dsh-github-plugin: the declared file is a well-formed SVG of
 * an acceptable size, references its own definitions, and carries no scripts.
 */
import fs from 'node:fs';
import { pluginFile } from './_shared.mjs';

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

const svg = fs.readFileSync(pluginFile('icon.svg'), 'utf8').trim();

check(/^<svg[\s>]/u.test(svg), 'the root element is <svg>');
check(svg.endsWith('</svg>'), 'the root element is closed');
check(!/<script/iu.test(svg), 'no <script> element');
check(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'the SVG namespace is declared');
check(Buffer.byteLength(svg) <= 256 * 1024, 'the file is within the 256 KiB limit');

const refs = [...svg.matchAll(/url\(#([^)]+)\)/gu)].map((match) => match[1]);
const ids = [...svg.matchAll(/id="([^"]+)"/gu)].map((match) => match[1]);
check(refs.every((ref) => ids.includes(ref)), 'every local reference resolves to a declared id');

console.log(`  ..   ${Buffer.byteLength(svg)} bytes, ids: ${ids.join(', ') || '(none)'}`);
console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all icon checks passed');
}
