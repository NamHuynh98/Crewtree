// SPDX-License-Identifier: Apache-2.0
import {
  CLAUDE_CODE_TOOLS,
  GeneratedAgentSchema,
  type GenerateAgentRequest,
  type GeneratedAgent,
} from '@crewtree/shared';
import { composeMessage } from '../uploads/composeMessage.js';
import { getAppSettings } from '../settings/appSettings.js';
import { ResourceScanner } from '../resources/ResourceScanner.js';
import { ProjectService } from '../projects/ProjectService.js';
import { FakeTextGenerator, SdkTextGenerator, type TextGenerator } from './TextGenerator.js';

const LANGUAGE_NAMES = { en: 'English', vi: 'Vietnamese' } as const;

/** Appendix A.4 — meta-prompt for agent definitions. */
export const AGENT_META_PROMPT = `You are an expert at writing Claude Code subagent definitions.

You receive: the user's description of the agent they want, optional sample files, the current definition (Improve mode), the tools and agents that exist, and the output language.

Answer with ONE JSON object and nothing else (no prose, no code fence):
{
  "name": "kebab-case name, unique among the existing agents unless improving that agent",
  "description": "1-2 sentences that say WHEN work should be delegated to this agent (this text decides whether the agent gets picked)",
  "systemPrompt": "Markdown system prompt: role, workflow, constraints, output format",
  "suggestedTools": ["minimal set of tools the agent needs"],
  "suggestedModel": "opus | sonnet | haiku | inherit",
  "canDelegate": false,
  "delegates": "*" or ["agent names it may delegate to"]
}

Rules:
- Only use tools from the available tool list; never invent tools.
- Do not grant Bash or Write unless the description clearly needs running commands or creating files.
- Prefer haiku for narrow, mechanical work, sonnet for most coding work, opus for planning and coordination.
- canDelegate is true only for coordinators that split work across other agents; then list delegates from the existing agents when sensible.
- Improve mode: keep the original intent, name and structure; change only what the request asks for or what is clearly weak.
- Write description and systemPrompt in the requested output language. Keep tool and agent names as they are.`;

export function resolveOutputLanguage(uiLanguage: 'en' | 'vi'): string {
  const setting = getAppSettings().ai.generatedContentLanguage;
  return LANGUAGE_NAMES[setting === 'follow' ? uiLanguage : setting];
}

export function buildAgentPrompt(req: GenerateAgentRequest, cwd: string): string {
  const agents = ResourceScanner.getInstance()
    .list('agent')
    .filter((a) => !a.shadowedBy)
    .map((a) => `- ${a.name}: ${a.description.slice(0, 160)}`);
  const sections = [
    `Mode: ${req.mode === 'improve' ? 'Improve the current definition' : 'Generate a new agent'}`,
    `Output language: ${resolveOutputLanguage(req.uiLanguage)}`,
    `Available tools: ${CLAUDE_CODE_TOOLS.join(', ')}`,
    `Existing agents:\n${agents.join('\n') || '(none)'}`,
  ];
  if (req.mode === 'improve' && req.current)
    sections.push(`Current definition (.md):\n<current>\n${req.current}\n</current>`);
  sections.push(
    `User request:\n${composeMessage({ text: req.description || '(no extra instructions)', attachments: req.attachments }, cwd)}`
  );
  return sections.join('\n\n');
}

/** Pulls the JSON object out of the model's answer (tolerates code fences or stray prose). */
export function parseGeneratedAgent(raw: string): GeneratedAgent {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return a JSON object');
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('The model returned invalid JSON');
  }
  const parsed = GeneratedAgentSchema.safeParse(data);
  if (!parsed.success)
    throw new Error(
      `Unexpected result: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`
    );
  const known = new Set<string>(CLAUDE_CODE_TOOLS);
  return {
    ...parsed.data,
    // Never pass on invented tools (A.4); MCP tools keep their mcp__ prefix
    suggestedTools: [...new Set(parsed.data.suggestedTools.filter((t) => known.has(t) || t.startsWith('mcp__')))],
  };
}

function fakeAnswer(req: { prompt: string }): string {
  const improve = /^Mode: Improve/m.test(req.prompt);
  return JSON.stringify({
    name: improve ? 'improved-agent' : 'generated-agent',
    description: 'Use for the task described by the user (offline fake generator).',
    systemPrompt:
      '# Role\nYou are a focused helper.\n\n## Workflow\n1. Read the relevant files.\n2. Report findings briefly.',
    suggestedTools: ['Read', 'Grep', 'Glob', 'MadeUpTool'],
    suggestedModel: 'haiku',
    canDelegate: false,
    delegates: '*',
  });
}

/** AI Generate for agents: one tool-less model call, streamed (PLAN.md 6.4). */
export class AgentGenerator {
  private static instance: AgentGenerator;
  private generator: TextGenerator =
    process.env.CREWTREE_DRIVER === 'fake' ? new FakeTextGenerator(fakeAnswer) : new SdkTextGenerator();

  public static getInstance(): AgentGenerator {
    if (!AgentGenerator.instance) AgentGenerator.instance = new AgentGenerator();
    return AgentGenerator.instance;
  }

  /** Tests swap the generator. */
  public setGenerator(generator: TextGenerator) {
    this.generator = generator;
  }

  public async generate(
    req: GenerateAgentRequest,
    opts: { onDelta?: (text: string) => void; signal?: AbortSignal } = {}
  ): Promise<{ agent: GeneratedAgent; raw: string; model: string }> {
    const model = getAppSettings().models.defaults.generate;
    const raw = await this.generator.generate({
      systemPrompt: AGENT_META_PROMPT,
      prompt: buildAgentPrompt(req, ProjectService.getInstance().currentPath()),
      model,
      onDelta: opts.onDelta,
      signal: opts.signal,
    });
    return { agent: parseGeneratedAgent(raw), raw, model };
  }
}

export { fakeAnswer as fakeAgentAnswer };
