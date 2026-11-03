#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * License gate for production dependencies (PLAN.md 21.3): every package shipped in a release must use an
 * allowed license. `(A OR B)` passes when one option is allowed, `(A AND B)` when all are.
 * Usage: node scripts/check-licenses.mjs [--json]  (exit 1 on a violation)
 */
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  '0BSD',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'Unlicense',
  'CC-BY-4.0',
  // Fonts bundled with the web UI (@fontsource-variable/*): redistribution allowed with the license
  'OFL-1.1',
]);

/** Reviewed one by one; the reason is printed with the report. */
const EXCEPTIONS = {
  elkjs: 'EPL-2.0 (weak copyleft): shipped unmodified in the web bundle; source at https://github.com/kieler/elkjs',
};

/** Not redistributed: installed from npm on the user's machine (see NOTICE). */
const NOT_SHIPPED = [/^@anthropic-ai\/claude-agent-sdk(-.*)?$/];

function allowed(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/, '$1');
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some(allowed);
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every(allowed);
  return ALLOWED.has(e.replace(/\+$/, ''));
}

const raw = execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  shell: process.platform === 'win32',
});
const byLicense = JSON.parse(raw);
const violations = [];
const notes = [];
let count = 0;
for (const [license, pkgs] of Object.entries(byLicense)) {
  for (const pkg of pkgs) {
    count++;
    if (NOT_SHIPPED.some((re) => re.test(pkg.name))) continue;
    if (allowed(license)) continue;
    if (EXCEPTIONS[pkg.name]) {
      notes.push(`  ${pkg.name} (${license}): ${EXCEPTIONS[pkg.name]}`);
      continue;
    }
    violations.push(`  ${pkg.name}@${(pkg.versions ?? [pkg.version]).join(',')} — ${license}`);
  }
}

console.log(`Checked ${count} production packages.`);
if (notes.length) console.log(`Reviewed exceptions:\n${notes.join('\n')}`);
if (violations.length) {
  console.error(`\nLicenses not on the allow list:\n${violations.join('\n')}`);
  console.error('\nReplace the dependency, or review it and add it to EXCEPTIONS in scripts/check-licenses.mjs.');
  process.exit(1);
}
console.log('All licenses allowed.');
