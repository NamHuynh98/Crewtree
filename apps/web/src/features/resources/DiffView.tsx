// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';

/** Side-by-side diff (PLAN.md 6.3: always review the diff before saving). */
export function DiffView({
  before,
  after,
  dark,
  language,
  fill,
}: {
  before: string;
  after: string;
  dark?: boolean;
  /** Syntax for the file (default: markdown, for agent and resource files) */
  language?: Extension[];
  /** Fill the parent's height instead of capping at 60vh (File Viewer) */
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const extensions = [
      ...(language ?? [markdown()]),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];
    if (dark) extensions.push(EditorView.theme({}, { dark: true }));
    const view = new MergeView({
      a: { doc: before, extensions },
      b: { doc: after, extensions },
      parent: ref.current,
      collapseUnchanged: { margin: 3, minSize: 6 },
      // The default scanLimit (500) gives up on ordinary source files and marks everything as changed
      diffConfig: { scanLimit: 20_000, timeout: 1500 },
    });
    return () => view.destroy();
  }, [before, after, dark, language]);
  return (
    <div
      ref={ref}
      className={`cm-diff text-xs [&_.cm-mergeView]:overflow-auto ${fill ? 'h-full [&_.cm-mergeView]:h-full' : '[&_.cm-mergeView]:max-h-[60vh]'}`}
    />
  );
}
