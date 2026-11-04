#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Release bundle for the current platform (PLAN.md 16.5):
 *   dist-release/crewtree-v<version>-<os>-<arch>/
 *     VERSION  LICENSE  NOTICE  THIRD_PARTY_LICENSES.md
 *     server/   production deploy of @crewtree/server (dist, drizzle, node_modules with native better-sqlite3)
 *     cli/      production deploy of the crewtree CLI
 *     web/dist/ the built web UI, served by the server
 *     bin/crewtree, bin/crewtree.cmd
 *   + crewtree-v<version>-<os>-<arch>.tar.gz (.zip on Windows) and SHA256SUMS
 *
 * Usage: node scripts/pack.mjs [--version v0.2.0] [--skip-build]
 * Each platform is packed on its own runner because better-sqlite3 and the Agent SDK ship native code.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const version = (option('--version') ?? process.env.CREWTREE_VERSION ?? pkgVersion).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid version: ${version}`);

const name = `crewtree-v${version}-${process.platform}-${process.arch}`;
const outRoot = path.join(root, 'dist-release');
const out = path.join(outRoot, name);

function run(cmd, cmdArgs, opts = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: isWindows, ...opts });
}

function log(msg) {
  console.log(`\n▸ ${msg}`);
}

log(`Packing ${name}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (!flag('--skip-build')) {
  log('Building');
  run(pnpm, ['build']);
}

// pnpm deploy copies a workspace package with its production dependencies (native modules built for this machine)
for (const [pkg, dir] of [
  ['@crewtree/server', 'server'],
  ['crewtree', 'cli'],
]) {
  log(`Deploying ${pkg}`);
  // Hoisted (npm-style) node_modules: no symlinks, so the Windows zip extracts with Expand-Archive
  run(pnpm, ['--filter', pkg, 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', path.join(out, dir)], {
    env: { ...process.env, CI: 'true' },
  });
  // Sources, tests and dev configs are not shipped
  for (const extra of ['src', 'test', 'tsconfig.json', 'vitest.config.ts', 'drizzle.config.ts']) {
    fs.rmSync(path.join(out, dir, extra), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(out, dir, 'dist', 'index.js')))
    throw new Error(`${pkg} has no dist/index.js: build first`);
}

// The Claude Agent SDK is proprietary (Anthropic PBC): not redistributed. The bundle's package.json pins it and
// the installers / `crewtree update` run `npm install` in the bundle, fetching it from npm (see NOTICE).
// `pnpm deploy` leaves the workspace's install state stale (pnpm then asks to purge node_modules): restore it
log('Restoring the workspace install');
run(pnpm, ['install', '--frozen-lockfile', '--prefer-offline'], { env: { ...process.env, CI: 'true' } });

log('Removing the Claude Agent SDK from the bundle');
const serverModules = path.join(out, 'server', 'node_modules');
const sdkManifest = path.join(serverModules, '@anthropic-ai', 'claude-agent-sdk', 'package.json');
if (!fs.existsSync(sdkManifest)) throw new Error('Claude Agent SDK not found in the server deploy');
const sdkVersion = JSON.parse(fs.readFileSync(sdkManifest, 'utf8')).version;
for (const entry of fs.readdirSync(path.join(serverModules, '@anthropic-ai'))) {
  if (entry.startsWith('claude-agent-sdk'))
    fs.rmSync(path.join(serverModules, '@anthropic-ai', entry), { recursive: true, force: true });
}
// Command shims (symlinks on POSIX) are not needed in the bundle
for (const dir of ['server', 'cli'])
  fs.rmSync(path.join(out, dir, 'node_modules', '.bin'), { recursive: true, force: true });

// The bundle runs on the user's Node, not the one it was packed with. better-sqlite3 is built per Node ABI, so the
// prebuilt binary of each ABI goes in server/native/ and the CLI switches to the matching one (apps/cli/src/native.ts)
log('Bundling better-sqlite3 binaries for each Node version');
const NODE_ABIS = { 127: 'Node 22', 137: 'Node 24', 141: 'Node 25', 147: 'Node 26' };
const sqliteVersion = JSON.parse(
  fs.readFileSync(path.join(serverModules, 'better-sqlite3', 'package.json'), 'utf8')
).version;
const nativeDir = path.join(out, 'server', 'native');
fs.mkdirSync(nativeDir, { recursive: true });
/** The one file we need from a .tar.gz (ustar), without depending on the platform's tar */
function extractFromTarGz(buffer, suffix) {
  const tar = gunzipSync(buffer);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) =>
      header
        .subarray(start, start + len)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const entry = `${field(345, 155)}${field(345, 155) ? '/' : ''}${field(0, 100)}`;
    if (entry.endsWith(suffix)) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${suffix} not found in the archive`);
}
const libcs = process.platform === 'linux' ? ['linux', 'linuxmusl'] : [process.platform];
const shipped = [];
for (const [abi, label] of Object.entries(NODE_ABIS)) {
  for (const libc of libcs) {
    const key = `node-v${abi}-${libc}-${process.arch}`;
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/better-sqlite3-v${sqliteVersion}-${key}.tar.gz`;
    const res = await fetch(url);
    if (res.status === 404) {
      console.log(`  - ${key} (${label}): no prebuilt binary`);
      continue;
    }
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const binary = extractFromTarGz(Buffer.from(await res.arrayBuffer()), 'better_sqlite3.node');
    fs.writeFileSync(path.join(nativeDir, `better_sqlite3-${key}.node`), binary);
    shipped.push(abi);
    console.log(`  ✓ ${key} (${label})`);
  }
}
for (const required of ['127', '137'])
  if (!shipped.includes(required)) throw new Error(`No better-sqlite3 binary for ${NODE_ABIS[required]}`);
