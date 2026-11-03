// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { getUploadsDir } from '../paths.js';
import { isInside, readFileView } from '../files/safeFiles.js';
import { UploadService, IMAGE_MIMES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, type Attachment } from './UploadService.js';

/**
 * Composer chips travel as tokens inside the text (PLAN.md 8):
 *   [[file:src/auth.ts#L10-24]]  [[file:src/auth.ts]]  [[dir:src/auth]]  [[agent:analyst]]
 * `/skill` stays plain text — Claude Code expands slash commands itself.
 */
export const TOKEN_RE = /\[\[(file|dir|agent):([^\]#\n]+)(?:#L(\d+)(?:-(\d+))?)?\]\]/g;

/** Line ranges up to this length are embedded next to the reference. */
export const EMBED_MAX_LINES = 80;
/** Small text attachments are embedded instead of only linked. */
export const EMBED_MAX_TEXT_BYTES = 16 * 1024;

/** Marker the driver turns into an image/document content block (see toUserContent). */
export function attachmentMarker(absPath: string): string {
  return `[attachment: ${absPath}]`;
}
const MARKER_RE = /^\[attachment: (.+)\]/;

function fence(content: string, file: string): string {
  const lang = path.extname(file).slice(1);
  const ticks = content.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${content.replace(/\n$/, '')}\n${ticks}`;
}

function fmtSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface ComposeInput {
  text: string;
  attachments?: string[];
}

/**
 * Turns Composer output into the plain text an agent receives: chips become explicit references
 * (`src/auth.ts (lines 10-24)`), short ranges and small text files are embedded, images and PDFs
 * become attachment markers.
 */
export function composeMessage(input: ComposeInput, cwd: string): string {
  const snippets: string[] = [];
  const body = input.text.replace(TOKEN_RE, (_m, type: string, target: string, from?: string, to?: string) => {
    const name = target.trim();
    if (type === 'agent') return `@${name}`;
    if (type === 'dir') return `\`${name}/\``;
    if (!from) return `\`${name}\``;
    const start = Number(from);
    const end = Math.max(start, Number(to ?? from));
    const label = start === end ? `line ${start}` : `lines ${start}-${end}`;
    if (end - start + 1 <= EMBED_MAX_LINES) {
      try {
        const view = readFileView(cwd, name);
        if (view.content !== undefined) {
          const lines = view.content
            .split(/\r?\n/)
            .slice(start - 1, end)
            .join('\n');
          snippets.push(`${name} (${label}):\n${fence(lines, name)}`);
        }
      } catch {
        // Missing or unreadable file: keep the reference only
      }
    }
    return `\`${name}\` (${label})`;
  });

  const parts = [body.trim()];
  if (snippets.length) parts.push(`Referenced code:\n\n${snippets.join('\n\n')}`);

  const uploads = UploadService.getInstance();
  const attached = (input.attachments ?? []).map((id) => uploads.get(id)).filter((a): a is Attachment => !!a);
  if (attached.length) {
    const lines = attached.map((a) => {
      if (a.kind === 'image' || a.kind === 'pdf')
        return `${attachmentMarker(a.path)} ${a.name} (${a.mime}, ${fmtSize(a.size)})`;
      if (a.kind === 'text' && a.size <= EMBED_MAX_TEXT_BYTES) {
        return `- ${a.path} (${fmtSize(a.size)}):\n${fence(fs.readFileSync(a.path, 'utf8'), a.name)}`;
      }
      return `- ${a.path} (${a.mime}, ${fmtSize(a.size)})`;
    });
    parts.push(`Attached files:\n${lines.join('\n')}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** How a task's `files` are listed for a child: uploads stay attachments, other paths stay paths. */
export function describeTaskFile(p: string): string {
  return isInside(path.resolve(p), getUploadsDir()) ? attachmentMarker(path.resolve(p)) : p;
}

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

/**
 * Text with attachment markers → SDK user content: the text stays as is (so the agent can still pass
 * the paths on), each image/PDF under the uploads folder is added as a content block.
 * Plain text without markers is returned unchanged.
 */
export function toUserContent(text: string): string | UserContentBlock[] {
  if (!text.includes('[attachment: ')) return text;
  const blocks: UserContentBlock[] = [];
  const uploadsDir = getUploadsDir();
  for (const line of text.split('\n')) {
    const m = MARKER_RE.exec(line.trim());
    if (!m) continue;
    const abs = path.resolve(m[1]);
    if (!isInside(abs, uploadsDir)) continue;
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.pdf'
              ? 'application/pdf'
              : ['.jpg', '.jpeg'].includes(ext)
                ? 'image/jpeg'
                : '';
    if (IMAGE_MIMES.includes(mime) && stat.size <= MAX_IMAGE_BYTES) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: fs.readFileSync(abs).toString('base64') },
      });
    } else if (mime === 'application/pdf' && stat.size <= MAX_PDF_BYTES) {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(abs).toString('base64') },
      });
    }
  }
  return blocks.length ? [{ type: 'text', text }, ...blocks] : text;
}
