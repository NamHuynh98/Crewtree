// SPDX-License-Identifier: Apache-2.0
/**
 * Opens the UI in its own app window: no tabs, no address bar, only Crewtree (Chromium's `--app=` mode, the
 * same window an installed PWA gets). Chrome, Edge, Brave and Chromium support it; Safari and Firefox do not,
 * so without one of those the default browser opens a tab as before.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import open from 'open';

interface Browser {
  name: string;
  launch: (url: string) => void;
}

const detached = (cmd: string, args: string[]) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
};

function macBrowser(): Browser | undefined {
  const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi'];
  for (const name of apps) {
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const app = path.join(dir, `${name}.app`);
      // -n: a running browser ignores --args without it; Chrome hands the new window to the running instance
      if (fs.existsSync(app))
        return { name, launch: (url) => detached('open', ['-na', app, '--args', `--app=${url}`]) };
    }
  }
  return undefined;
}

function windowsBrowser(): Browser | undefined {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(
    Boolean
  ) as string[];
  const exes: Array<[string, string]> = [
    ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
    ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ['Chromium', 'Chromium\\Application\\chrome.exe'],
  ];
  for (const [name, rel] of exes) {
    for (const root of roots) {
      const exe = path.join(root, rel);
      if (fs.existsSync(exe)) return { name, launch: (url) => detached(exe, [`--app=${url}`]) };
    }
  }
  return undefined;
}

function linuxBrowser(): Browser | undefined {
  const cmds = [
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    'microsoft-edge-stable',
    'brave-browser',
    'chromium',
    'chromium-browser',
  ];
  for (const cmd of cmds) {
    if (spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0)
      return { name: cmd, launch: (url) => detached(cmd, [`--app=${url}`]) };
  }
  return undefined;
}

/** A Chromium-based browser that can open an app window, if one is installed. */
export function appWindowBrowser(): Browser | undefined {
  if (process.env.CREWTREE_NO_APP_WINDOW) return undefined;
  if (process.platform === 'darwin') return macBrowser();
  if (process.platform === 'win32') return windowsBrowser();
  return linuxBrowser();
}

/**
 * `app`: Crewtree's own window when a Chromium browser is installed, else a tab (`fallback`).
 * Returns how it opened.
 */
export async function openUi(url: string, mode: 'app' | 'browser'): Promise<'app' | 'browser' | 'fallback'> {
  const browser = mode === 'app' ? appWindowBrowser() : undefined;
  if (browser) {
    browser.launch(url);
    return 'app';
  }
  await open(url);
  return mode === 'app' ? 'fallback' : 'browser';
}
