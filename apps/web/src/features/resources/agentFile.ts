// SPDX-License-Identifier: Apache-2.0
import { parseDocument } from 'yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)([\s\S]*)$/;

export interface AgentFields {
  name: string;
  description: string;
  model?: string;
  tools?: string[]; // undefined = inherits every tool
  color?: string;
  icon?: string;
  canDelegate: boolean;
  delegates: '*' | string[];
  maxTurns?: number;
  skills: string[];
  mcpServers: string[];
  role?: string;
  freshContextPerTask: boolean;
}

export function splitAgentFile(content: string): { yaml: string; body: string } {
  const match = FRONTMATTER_RE.exec(content.replace(/\r\n/g, '\n'));
  return match ? { yaml: match[1], body: match[3] } : { yaml: '', body: content };
}

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

/** Form view of an agent `.md` (PLAN.md 6.2); unknown keys are kept untouched in the file. */
export function readAgentFields(content: string): { fields: AgentFields; body: string; error?: string } {
  const { yaml, body } = splitAgentFile(content);
  const doc = parseDocument(yaml);
  const error = doc.errors[0]?.message;
  const fm = (doc.toJS() ?? {}) as Record<string, unknown>;
  return {
    body: body.replace(/^\n/, ''),
    error,
    fields: {
      name: String(fm.name ?? ''),
      description: String(fm.description ?? ''),
      model: fm.model === undefined ? undefined : String(fm.model),
      tools: fm.tools === undefined ? undefined : list(fm.tools),
      color: fm.color === undefined ? undefined : String(fm.color),
      icon: fm.icon === undefined ? undefined : String(fm.icon),
      canDelegate: fm.canDelegate === true,
      delegates: fm.delegates === '*' || fm.delegates === undefined ? '*' : list(fm.delegates),
      maxTurns: typeof fm.maxTurns === 'number' ? fm.maxTurns : undefined,
      skills: list(fm.skills),
      mcpServers: list(fm.mcpServers),
      role: fm.role === undefined ? undefined : String(fm.role),
      freshContextPerTask: fm.freshContextPerTask === true,
    },
  };
}

type Patch = { [K in keyof AgentFields]?: AgentFields[K] | undefined | null } & { body?: string };

/** Applies form changes to the file, keeping key order, comments and unknown keys. `null` removes a key. */
export function patchAgentFile(content: string, patch: Patch): string {
  const { yaml, body } = splitAgentFile(content);
  const doc = parseDocument(yaml);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'body') continue;
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0 && key !== 'tools')) {
      doc.delete(key);
    } else if (key === 'tools' && Array.isArray(value)) {
      doc.set(key, value.join(', ')); // Claude Code style: "Read, Grep, Glob"
    } else if (key === 'canDelegate' || key === 'freshContextPerTask') {
      if (value) doc.set(key, true);
      else doc.delete(key);
    } else {
      doc.set(key, value);
    }
  }
  const out = doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  const nextBody = patch.body !== undefined ? patch.body : body.replace(/^\n/, '');
  return `---\n${out}\n---\n${nextBody.endsWith('\n') ? nextBody : `${nextBody}\n`}`;
}

export function newAgentTemplate(name = 'new-agent'): string {
  return `---\nname: ${name}\ndescription: Describe when to delegate work to this agent.\nmodel: sonnet\ntools: Read, Grep, Glob\n---\nYou are ${name}.\n`;
}

/** Claude Code built-in tools offered in the editor (UI-WIREFRAMES 8). */
export const EDITOR_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'MultiEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
];
export const AGENT_COLORS = ['violet', 'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink'];
