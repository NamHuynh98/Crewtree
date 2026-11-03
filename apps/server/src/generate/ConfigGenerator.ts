// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { composeMessage } from '../uploads/composeMessage.js';
import { getAppSettings } from '../settings/appSettings.js';
import { ProjectService } from '../projects/ProjectService.js';
import { ResourceScanner } from '../resources/ResourceScanner.js';
import { resolveOutputLanguage } from './AgentGenerator.js';
import { FakeTextGenerator, SdkTextGenerator, type TextGenerator } from './TextGenerator.js';

export const GENERATE_KINDS = ['skill', 'command', 'memory', 'mcp', 'plugin'] as const;
export type GenerateKind = (typeof GENERATE_KINDS)[number];

export const ConfigGenerateRequestSchema = z.object({
  /** memory: add-rule | cleanup; others: generate | improve */
  mode: z.enum(['generate', 'improve', 'add-rule', 'cleanup']).default('generate'),
  description: z.string().default(''),
  current: z.string().optional(),
  attachments: z.array(z.string()).default([]),
  uiLanguage: z.enum(['en', 'vi']).default('en'),
});
export type ConfigGenerateRequest = z.infer<typeof ConfigGenerateRequestSchema>;

const FileSchema = z.object({ path: z.string().min(1), content: z.string() });

const name = z
  .string()
  .min(1)
  .transform((s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );

const RESULT_SCHEMAS = {
  skill: z.object({ name, description: z.string().default(''), files: z.array(FileSchema).min(1) }),
  command: z.object({ name, description: z.string().default(''), content: z.string().min(1) }),
  memory: z.object({ content: z.string(), summary: z.string().default('') }),
  mcp: z.object({
    name,
    config: z.object({
      type: z.enum(['stdio', 'http', 'sse']).default('stdio'),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string()).optional(),
    }),
    notes: z.string().default(''),
  }),
  plugin: z.object({ name, description: z.string().default(''), files: z.array(FileSchema).min(1) }),
} as const;

export type GeneratedConfig = { [K in GenerateKind]: z.infer<(typeof RESULT_SCHEMAS)[K]> };

const COMMON = `Answer with ONE JSON object and nothing else (no prose, no code fence). Write descriptions and prose in the requested output language; keep names, paths, code and config keys as they are.`;

/** Meta-prompts per kind (PLAN.md 6.4: same frame as A.4, different output format). */
export const META_PROMPTS: Record<GenerateKind, string> = {
  skill: `You write Claude Code skills (a folder with SKILL.md plus optional supporting files).
SKILL.md starts with YAML frontmatter: name (kebab-case) and description. The description decides WHEN Claude loads the skill: say what it does and when to use it, concretely, in 1-3 sentences. The body gives step-by-step instructions; put long references, templates or scripts in supporting files and point to them from SKILL.md.
Output: {"name": "...", "description": "...", "files": [{"path": "SKILL.md", "content": "---\\nname: ...\\ndescription: ...\\n---\\n..."}, {"path": "template.ts", "content": "..."}]}
Improve mode: keep the skill's name and intent, return every file you change or keep.
${COMMON}`,
  command: `You write Claude Code slash commands: one Markdown file whose body is the prompt run when the user types /name. Optional frontmatter: description, argument-hint, allowed-tools (only when the command must run specific tools), model. Use $ARGUMENTS (or $1, $2) where the user's arguments go.
Output: {"name": "kebab-case", "description": "...", "content": "full .md file including frontmatter"}
Improve mode: keep the command's name and intent.
${COMMON}`,
  memory: `You edit CLAUDE.md memory files of Claude Code: short, imperative rules and facts the agent must follow in this project, grouped under headings. Keep @import lines exactly as they are.
Mode add-rule: add the rule(s) the user asks for in the right section, without duplicating existing rules; change nothing else.
Mode cleanup: merge duplicates, remove contradictions and stale or vague rules, keep every still-valid instruction, keep @imports; do not invent rules.
Output: {"content": "the full new file", "summary": "one short sentence on what changed"}
${COMMON}`,
  mcp: `You write MCP server entries for Claude Code. Prefer the server's official package or URL. stdio: {"type":"stdio","command":"npx","args":["-y","<package>"],"env":{...}}; remote: {"type":"http","url":"...","headers":{...}}.
Never put real secrets in the config: use \${ENV_VAR} placeholders (for example "GITHUB_TOKEN": "\${GITHUB_TOKEN}") and say in notes which variables the user must set.
Output: {"name": "kebab-case", "config": {...}, "notes": "setup notes"}
${COMMON}`,
  plugin: `You scaffold Claude Code plugins. A plugin folder has .claude-plugin/plugin.json ({"name","description","version":"0.1.0","author":{"name": "..."}}) and any of: skills/<skill>/SKILL.md, commands/*.md, agents/*.md, hooks/hooks.json, .mcp.json. Keep it minimal: only the components the description needs, each one working.
Output: {"name": "kebab-case", "description": "...", "files": [{"path": ".claude-plugin/plugin.json", "content": "..."}, ...]}
${COMMON}`,
};

