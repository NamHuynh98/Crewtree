// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { chipLabel } from './types';

const TOKEN_RE = /\[\[((?:file|dir|agent):[^\]\n]+)\]\]/g;

/** Optimistic text while the server composes the message: `[[file:a.ts#L1-2]]` → `a.ts#L1-2`. */
export function previewComposerText(text: string): string {
  return text.replace(TOKEN_RE, (_m, id: string) => chipLabel(id));
}

// Sections appended by the server's composeMessage (PLAN.md 8)
const SECTION_RE = /\n\n(Referenced code:|Attached files:)\n/;

/** A user message: the typed text, with embedded code and attachments folded away. */
export function UserMessageText({ text }: { text: string }) {
  const { t } = useTranslation();
  const m = SECTION_RE.exec(text);
  if (!m) return <div className="whitespace-pre-wrap">{text}</div>;
  const main = text.slice(0, m.index);
  const extra = text.slice(m.index + 2);
  const attachments = (extra.match(/^\[attachment: |^- \//gm) ?? []).length;
  return (
    <div>
      {main && <div className="whitespace-pre-wrap">{main}</div>}
      <details className="mt-1 text-[11px] opacity-90">
        <summary className="cursor-pointer select-none">
          {attachments ? t('chat.withAttachments', { count: attachments }) : t('chat.withReferencedCode')}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-2 font-mono text-[10px]">
          {extra}
        </pre>
      </details>
    </div>
  );
}
