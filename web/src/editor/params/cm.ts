import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { EditorView, Decoration, keymap, lineNumbers, MatchDecorator, placeholder as cmPlaceholder, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { api } from '../../lib/api';
import { EXPRESSION_HELPERS, EXPRESSION_VARIABLES } from '../../lib/expressions';

export const editorTheme = EditorView.theme(
  {
    '&': { color: 'var(--color-fg)', backgroundColor: 'var(--color-panel-2)', fontSize: '13px', borderRadius: '6px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--color-accent-hover)', padding: '6px 0' },
    '.cm-line': { padding: '0 8px' },
    '&.cm-focused': { outline: '1px solid var(--color-accent)' },
    '.cm-gutters': { backgroundColor: 'var(--color-panel)', color: 'var(--color-subtle)', border: 'none', borderRadius: '6px 0 0 6px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(240,89,42,0.30) !important' },
    '.cm-placeholder': { color: 'var(--color-subtle)' },
    '.cm-tooltip': { backgroundColor: 'var(--color-panel-3)', border: '1px solid var(--color-line-strong)', color: 'var(--color-fg)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--color-accent-soft)', color: 'var(--color-fg)' },
    '.cm-completionDetail': { color: 'var(--color-subtle)', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-ff-resolvable': { backgroundColor: 'rgba(78,161,255,0.14)', color: '#9cc8ff', borderRadius: '3px' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c792ea' },
  { tag: [t.string, t.special(t.string)], color: '#a5d6a7' },
  { tag: [t.number, t.bool, t.null], color: '#f9b872' },
  { tag: t.comment, color: '#6e6e7e', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: t.propertyName, color: '#b4c7ff' },
  { tag: t.variableName, color: '#ececf1' },
  { tag: t.operator, color: '#89ddff' },
]);

/** Highlights {{ … }} blocks in an expression. */
const resolvableHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private matcher = new MatchDecorator({ regexp: /\{\{[\s\S]*?\}\}/g, decoration: Decoration.mark({ class: 'cm-ff-resolvable' }) });
    constructor(view: EditorView) {
      this.decorations = this.matcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = this.matcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Typing "{{" inserts "{{  }}" with the cursor in the middle, like n8n. */
const autoCloseBraces = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '{' || view.state.sliceDoc(from - 1, from) !== '{') return false;
  view.dispatch({ changes: { from, to, insert: '{  }}' }, selection: { anchor: from + 2 } });
  return true;
});

/** What autocomplete knows about the data around the node being edited. */
export interface CompletionData {
  /** First input item's JSON (for $json.…). */
  input?: Record<string, unknown>;
  /** Executed nodes and a sample of their output (for $('Node').…). */
  nodes: Record<string, Record<string, unknown> | undefined>;
}

function readPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), obj);
}

function fieldOptions(sample: unknown): Completion[] {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return [];
  return Object.entries(sample as Record<string, unknown>).map(([key, value]) => ({
    label: key,
    type: 'property',
    detail: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
    apply: /^[A-Za-z_$][\w$]*$/.test(key) ? key : undefined,
  }));
}

const method = (label: string, info: string): Completion => ({ label, type: 'method', detail: info });
const NODE_METHODS = [method('item', 'paired item'), method('first()', 'first item'), method('last()', 'last item'), method('all()', 'all items'), method('isExecuted', 'boolean'), method('params', 'parameters')];
const INPUT_METHODS = [method('item', 'current item'), method('first()', 'first item'), method('last()', 'last item'), method('all()', 'all items'), method('params', 'parameters')];

/** Keys of the Variables page, fetched lazily and cached for 15 s (for $vars.<key>). */
let variableKeys: string[] = [];
let variablesFetchedAt = 0;
export function setKnownVariableKeys(keys: string[]) {
  variableKeys = keys;
  variablesFetchedAt = Date.now();
}
function refreshVariableKeys() {
  if (Date.now() - variablesFetchedAt < 15_000) return;
  variablesFetchedAt = Date.now();
  api<Array<{ key: string }>>('/variables')
    .then((list) => {
      variableKeys = list.map((v) => v.key);
    })
    .catch(() => undefined);
}

