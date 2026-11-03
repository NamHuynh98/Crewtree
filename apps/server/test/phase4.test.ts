// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_PORT } from '@crewtree/shared';
import { createServer } from '../src/index.js';
import { createSessionCookie } from '../src/auth.js';
import { ProjectService } from '../src/projects/ProjectService.js';
import { FileIndex, fuzzyScore } from '../src/files/FileIndex.js';
import { readFileView, resolveReadablePath } from '../src/files/safeFiles.js';
import { composeMessage, toUserContent, attachmentMarker, describeTaskFile } from '../src/uploads/composeMessage.js';
import { UploadService } from '../src/uploads/UploadService.js';
import { parseGeneratedAgent, buildAgentPrompt } from '../src/generate/AgentGenerator.js';
import { TryItService, type TryItEvent } from '../src/tryit/TryItService.js';
import { getUploadsDir } from '../src/paths.js';
import { waitFor } from './helpers/tree.js';

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-p4-')));
const write = (rel: string, content: string | Buffer) => {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

beforeAll(() => {
  write('src/auth/auth.service.ts', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
  write('src/auth/auth.controller.ts', 'export class AuthController {}\n');
  write('src/pages/Login.tsx', 'export const Login = () => null;\n');
  write('node_modules/pkg/index.js', 'ignored');
  write('bin/blob.bin', Buffer.from([0, 1, 2, 3]));
  ProjectService.getInstance().open(project);
});

describe('file index (PLAN.md 8)', () => {
  it('ranks basename matches first and skips node_modules', async () => {
    const { hits } = await FileIndex.getInstance().search(project, 'authserv');
    expect(hits[0].path).toBe('src/auth/auth.service.ts');
    const all = await FileIndex.getInstance().search(project, '', 100);
    expect(all.hits.some((h) => h.path.includes('node_modules'))).toBe(false);
    expect(all.hits.some((h) => h.type === 'dir' && h.path === 'src/auth')).toBe(true);
  });

  it('fuzzy score requires characters in order', () => {
    expect(fuzzyScore('lgn', 'src/pages/login.tsx')).toBeGreaterThan(0);
    expect(fuzzyScore('zz', 'src/pages/login.tsx')).toBe(-1);
  });

  it('refuses paths outside the allowed folders and describes binaries', () => {
    expect(() => resolveReadablePath(project, '../../etc/passwd')).toThrow(/outside/);
    expect(() => resolveReadablePath(project, '/etc/hosts')).toThrow(/outside/);
    expect(readFileView(project, 'bin/blob.bin')).toMatchObject({ binary: true });
    expect(readFileView(project, 'bin/blob.bin').content).toBeUndefined();
    expect(readFileView(project, 'src/auth/auth.controller.ts').content).toContain('AuthController');
  });
});

describe('composer message (PLAN.md 8)', () => {
  it('turns chips into explicit references and embeds short ranges', () => {
    const text = composeMessage(
      { text: 'Update [[file:src/auth/auth.service.ts#L10-12]] per [[agent:analyst]] in [[dir:src/pages]] /review' },
      project
    );
    expect(text).toContain('Update `src/auth/auth.service.ts` (lines 10-12) per @analyst in `src/pages/` /review');
    expect(text).toContain('Referenced code:');
    expect(text).toContain('line 10\nline 11\nline 12');
    expect(text).not.toContain('line 13');
    expect(composeMessage({ text: 'see [[file:src/pages/Login.tsx]]' }, project)).toBe('see `src/pages/Login.tsx`');
  });

  it('embeds small text uploads and turns images into content blocks', () => {
    const uploads = UploadService.getInstance();
    const img = uploads.save('scratch', 'mock.png', 'image/png', PNG);
    const txt = uploads.save('scratch', 'notes.md', 'text/markdown', Buffer.from('# Notes\nhello'));
    const text = composeMessage({ text: 'Look', attachments: [img.id, txt.id, 'missing'] }, project);
    expect(text).toContain(attachmentMarker(img.path));
    expect(text).toContain('# Notes\nhello');

    const content = toUserContent(text);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as any[];
    expect(blocks[0]).toEqual({ type: 'text', text });
    expect(blocks[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(toUserContent('plain')).toBe('plain');
    // Markers outside the uploads folder are ignored
    expect(toUserContent(`[attachment: ${path.join(project, 'src/pages/Login.tsx')}]`)).toBeTypeOf('string');
    // delegate_task(files) keeps uploads as attachments for the child
    expect(describeTaskFile(img.path)).toBe(attachmentMarker(img.path));
    expect(describeTaskFile('src/a.ts')).toBe('src/a.ts');
  });

  it('rejects oversized images', () => {
    expect(() =>
      UploadService.getInstance().save('scratch', 'big.png', 'image/png', Buffer.alloc(6 * 1024 * 1024))
    ).toThrow(/too large/);
  });
});

describe('AI Generate parsing (Appendix A.4)', () => {
  it('extracts JSON, normalizes the name and drops invented tools', () => {
    const agent = parseGeneratedAgent(
      'Here you go:\n```json\n{"name":"API Reviewer","description":"d","systemPrompt":"p","suggestedTools":["Read","Teleport","mcp__github__x"],"canDelegate":false}\n```'
    );
    expect(agent.name).toBe('api-reviewer');
    expect(agent.suggestedTools).toEqual(['Read', 'mcp__github__x']);
    expect(agent.delegates).toBe('*');
    expect(() => parseGeneratedAgent('no json')).toThrow(/JSON/);
  });

  it('includes the current definition in Improve mode and the output language', () => {
    const prompt = buildAgentPrompt(
      {
        mode: 'improve',
        description: 'make it stricter',
        current: '---\nname: x\n---\nbody',
        attachments: [],
        uiLanguage: 'vi',
      },
      project
    );
    expect(prompt).toContain('Mode: Improve');
    expect(prompt).toContain('Output language: Vietnamese');
    expect(prompt).toContain('<current>');
  });
});

describe('Try it sandbox (PLAN.md 6.4)', () => {
  it('runs the agent and streams events (fake driver)', async () => {
    const service = TryItService.getInstance();
    const { id } = await service.start({
      content: '---\nname: tester\ncanDelegate: true\n---\nYou test.',
      cwd: project,
      allowWrites: false,
    });
    const events: TryItEvent[] = [];
    const unsubscribe = service.get(id).subscribe((e) => events.push(e));
    await service.get(id).send({ text: 'hello [[file:src/pages/Login.tsx]]' });
    await waitFor(() => events.some((e) => e.type === 'status' && e.data.status === 'idle' && events.indexOf(e) > 1));
    const texts = events
      .filter((e) => e.type === 'event' && e.data.type === 'agent.text.done')
      .map((e) => e.data.payload.text);
    expect(texts.join('')).toContain('hello `src/pages/Login.tsx`');
    unsubscribe();
    await service.stop(id);
    expect(() => service.get(id)).toThrow(/not found/);
  });
});

describe('Phase 4 API', () => {
  let app: FastifyInstance;
  const HOST = `127.0.0.1:${DEFAULT_PORT}`;
  const cookies = () => ({ crewtree_session: createSessionCookie() });

  beforeAll(async () => {
    app = await createServer();
  });
  afterAll(async () => {
    await app.close();
  });

  it('searches and reads files, refusing unknown cwds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/fs/search?q=login',
      headers: { host: HOST },
      cookies: cookies(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].path).toBe('src/pages/Login.tsx');

    const file = await app.inject({
      method: 'GET',
      url: `/api/fs/file?path=${encodeURIComponent('src/auth/auth.controller.ts')}`,
      headers: { host: HOST },
      cookies: cookies(),
    });
    expect(file.json().content).toContain('AuthController');

    const outside = await app.inject({
      method: 'GET',
      url: '/api/fs/file?path=../../etc/hosts',
      headers: { host: HOST },
      cookies: cookies(),
    });
    expect(outside.statusCode).toBe(403);
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/fs/search?q=a&cwd=${encodeURIComponent(os.tmpdir())}`,
      headers: { host: HOST },
      cookies: cookies(),
    });
    expect(unknown.statusCode).toBe(403);
  });

  it('uploads multipart files into the scratch folder', async () => {
    const boundary = '----crewtree';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { host: HOST, 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: cookies(),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const [att] = res.json().attachments;
    expect(att).toMatchObject({ name: 'shot.png', kind: 'image', mime: 'image/png' });
    expect(att.path).toBeUndefined();
    const stored = UploadService.getInstance().get(att.id)!;
    expect(stored.path.startsWith(path.join(getUploadsDir(), 'scratch'))).toBe(true);
  });

  it('streams AI Generate as server-sent events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/generate/agent',
      headers: { host: HOST },
      cookies: cookies(),
      payload: { mode: 'generate', description: 'A reviewer for SQL migrations' },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: delta');
    const resultLine = res.body.split('\n\n').find((chunk) => chunk.startsWith('event: result'))!;
    const result = JSON.parse(resultLine.split('\ndata: ')[1]);
    expect(result.agent.name).toBe('generated-agent');
    expect(result.agent.suggestedTools).not.toContain('MadeUpTool');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/generate/agent',
      headers: { host: HOST },
      cookies: cookies(),
      payload: { mode: 'improve' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
