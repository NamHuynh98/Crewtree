// SPDX-License-Identifier: Apache-2.0
import { parse as parseYaml } from 'yaml';
import { AgentFrontmatter, AgentFrontmatterSchema } from '@crewtree/shared';

export interface ParsedAgentSnapshot {
  frontmatter: AgentFrontmatter;
  systemPrompt: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Splits an agent `.md` snapshot into frontmatter and body (the system prompt).
 * Full resource parsing/writing lives in resources/ (Phase 3); runtime only needs this.
 */
export function parseAgentSnapshot(snapshot: string, fallbackName = 'agent'): ParsedAgentSnapshot {
  const match = FRONTMATTER_RE.exec(snapshot);
  if (!match) {
    return {
      frontmatter: AgentFrontmatterSchema.parse({ name: fallbackName }),
      systemPrompt: snapshot.trim(),
    };
  }

  let raw: Record<string, unknown> = {};
  try {
    raw = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  } catch (err) {
    console.warn(`[agentDefinition] Invalid frontmatter for "${fallbackName}":`, err);
  }

  let result = AgentFrontmatterSchema.safeParse({ name: fallbackName, ...raw });
  if (!result.success) {
    // Drop only the invalid fields: one bad value must not silently reset canDelegate, model, tools…
    const bad = new Set(result.error.issues.map((i) => String(i.path[0] ?? '')));
    console.warn(`[agentDefinition] "${fallbackName}": ignoring invalid frontmatter field(s) ${[...bad].join(', ')}`);
    const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k)));
    result = AgentFrontmatterSchema.safeParse({ name: fallbackName, ...kept });
  }
  return {
    frontmatter: result.success ? result.data : AgentFrontmatterSchema.parse({ name: fallbackName }),
    systemPrompt: match[2].trim(),
  };
}

/** `tools: Read, Grep` or `tools: [Read, Grep]` → string[]; undefined means "inherit all tools". */
export function normalizeToolList(tools: AgentFrontmatter['tools']): string[] | undefined {
  if (tools === undefined) return undefined;
  const list = Array.isArray(tools) ? tools : tools.split(',');
  return list.map((t) => t.trim()).filter(Boolean);
}
