/**
 * Spike 5, variant A — critical path using `@codemirror/lang-markdown`.
 * Establishes the baseline the lean variant is compared against.
 */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { codeLanguages } from '../../src/editor/languages.ts';
import { registerLazyProbes } from './probes.ts';

const view = new EditorView({
  state: EditorState.create({
    doc: '# HushJot\n',
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ codeLanguages }),
    ],
  }),
  parent: document.body,
});

registerLazyProbes(view);
