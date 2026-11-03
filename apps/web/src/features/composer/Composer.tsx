// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import {
  AtSign,
  FileText,
  Folder,
  Image,
  Paperclip,
  Send,
  Slash,
  Square,
  X,
  Bot,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LinePicker } from './LinePicker';
import { mentionItems, slashItems, uploadFiles } from './sources';
import {
  chipId,
  chipLabel,
  tokenFor,
  type ComposerAttachment,
  type ComposerContext,
  type ComposerSendPayload,
  type SuggestionItem,
} from './types';

/** Imperative handle: insert a file chip from outside (File Viewer "Mention in chat"). */
export interface ComposerHandle {
  insertFile: (path: string, range?: { start: number; end: number }) => void;
  focus: () => void;
}

export interface ComposerProps {
  ctx: ComposerContext;
  onSend: (payload: ComposerSendPayload) => void | Promise<unknown>;
  /** Agent names offered after `@` */
  agents?: string[];
  /** `/` skills and commands (off in AI Generate) */
  enableSlash?: boolean;
  placeholder?: string;
  /** "Send to: Supervisor" */
  target?: string;
  /** The receiving agent is busy: show Interrupt & send / Stop */
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  /** Compact layout (AI Generate panel) */
  compact?: boolean;
  /** Hide the send button (the parent renders its own actions) */
  hideSend?: boolean;
  /** Reports the current payload whenever it changes (parent-driven submit) */
  onChange?: (payload: Omit<ComposerSendPayload, 'mode'>) => void;
  autoFocus?: boolean;
  /** Clear the text and attachments after sending (off in AI Generate, so a description can be rerun) */
  clearOnSend?: boolean;
  handleRef?: React.Ref<ComposerHandle>;
}

interface PopupState {
  char: '@' | '/';
  items: SuggestionItem[];
  index: number;
  rect: DOMRect | null;
  command: (attrs: { id: string; label: string }) => void;
  query: string;
}

const ICONS: Record<SuggestionItem['kind'], React.ComponentType<{ className?: string }>> = {
  file: FileText,
  dir: Folder,
  agent: Bot,
  skill: Sparkles,
  command: Terminal,
};

function groupOf(item: SuggestionItem): 'recent' | 'files' | 'agents' | 'skill' | 'command' {
  if (item.recent) return 'recent';
  if (item.kind === 'file' || item.kind === 'dir') return 'files';
  return item.kind === 'agent' ? 'agents' : item.kind;
}

