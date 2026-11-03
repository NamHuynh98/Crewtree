// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { fileTouchesTable, sessionAgentsTable } from '../db/schema.js';
import { FileIndex } from '../files/FileIndex.js';
import fs from 'fs';
import path from 'path';
import { isInside, readFileView, resolveReadablePath, resolveWorkspaceRoot } from '../files/safeFiles.js';
import { fileDiff, type DiffBase } from '../files/SessionChanges.js';
import { MAX_PDF_BYTES, SCRATCH_SCOPE, UploadService } from '../uploads/UploadService.js';

async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const code = /not found/i.test(message)
      ? 404
      : /outside|not a known/i.test(message)
        ? 403
        : /too large/i.test(message)
          ? 413
          : 400;
    reply.code(code).send({ error: message });
    return undefined;
  }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

export interface FsSearchItem {
  path: string;
  type: 'file' | 'dir';
  /** Recently edited in this session (PLAN.md 8: files agents just changed come first) */
  recent?: { agent: string; ts: number };
}

/** Files edited in a session, newest first, with the agent that touched them. */
function recentTouches(sessionId: string, limit = 50): Map<string, { agent: string; ts: number }> {
  const rows = getDb()
    .select({
      path: fileTouchesTable.path,
      ts: fileTouchesTable.ts,
      agentName: sessionAgentsTable.agentName,
      alias: sessionAgentsTable.alias,
    })
    .from(fileTouchesTable)
    .leftJoin(sessionAgentsTable, eq(sessionAgentsTable.id, fileTouchesTable.sessionAgentId))
    .where(eq(fileTouchesTable.sessionId, sessionId))
    .orderBy(desc(fileTouchesTable.ts))
    .limit(limit * 4)
    .all();
  const out = new Map<string, { agent: string; ts: number }>();
  for (const r of rows) {
    if (out.size >= limit) break;
    if (!out.has(r.path)) out.set(r.path, { agent: r.alias || r.agentName || '?', ts: r.ts });
  }
  return out;
}

export function registerFileRoutes(fastify: FastifyInstance) {
  void fastify.register(fastifyMultipart, { limits: { fileSize: MAX_PDF_BYTES, files: 10 } });

  // `@` suggestions: fuzzy over the cwd honoring .gitignore (PLAN.md 8)
  fastify.get('/api/fs/search', async (req, reply) => {
    const {
      q = '',
      cwd,
      sessionId,
      limit,
    } = req.query as { q?: string; cwd?: string; sessionId?: string; limit?: string };
    return handle(reply, async () => {
      const root = resolveWorkspaceRoot({ cwd, sessionId });
      const max = Math.min(Math.max(Number(limit) || 30, 1), 100);
      const { hits, truncated } = await FileIndex.getInstance().search(root, q, max);
      const recent = sessionId ? recentTouches(sessionId) : new Map();
      const query = q.trim().toLowerCase();
      const recentItems: FsSearchItem[] = [...recent.entries()]
        .filter(([p]) => !query || p.toLowerCase().includes(query))
        .slice(0, 5)
        .map(([p, info]) => ({ path: p, type: 'file', recent: info }));
      const seen = new Set(recentItems.map((i) => i.path));
      const items: FsSearchItem[] = [
        ...recentItems,
        ...hits.filter((h) => !seen.has(h.path)).map((h) => ({ path: h.path, type: h.type })),
      ].slice(0, max);
      return { root, items, truncated };
    });
  });

  // Lazy file tree of the Files tab (PLAN.md 9)
  fastify.get('/api/fs/tree', async (req, reply) => {
    const { dir = '', cwd, sessionId } = req.query as { dir?: string; cwd?: string; sessionId?: string };
    return handle(reply, async () => {
      const root = resolveWorkspaceRoot({ cwd, sessionId });
      if (dir.split(/[\\/]/).includes('..')) throw new Error('Path is outside the allowed folders');
      return { root, ...(await FileIndex.getInstance().children(root, dir)) };
    });
  });

  // File Viewer diff: HEAD, a checkpoint, or the content before the session first touched it (PLAN.md 9)
  fastify.get('/api/fs/diff', async (req, reply) => {
    const {
      path: p,
      cwd,
      sessionId,
      base = 'session',
    } = req.query as {
      path?: string;
      cwd?: string;
      sessionId?: string;
      base?: string;
    };
    return handle(reply, async () => {
      if (!p) throw new Error('path is required');
      if (!/^(session|head|checkpoint:\d+)$/.test(base)) throw new Error('Invalid diff base');
      const root = resolveWorkspaceRoot({ cwd, sessionId });
      const abs = resolveReadablePath(root, p);
      if (!isInside(abs, root)) throw new Error('Diffs are only available inside the working directory');
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      return { path: rel, ...(await fileDiff(sessionId, root, rel, base as DiffBase)) };
    });
  });

  // Image preview in the File Viewer (PLAN.md 9). Images only, so no arbitrary file is served raw.
  fastify.get('/api/fs/raw', async (req, reply) => {
    const { path: p, cwd, sessionId } = req.query as { path?: string; cwd?: string; sessionId?: string };
    return handle(reply, async () => {
      if (!p) throw new Error('path is required');
      const abs = resolveReadablePath(resolveWorkspaceRoot({ cwd, sessionId }), p);
      const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
      if (!type) throw new Error('Only images can be previewed');
      const stat = fs.statSync(abs, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new Error('File not found');
      if (stat.size > 10 * 1024 * 1024) throw new Error('Image is too large to preview');
      reply
        .header('Content-Type', type)
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return reply.send(fs.createReadStream(abs));
    });
  });

  // Read-only file content for the `#` line picker and the File Viewer
  fastify.get('/api/fs/file', async (req, reply) => {
    const { path: p, cwd, sessionId } = req.query as { path?: string; cwd?: string; sessionId?: string };
    return handle(reply, () => {
      if (!p) throw new Error('path is required');
      return readFileView(resolveWorkspaceRoot({ cwd, sessionId }), p);
    });
  });

  // Composer attachments: button, paste, drop (PLAN.md 8)
  fastify.post('/api/uploads', async (req, reply) => {
    return handle(reply, async () => {
      if (!req.isMultipart()) throw new Error('Expected multipart/form-data');
      const uploads = UploadService.getInstance();
      const saved = [];
      let scope = SCRATCH_SCOPE;
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'sessionId' && typeof part.value === 'string' && part.value) {
            resolveWorkspaceRoot({ sessionId: part.value }); // must be a real session
            scope = part.value;
          }
          continue;
        }
        const data = await part.toBuffer();
        if (part.file.truncated) throw new Error(`${part.filename} is too large`);
        saved.push(uploads.save(scope, part.filename || 'file', part.mimetype, data));
      }
      if (!saved.length) throw new Error('No file uploaded');
      return { attachments: saved.map(({ path: _p, ...rest }) => rest) };
    });
  });

  fastify.delete('/api/uploads/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, () => {
      UploadService.getInstance().delete(id);
      return { status: 'deleted' };
    });
  });
}
