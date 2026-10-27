/**
 * Spike 5, variant B — critical path using the lean markdown support built
 * directly on `@lezer/markdown`, avoiding the lang-html/css/javascript chain.
 */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdownLean } from '../../src/editor/markdownLean.ts';
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
      markdownLean({ codeLanguages }),
    ],
  }),
  parent: document.body,
});

registerLazyProbes(view);
