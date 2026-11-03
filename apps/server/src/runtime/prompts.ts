// SPDX-License-Identifier: Apache-2.0
// Runtime prompt additions of PLAN.md Appendix A.2 / A.3. Never written to the agent's .md file.
import { describeTaskFile } from '../uploads/composeMessage.js';

/** A.2 — every delegating node */
export const DELEGATION_RULES = `You can delegate. Rules:
- Delegate only to your direct children (list_agents). Spawn only agents from your allowed list.
- Every file-editing task must declare \`scope\`; running tasks must not have overlapping scopes.
- Keep instructions self-contained: goal, constraints, relevant files, expected output.
- Prefer parallel work for independent tasks. Do not do your children's work yourself.
- After delegating, call wait_for_tasks to collect results; answer child questions with answer_child.
- When your own task is finished, call complete_task with a summary of your children's results.`;

/** A.3 — static part for agents that receive tasks from a parent */
export const TASK_PROTOCOL = `You are part of a Crewtree session. Work arrives as messages that start with "[Crewtree task …]".
Task protocol:
- When the task is finished, call complete_task(summary, details?, files?). Keep the summary short and factual.
- If you are blocked by missing information, call ask_parent(question) instead of guessing, then end your turn; the answer arrives as your next message.
- Use report_progress for meaningful milestones on long tasks.
- Stay within the task scope. If you must touch other files, ask_parent first.`;

/** A.3 — Supervisor variant: its parent is the user */
export const SUPERVISOR_PROTOCOL = `You are the root of a Crewtree session; your parent is the user.
Your final message is shown to the user and closes the request automatically; use ask_parent to ask the user a question, then end your turn.`;

export interface TaskPromptInput {
  id: string;
  title: string;
  instructions: string;
  scope: string[];
  files: string[];
  parentName: string;
}

/** A.3 — per-task header, delivered with the task */
export function taskMessage(task: TaskPromptInput): string {
  const lines = [
    `[Crewtree task ${task.id}] Your parent: ${task.parentName}. Your current task: ${task.title}.`,
    `Scope: ${task.scope.length ? task.scope.join(', ') : '(none declared — ask_parent before editing files)'}`,
  ];
  if (task.files.length) lines.push('Attached files:', ...task.files.map(describeTaskFile));
  lines.push('', task.instructions, '', 'When finished call complete_task; if blocked call ask_parent.');
  return lines.join('\n');
}

export const NUDGE_MESSAGE =
  '[Crewtree] Your turn ended without finishing the task. Call complete_task (with a summary) or ask_parent (with a question).';

export function answerMessage(from: string, answer: string): string {
  return `[Crewtree] Answer from ${from}:\n${answer}`;
}

export function childFinishedNotice(agentName: string, taskId: string, status: string, summary: string): string {
  return `[Crewtree] Task ${taskId} of ${agentName} is ${status}.\nSummary: ${summary}\nUse get_task_result for the full result.`;
}

export function childQuestionNotice(agentName: string, taskId: string, question: string): string {
  return `[Crewtree] ${agentName} asks about task ${taskId}:\n${question}\nReply with answer_child.`;
}

export function parentMessage(from: string, message: string): string {
  return `[Crewtree] Message from ${from}:\n${message}`;
}
