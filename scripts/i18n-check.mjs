// SPDX-License-Identifier: Apache-2.0
// Fails when en/vi locale files do not have exactly the same keys (PLAN.md 11.1).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src/i18n/locales');
const languages = ['en', 'vi'];

// Plural forms differ per language (English: _one/_other, Vietnamese: _other only): compare base keys
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

const namespaces = new Set(languages.flatMap((lang) => fs.readdirSync(path.join(localesDir, lang))));
let problems = 0;

for (const ns of namespaces) {
  const keys = {};
  for (const lang of languages) {
    const file = path.join(localesDir, lang, ns);
    if (!fs.existsSync(file)) {
      console.error(`✕ ${lang}/${ns} is missing`);
      problems++;
      keys[lang] = new Set();
      continue;
    }
    keys[lang] = new Set(flatten(JSON.parse(fs.readFileSync(file, 'utf8'))).map((k) => k.replace(PLURAL_SUFFIX, '')));
  }
  for (const lang of languages) {
    for (const other of languages.filter((l) => l !== lang)) {
      for (const key of keys[other]) {
        if (!keys[lang].has(key)) {
          console.error(`✕ ${lang}/${ns}: missing key "${key}" (present in ${other})`);
          problems++;
        }
      }
    }
  }
}

if (problems > 0) {
  console.error(`\ni18n:check failed with ${problems} problem(s)`);
  process.exit(1);
}
console.log(`✓ i18n:check passed (${[...namespaces].join(', ')})`);
