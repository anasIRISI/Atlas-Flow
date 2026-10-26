import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cn } from '../../components/ui/cn';

interface Props {
  value: string;
  onChange(value: string): void;
  /** Read once at mount (use refs for data that changes). */
  extensions: Extension[];
  className?: string;
  testId?: string;
  onBlur?(): void;
}

/** Minimal React wrapper around a CodeMirror 6 view. */
export function CodeMirror({ value, onChange, extensions, className, testId, onBlur }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...extensions,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({ blur: () => void onBlurRef.current?.() }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External changes (undo, drop, toggles) replace the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} data-testid={testId} className={cn('min-w-0 rounded-md border border-line-strong', className)} />;
}
