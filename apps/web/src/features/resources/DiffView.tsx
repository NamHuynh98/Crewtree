// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';

/** Side-by-side diff (PLAN.md 6.3: always review the diff before saving). */
export function DiffView({ before, after, dark }: { before: string; after: string; dark?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const extensions = [
      markdown(),
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
    });
    return () => view.destroy();
  }, [before, after, dark]);
  return <div ref={ref} className="cm-diff text-xs [&_.cm-mergeView]:max-h-[60vh] [&_.cm-mergeView]:overflow-auto" />;
}