function timeAgo(ts: number): string {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/** Shared message input (PLAN.md 8, UI-WIREFRAMES 3): TipTap with chips, attachments, paste/drop. */
export function Composer({
  ctx,
  onSend,
  agents = [],
  enableSlash = true,
  placeholder,
  target,
  busy,
  onStop,
  disabled,
  compact,
  hideSend,
  onChange,
  autoFocus,
  clearOnSend = true,
  handleRef,
}: ComposerProps) {
  const { t } = useTranslation();
  const [popup, setPopup] = useState<PopupState | null>(null);
  const popupRef = useRef<PopupState | null>(null);
  const [linePick, setLinePick] = useState<{
    path: string;
    range?: { start: number; end: number };
    command?: PopupState['command'];
  } | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isEmpty, setIsEmpty] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  // Latest props for callbacks created once inside TipTap
  const live = useRef({ ctx, agents, onSend, busy, disabled, attachments, onChange, clearOnSend });
  live.current = { ctx, agents, onSend, busy, disabled, attachments, onChange, clearOnSend };

  const updatePopup = (next: PopupState | null) => {
    popupRef.current = next;
    setPopup(next);
  };

  const suggestionFor = (char: '@' | '/') => ({
    char,
    allowSpaces: false,
    items: async ({ query }: { query: string }) =>
      char === '@' ? mentionItems(live.current.ctx, query, live.current.agents) : slashItems(query),
    render: () => ({
      onStart: (props: SuggestionProps<SuggestionItem>) =>
        updatePopup({
          char,
          items: props.items,
          index: 0,
          rect: props.clientRect?.() ?? null,
          command: props.command,
          query: props.query,
        }),
      onUpdate: (props: SuggestionProps<SuggestionItem>) =>
        updatePopup({
          char,
          items: props.items,
          index: 0,
          rect: props.clientRect?.() ?? null,
          command: props.command,
          query: props.query,
        }),
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        const p = popupRef.current;
        if (!p) return false;
        if (event.key === 'Escape') {
          updatePopup(null);
          return true;
        }
        if (!p.items.length) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          updatePopup({ ...p, index: (p.index + delta + p.items.length) % p.items.length });
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = p.items[p.index];
          // Tab on a file opens the line picker (preview); Enter inserts directly
          if (event.key === 'Tab' && item.kind === 'file') {
            setLinePick({ path: item.value, range: item.range, command: p.command });
            updatePopup(null);
            return true;
          }
          p.command({ id: chipId(item), label: chipLabel(chipId(item)) });
          return true;
        }
        return false;
      },
      onExit: () => updatePopup(null),
    }),
  });

  const submit = useCallback((mode: 'queue' | 'interrupt' = 'queue') => {
    const editor = editorRef.current;
    if (!editor || live.current.disabled) return;
    const text = editor.getText({ blockSeparator: '\n' }).trim();
    const atts = live.current.attachments;
    if (atts.some((a) => a.uploading)) return;
    const ids = atts.filter((a) => a.id && !a.error).map((a) => a.id!);
    if (!text && !ids.length) return;
    void live.current.onSend({ text, attachments: ids, mode });
    if (!live.current.clearOnSend) return;
    editor.commands.clearContent(true);
    for (const a of atts) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setAttachments([]);
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const pending: ComposerAttachment[] = files.map((f) => ({
      key: `${Date.now()}-${Math.random()}`,
      name: f.name,
      uploading: true,
      previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }));
    setAttachments((prev) => [...prev, ...pending]);
    await Promise.all(
      files.map(async (file, i) => {
        const key = pending[i].key;
        try {
          const [saved] = await uploadFiles(live.current.ctx, [file]);
          setAttachments((prev) =>
            prev.map((a) => (a.key === key ? { ...a, id: saved.id, kind: saved.kind, uploading: false } : a))
          );
        } catch (err: any) {
          setAttachments((prev) =>
            prev.map((a) => (a.key === key ? { ...a, uploading: false, error: err.message } : a))
          );
        }
      })
    );
  }, []);

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      History,
      Placeholder.configure({ placeholder: placeholder ?? t('composer.placeholder') }),
      Mention.configure({
        HTMLAttributes: { class: 'composer-chip' },
        renderText: ({ node }) => tokenFor(node.attrs.id),
        renderHTML: ({ node }) => [
          'span',
          {
            class: `composer-chip composer-chip-${String(node.attrs.id).split(':')[0]}`,
            'data-id': node.attrs.id,
            title: node.attrs.id,
          },
          node.attrs.label ?? chipLabel(node.attrs.id),
        ],
        suggestions: enableSlash ? [suggestionFor('@'), suggestionFor('/')] : [suggestionFor('@')],
      }),
      Extension.create({
        name: 'composerKeys',
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              if (popupRef.current) return false;
              submit('queue');
              return true;
            },
            'Shift-Enter': () => this.editor.commands.setHardBreak(),
            'Mod-Enter': () => {
              if (popupRef.current) return false;
              submit('queue');
              return true;
            },
          };
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: `composer-editor outline-none text-xs leading-relaxed ${compact ? 'min-h-[56px]' : 'min-h-[40px]'} max-h-48 overflow-y-auto px-3 py-2`,
        'aria-label': placeholder ?? t('composer.placeholder'),
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length) return false;
        void addFiles(files);
        return true;
      },
      // Clicking a file chip reopens the line picker for it
      handleClickOn: (_view, _pos, node, nodePos) => {
        if (node.type.name !== 'mention' || !String(node.attrs.id).startsWith('file:')) return false;
        const [p, r] = String(node.attrs.id).slice(5).split('#L');
        const [s, e] = (r ?? '').split('-').map(Number);
        setLinePick({
          path: p,
          range: s ? { start: s, end: e || s } : undefined,
          command: (attrs) =>
            editorRef.current
              ?.chain()
              .focus()
              .deleteRange({ from: nodePos, to: nodePos + node.nodeSize })
              .insertContentAt(nodePos, [{ type: 'mention', attrs: { ...attrs, mentionSuggestionChar: '@' } }])
              .run(),
        });
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      setIsEmpty(editor.isEmpty);
    },
    autofocus: autoFocus ? 'end' : false,
  });
  editorRef.current = editor;

  useImperativeHandle(
    handleRef,
    () => ({
      insertFile: (path, range) => {
        const id = chipId({ kind: 'file', value: path, range });
        editorRef.current
          ?.chain()
          .focus('end')
          .insertContent([
            { type: 'mention', attrs: { id, label: chipLabel(id), mentionSuggestionChar: '@' } },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      focus: () => editorRef.current?.commands.focus('end'),
    }),
    []
  );

  // Report changes for parent-driven submit (AI Generate)
  useEffect(() => {
    if (!editor || !onChange) return;
    const report = () =>
      live.current.onChange?.({
        text: editor.getText({ blockSeparator: '\n' }).trim(),
        attachments: live.current.attachments.filter((a) => a.id && !a.error).map((a) => a.id!),
      });
    report();
    editor.on('update', report);
    return () => {
      editor.off('update', report);
    };
  }, [editor, onChange, attachments]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const insertTrigger = (char: '@' | '/') => {
    if (!editor) return;
    const { from } = editor.state.selection;
    const before = from > 1 ? editor.state.doc.textBetween(from - 1, from, '\n', ' ') : '';
    editor
      .chain()
      .focus()
      .insertContent(before && !/\s/.test(before) ? ` ${char}` : char)
      .run();
  };

  const insertPicked = (range?: { start: number; end: number }) => {
    if (!linePick) return;
    const id = chipId({ kind: 'file', value: linePick.path, range });
    if (linePick.command) linePick.command({ id, label: chipLabel(id) });
    else
      editor
        ?.chain()
        .focus()
        .insertContent([
          { type: 'mention', attrs: { id, label: chipLabel(id), mentionSuggestionChar: '@' } },
          { type: 'text', text: ' ' },
        ])
        .run();
    setLinePick(null);
    editor?.commands.focus();
  };

  const removeAttachment = (a: ComposerAttachment) => {
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setAttachments((prev) => prev.filter((x) => x.key !== a.key));
    if (a.id) void fetch(`/api/uploads/${a.id}`, { method: 'DELETE' });
  };

  const canSend =
    !disabled && (!isEmpty || attachments.some((a) => a.id && !a.error)) && !attachments.some((a) => a.uploading);

  return (
    <div
      className={`relative rounded-lg border bg-background ${dragOver ? 'border-primary ring-2 ring-primary/30' : 'border-input'} focus-within:ring-2 focus-within:ring-ring`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      {/* Suggestion popup above the caret */}
      {popup && (
        <div
          className="fixed z-50 w-[420px] max-w-[90vw] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
          style={{
            left: Math.min(popup.rect?.left ?? 0, window.innerWidth - 430),
            top: (popup.rect?.top ?? 0) - 6,
            transform: 'translateY(-100%)',
          }}
          role="listbox"
        >
          <div className="border-b border-border px-3 py-1 text-[10px] font-mono text-muted-foreground">
            {popup.char} {popup.query}
          </div>
          {popup.items.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('composer.noMatches')}</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {popup.items.map((item, i) => {
                const Icon = ICONS[item.kind];
                const group = groupOf(item);
                const showHeader = i === 0 || groupOf(popup.items[i - 1]) !== group;
                return (
                  <li key={`${item.kind}:${item.value}`}>
                    {showHeader && (
                      <div className="px-3 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t(`composer.group.${group}`)}
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === popup.index}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        popup.command({ id: chipId(item), label: chipLabel(chipId(item)) });
                      }}
                      onMouseEnter={() => updatePopup({ ...popup, index: i })}
                      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${i === popup.index ? 'bg-accent text-accent-foreground' : ''}`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="max-w-[65%] shrink-0 truncate font-mono">
                        {item.kind === 'agent'
                          ? `@${item.value}`
                          : item.kind === 'skill' || item.kind === 'command'
                            ? `/${item.value}`
                            : item.value}
                        {item.range && (
                          <span className="text-primary">
                            #L{item.range.start}
                            {item.range.end !== item.range.start && `-${item.range.end}`}
                          </span>
                        )}
                      </span>
                      {item.recent && (
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          ✎ {item.recent.agent} · {timeAgo(item.recent.ts)}
                        </span>
                      )}
                      {item.detail && !item.recent && (
                        <span className="ml-auto min-w-0 flex-1 truncate pl-2 text-right text-[10px] text-muted-foreground">
                          {item.detail}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
            {popup.char === '@' ? t('composer.mentionHint') : t('composer.slashHint')}
          </div>
        </div>
      )}

      {linePick && (
        <LinePicker
          ctx={ctx}
          path={linePick.path}
          initial={linePick.range}
          onInsert={insertPicked}
          onCancel={() => {
            setLinePick(null);
            editor?.commands.focus();
          }}
        />
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2">
          {attachments.map((a) => (
            <span
              key={a.key}
              className={`inline-flex max-w-[220px] items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${a.error ? 'border-red-400 text-red-600 dark:text-red-400' : 'border-border bg-muted'}`}
              title={a.error ?? a.name}
            >
              {a.previewUrl ? (
                <img src={a.previewUrl} alt="" className="h-4 w-4 rounded object-cover" />
              ) : a.kind === 'image' ? (
                <Image className="h-3 w-3" />
              ) : (
                <FileText className="h-3 w-3" />
              )}
              <span className="truncate">{a.name}</span>
              {a.uploading && <span className="text-muted-foreground">…</span>}
              <button
                type="button"
                onClick={() => removeAttachment(a)}
                aria-label={t('composer.removeAttachment', { name: a.name })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <EditorContent editor={editor} />

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => fileInput.current?.click()}
          title={t('composer.attach')}
          aria-label={t('composer.attach')}
          disabled={disabled}
        >
          <Paperclip />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => insertTrigger('@')}
          title={t('composer.mention')}
          aria-label={t('composer.mention')}
          disabled={disabled}
        >
          <AtSign />
        </Button>
        {enableSlash && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => insertTrigger('/')}
            title={t('composer.slash')}
            aria-label={t('composer.slash')}
            disabled={disabled}
          >
            <Slash />
          </Button>
        )}
        {target && (
          <span className="ml-2 min-w-0 truncate text-[11px] text-muted-foreground">
            {t('composer.sendTo', { name: target })}
          </span>
        )}
        {/* With a target the footer is tight: the key hint moves to the send button tooltip */}
        <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
          {!target && t('composer.keysHint')}
        </span>
        {!hideSend && (
          <>
            {busy && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  disabled={!canSend}
                  onClick={() => submit('interrupt')}
                >
                  {t('chat.interruptAndSend')}
                </Button>
                {onStop && (
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    className="h-7 w-7"
                    onClick={onStop}
                    title={t('chat.interrupt')}
                    aria-label={t('chat.interrupt')}
                  >
                    <Square />
                  </Button>
                )}
              </>
            )}
            <Button
              type="button"
              size="icon"
              className="h-7 w-7"
              disabled={!canSend}
              onClick={() => submit('queue')}
              title={`${t('chat.send')} · ${t('composer.keysHint')}`}
              aria-label={t('chat.send')}
            >
              <Send />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