export function expressionCompletions(getData: () => CompletionData) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(0, context.pos);
    if (before.lastIndexOf('{{') <= before.lastIndexOf('}}')) return null;
    const token = context.matchBefore(/[\w$.'"()[\]]*$/);
    if (!token) return null;
    const text = token.text;
    const data = getData();
    let m: RegExpExecArray | null;

    if (text.includes('$v')) refreshVariableKeys();
    if ((m = /\$vars\.([\w$]*)$/.exec(text))) {
      return {
        from: context.pos - m[1]!.length,
        options: variableKeys.map((key) => ({ label: key, type: 'variable', detail: 'variable' })),
        validFor: /^[\w$]*$/,
      };
    }
    if ((m = /\$json((?:\.[\w$]+)*)\.([\w$]*)$/.exec(text))) {
      return { from: context.pos - m[2]!.length, options: fieldOptions(readPath(data.input, m[1]!.slice(1))), validFor: /^[\w$]*$/ };
    }
    if ((m = /\$\(['"]([^'"]+)['"]\)\.(?:item|first\(\)|last\(\))\.json((?:\.[\w$]+)*)\.([\w$]*)$/.exec(text))) {
      return { from: context.pos - m[3]!.length, options: fieldOptions(readPath(data.nodes[m[1]!], m[2]!.slice(1))), validFor: /^[\w$]*$/ };
    }
    if ((m = /\$input\.(?:item|first\(\)|last\(\))\.json((?:\.[\w$]+)*)\.([\w$]*)$/.exec(text))) {
      return { from: context.pos - m[2]!.length, options: fieldOptions(readPath(data.input, m[1]!.slice(1))), validFor: /^[\w$]*$/ };
    }
    if ((m = /\$\(['"]([^'"]*)$/.exec(text))) {
      const quote = text[text.length - m[1]!.length - 1];
      return {
        from: context.pos - m[1]!.length,
        options: Object.keys(data.nodes).map((name) => ({ label: name, type: 'variable', apply: `${name}${quote})` })),
      };
    }
    if ((m = /\$\(['"][^'"]+['"]\)\.([\w]*)$/.exec(text))) return { from: context.pos - m[1]!.length, options: NODE_METHODS };
    if ((m = /\$input\.([\w]*)$/.exec(text))) return { from: context.pos - m[1]!.length, options: INPUT_METHODS };
    if ((m = /(\$[\w]*)$/.exec(text)) && !text.slice(0, -m[1]!.length).endsWith('.')) {
      return {
        from: context.pos - m[1]!.length,
        options: EXPRESSION_VARIABLES.map((v) => ({ label: v.label, detail: v.info, type: 'variable', apply: v.apply ?? v.label })),
      };
    }
    if ((m = /\.([\w]*)$/.exec(text))) {
      const seen = new Set<string>();
      const options = EXPRESSION_HELPERS.filter((h) => (seen.has(h.name) ? false : (seen.add(h.name), true))).map((h) => ({
        label: `${h.name}()`,
        detail: `${h.on} · ${h.info}`,
        type: 'function',
      }));
      return { from: context.pos - m[1]!.length, options };
    }
    return null;
  };
}

export function expressionExtensions(getData: () => CompletionData, placeholder?: string): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    resolvableHighlighter,
    autoCloseBraces,
    autocompletion({ override: [expressionCompletions(getData)], icons: false }),
    keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap]),
    editorTheme,
    ...(placeholder ? [cmPlaceholder(placeholder)] : []),
  ];
}

function codeCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\$?[\w]*$/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const options: Completion[] = [
    { label: '$input.all()', type: 'function', detail: 'all input items' },
    { label: '$input.first()', type: 'function', detail: 'first input item' },
    { label: '$input.item', type: 'variable', detail: 'current item (each item mode)' },
    { label: '$json', type: 'variable', detail: 'current item JSON (each item mode)' },
    { label: "$('Node name').all()", type: 'function', detail: 'items of another node' },
    { label: '$workflow', type: 'variable' },
    { label: '$execution', type: 'variable' },
    { label: 'console.log()', type: 'function' },
    { label: 'return', type: 'keyword' },
  ];
  return { from: word.from, options };
}

export function codeExtensions(language: 'javascript' | 'json'): Extension[] {
  return [
    lineNumbers(),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    language === 'json' ? json() : javascript(),
    syntaxHighlighting(highlight),
    ...(language === 'javascript' ? [autocompletion({ override: [codeCompletions] })] : []),
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
    editorTheme,
  ];
}
