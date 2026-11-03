// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { attachmentsTable } from '../db/schema.js';
import { getUploadsDir } from '../paths.js';
import { isBinary } from '../files/safeFiles.js';

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'binary';

export interface Attachment {
  id: string;
  /** Session id, or `scratch` for uploads outside a session (Try it, AI Generate) */
  scope: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  kind: AttachmentKind;
}

/** Image content blocks accepted by the model (PLAN.md 8). */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SCRATCH_SCOPE = 'scratch';

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

export function mimeFor(name: string, declared?: string): string {
  const byExt = EXT_MIME[path.extname(name).toLowerCase()];
  if (byExt) return byExt;
  return declared && declared !== 'application/octet-stream' ? declared : 'application/octet-stream';
}

export function kindFor(mime: string, buf: Buffer): AttachmentKind {
  if (IMAGE_MIMES.includes(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return isBinary(buf) ? 'binary' : 'text';
}

function safeName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^\w.\- ]+/g, '_')
    .trim();
  return base.slice(-120) || 'file';
}

function scopeDir(scope: string): string {
  if (!/^[\w-]+$/.test(scope)) throw new Error('Invalid upload scope');
  return path.join(getUploadsDir(), scope);
}

/** Attachments stored under `~/.crewtree/uploads/<session>/` (PLAN.md 8, 21). */
export class UploadService {
  private static instance: UploadService;

  public static getInstance(): UploadService {
    if (!UploadService.instance) UploadService.instance = new UploadService();
    return UploadService.instance;
  }

  public save(scope: string, filename: string, declaredMime: string | undefined, data: Buffer): Attachment {
    const name = safeName(filename);
    const mime = mimeFor(name, declaredMime);
    const kind = kindFor(mime, data);
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : kind === 'pdf' ? MAX_PDF_BYTES : MAX_FILE_BYTES;
    if (data.length > limit) {
      throw new Error(`${name} is too large (${Math.round(data.length / 1024)} KB; limit ${limit / 1024 / 1024} MB)`);
    }
    const dir = scopeDir(scope);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = nanoid(12);
    const filePath = path.join(dir, `${id}-${name}`);
    fs.writeFileSync(filePath, data, { mode: 0o600 });
    getDb()
      .insert(attachmentsTable)
      .values({ id, sessionId: scope, filename: name, mime, size: data.length, path: filePath })
      .run();
    return { id, scope, name, mime, size: data.length, path: filePath, kind };
  }

  public get(id: string): Attachment | undefined {
    const row = getDb().select().from(attachmentsTable).where(eq(attachmentsTable.id, id)).get();
    if (!row || !fs.existsSync(row.path)) return undefined;
    const head = Buffer.alloc(8000);
    const fd = fs.openSync(row.path, 'r');
    const n = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    return {
      id: row.id,
      scope: row.sessionId,
      name: row.filename,
      mime: row.mime,
      size: row.size,
      path: row.path,
      kind: kindFor(row.mime, head.subarray(0, n)),
    };
  }

  public delete(id: string): void {
    const row = getDb().select().from(attachmentsTable).where(eq(attachmentsTable.id, id)).get();
    if (!row) return;
    fs.rmSync(row.path, { force: true });
    getDb().delete(attachmentsTable).where(eq(attachmentsTable.id, id)).run();
  }

  /** Removes a session's uploads when the session is deleted (PLAN.md 21). */
  public removeScope(scope: string): void {
    fs.rmSync(scopeDir(scope), { recursive: true, force: true });
    getDb().delete(attachmentsTable).where(eq(attachmentsTable.sessionId, scope)).run();
  }
}
