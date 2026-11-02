// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';

/** Write to a temp file then rename, retrying on Windows where editors/antivirus may hold the file (PLAN.md 6.3, 16.6). */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err: any) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** attempt); // sync sleep
    }
  }
}