function existingNames(kind: GenerateKind): string {
  const scannerKind = kind === 'plugin' ? 'plugin' : kind;
  const names = ResourceScanner.getInstance()
    .list(scannerKind)
    .map((i) => i.name)
    .slice(0, 80);
  return names.length ? names.join(', ') : '(none)';
}

export function buildConfigPrompt(kind: GenerateKind, req: ConfigGenerateRequest, cwd: string): string {
  const sections = [`Kind: ${kind}`, `Mode: ${req.mode}`, `Output language: ${resolveOutputLanguage(req.uiLanguage)}`];
  if (kind !== 'memory') sections.push(`Existing ${kind} names (avoid clashes): ${existingNames(kind)}`);
  if (req.current) sections.push(`Current content:\n<current>\n${req.current}\n</current>`);
  sections.push(
    `User request:\n${composeMessage({ text: req.description || '(no extra instructions)', attachments: req.attachments }, cwd)}`
  );
  return sections.join('\n\n');
}

export function parseGeneratedConfig<K extends GenerateKind>(kind: K, raw: string): GeneratedConfig[K] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return a JSON object');
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('The model returned invalid JSON');
  }
  const parsed = RESULT_SCHEMAS[kind].safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Unexpected result: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
    );
  }
  const result = parsed.data as any;
  // Supporting paths must stay inside the new folder
  if (result.files) {
    result.files = result.files.filter(
      (f: { path: string }) => !f.path.startsWith('/') && !f.path.split(/[\\/]/).includes('..')
    );
    if (kind === 'skill' && !result.files.some((f: { path: string }) => f.path === 'SKILL.md')) {
      throw new Error('The generated skill has no SKILL.md');
    }
  }
  return result;
}

function fakeAnswer(req: { prompt: string }): string {
  const kind = /^Kind: (\w+)/m.exec(req.prompt)?.[1] as GenerateKind;
  switch (kind) {
    case 'skill':
      return JSON.stringify({
        name: 'generated-skill',
        description: 'Does the thing',
        files: [
          { path: 'SKILL.md', content: '---\nname: generated-skill\ndescription: Does the thing\n---\nSteps.\n' },
        ],
      });
    case 'command':
      return JSON.stringify({
        name: 'generated-command',
        description: 'Runs it',
        content: '---\ndescription: Runs it\n---\nDo $ARGUMENTS\n',
      });
    case 'memory':
      return JSON.stringify({ content: '# Rules\n- Generated rule\n', summary: 'Added a rule' });
    case 'mcp':
      return JSON.stringify({
        name: 'generated-mcp',
        config: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
        notes: '',
      });
    default:
      return JSON.stringify({
        name: 'generated-plugin',
        description: 'A plugin',
        files: [{ path: '.claude-plugin/plugin.json', content: '{"name":"generated-plugin","version":"0.1.0"}' }],
      });
  }
}

/** AI Generate for skills, commands, memory, MCP and plugin scaffolds (PLAN.md 6.4). */
export class ConfigGenerator {
  private static instance: ConfigGenerator;
  private generator: TextGenerator =
    process.env.CREWTREE_DRIVER === 'fake' ? new FakeTextGenerator(fakeAnswer) : new SdkTextGenerator();

  public static getInstance(): ConfigGenerator {
    if (!ConfigGenerator.instance) ConfigGenerator.instance = new ConfigGenerator();
    return ConfigGenerator.instance;
  }

  public setGenerator(generator: TextGenerator) {
    this.generator = generator;
  }

  public async generate<K extends GenerateKind>(
    kind: K,
    req: ConfigGenerateRequest,
    opts: { onDelta?: (text: string) => void; signal?: AbortSignal } = {}
  ): Promise<{ result: GeneratedConfig[K]; model: string }> {
    const model = getAppSettings().models.defaults.generate;
    const raw = await this.generator.generate({
      systemPrompt: META_PROMPTS[kind],
      prompt: buildConfigPrompt(kind, req, ProjectService.getInstance().currentPath()),
      model,
      onDelta: opts.onDelta,
      signal: opts.signal,
    });
    return { result: parseGeneratedConfig(kind, raw), model };
  }
}