fs.writeFileSync(
  path.join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'crewtree-bundle',
      version,
      private: true,
      description: 'Installed on the user machine by install.sh / install.ps1 / crewtree update',
      dependencies: { '@anthropic-ai/claude-agent-sdk': sdkVersion },
    },
    null,
    2
  )}\n`
);

log('Copying the web UI');
fs.cpSync(path.join(root, 'apps', 'web', 'dist'), path.join(out, 'web', 'dist'), { recursive: true });

log('Writing VERSION, launchers and notices');
fs.writeFileSync(path.join(out, 'VERSION'), `${version}\n`);
for (const file of ['LICENSE', 'NOTICE', 'TRADEMARKS.md']) fs.copyFileSync(path.join(root, file), path.join(out, file));
fs.mkdirSync(path.join(out, 'bin'));
// POSIX launcher: follows the ~/.local/bin symlink back to the bundle
fs.writeFileSync(
  path.join(out, 'bin', 'crewtree'),
  `#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
self="$0"
while [ -h "$self" ]; do
  link=$(ls -ld "$self" | sed 's/.* -> //')
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
here=$(cd "$(dirname "$self")/.." && pwd)
exec node "$here/cli/dist/index.js" "$@"
`,
  { mode: 0o755 }
);
fs.writeFileSync(path.join(out, 'bin', 'crewtree.cmd'), '@echo off\r\nnode "%~dp0..\\cli\\dist\\index.js" %*\r\n');

// Third-party licenses of everything shipped (PLAN.md 21.2)
const seen = new Map();
function collect(dir) {
  const visit = (modules) => {
    if (!fs.existsSync(modules)) return;
    for (const entry of fs.readdirSync(modules)) {
      if (entry.startsWith('.')) continue;
      const dirs = entry.startsWith('@')
        ? fs.readdirSync(path.join(modules, entry)).map((p) => path.join(modules, entry, p))
        : [path.join(modules, entry)];
      for (const pkgDir of dirs) {
        const manifest = path.join(pkgDir, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name && !pkg.name.startsWith('@crewtree/') && !seen.has(`${pkg.name}@${pkg.version}`)) {
          const licenseFile = fs.readdirSync(pkgDir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
          seen.set(`${pkg.name}@${pkg.version}`, {
            name: pkg.name,
            version: pkg.version,
            license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN'),
            text: licenseFile ? fs.readFileSync(path.join(pkgDir, licenseFile), 'utf8').trim() : '',
          });
        }
        visit(path.join(pkgDir, 'node_modules'));
      }
    }
  };
  visit(path.join(dir, 'node_modules'));
}
collect(path.join(out, 'server'));
collect(path.join(out, 'cli'));
// The web UI's dependencies are compiled into web/dist: list them too
const webLicenses = JSON.parse(
  execFileSync(pnpm, ['--filter', '@crewtree/web', 'licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: isWindows,
  })
);
for (const [license, pkgs] of Object.entries(webLicenses)) {
  for (const pkg of pkgs) {
    const version = pkg.versions?.[0] ?? pkg.version;
    if (pkg.name.startsWith('@crewtree/') || seen.has(`${pkg.name}@${version}`)) continue;
    const dir = pkg.paths?.[0];
    const licenseFile =
      dir && fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f)) : undefined;
    seen.set(`${pkg.name}@${version}`, {
      name: pkg.name,
      version,
      license,
      text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : '',
    });
  }
}
const third = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(
  path.join(out, 'THIRD_PARTY_LICENSES.md'),
  `# Third-party software in Crewtree v${version}\n\n` +
    third
      .map(
        (p) =>
          `## ${p.name} ${p.version} — ${p.license}\n\n${p.text ? '```\n' + p.text + '\n```' : '(no license file in the package)'}\n`
      )
      .join('\n')
);

log('Archiving');
const archive = path.join(outRoot, `${name}.${isWindows ? 'zip' : 'tar.gz'}`);
fs.rmSync(archive, { force: true });
// Windows' bundled bsdtar crashes on large zips: PowerShell 7 writes portable entries (forward slashes)
if (isWindows)
  run(
    'pwsh',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${out}' -DestinationPath '${archive}' -CompressionLevel Optimal`,
    ],
    {
      shell: false,
    }
  );
else run('tar', ['-czf', archive, '-C', outRoot, name], { shell: false });

// SHA256SUMS of every archive in dist-release (the release job merges the platforms' files)
const sums = fs
  .readdirSync(outRoot)
  .filter((f) => /\.(tar\.gz|zip)$/.test(f))
  .sort()
  .map(
    (f) =>
      `${crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(outRoot, f)))
        .digest('hex')}  ${f}`
  );
fs.writeFileSync(path.join(outRoot, 'SHA256SUMS'), `${sums.join('\n')}\n`);

const size = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
log(`Done: ${archive} (${size} MB), ${third.length} third-party packages`);
