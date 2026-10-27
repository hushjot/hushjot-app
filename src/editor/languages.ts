/**
 * Lazy code-grammar registry for fenced code blocks (§10, §28).
 *
 * Every entry loads its grammar through a dynamic import, so none of them are
 * in the startup bundle. A grammar is fetched the first time a fence naming it
 * appears in a note, and cached by CodeMirror thereafter.
 *
 * Covers the language list in spec §10. Languages without a dedicated
 * CodeMirror 6 package use `@codemirror/legacy-modes`, which is smaller than
 * the grammars themselves and equally lazy.
 */
import { LanguageDescription, StreamLanguage } from '@codemirror/language';

/** Wrap a legacy stream mode as a LanguageDescription. */
function legacy(
  name: string,
  alias: string[],
  load: () => Promise<StreamLanguage<unknown>>,
): LanguageDescription {
  return LanguageDescription.of({
    name,
    alias,
    async load() {
      const lang = await load();
      const { LanguageSupport } = await import('@codemirror/language');
      return new LanguageSupport(lang);
    },
  });
}

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'node', 'mjs', 'cjs'],
    extensions: ['js', 'mjs', 'cjs'],
    async load() {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript();
    },
  }),
  LanguageDescription.of({
    name: 'typescript',
    alias: ['ts'],
    extensions: ['ts'],
    async load() {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({ typescript: true });
    },
  }),
  LanguageDescription.of({
    name: 'jsx',
    alias: ['tsx'],
    async load() {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({ jsx: true, typescript: true });
    },
  }),
  LanguageDescription.of({
    name: 'python',
    alias: ['py'],
    extensions: ['py'],
    async load() {
      const { python } = await import('@codemirror/lang-python');
      return python();
    },
  }),
  LanguageDescription.of({
    name: 'rust',
    alias: ['rs'],
    extensions: ['rs'],
    async load() {
      const { rust } = await import('@codemirror/lang-rust');
      return rust();
    },
  }),
  LanguageDescription.of({
    name: 'sql',
    alias: ['postgres', 'postgresql', 'psql', 'mysql', 'sqlite'],
    async load() {
      const { sql } = await import('@codemirror/lang-sql');
      return sql();
    },
  }),
  LanguageDescription.of({
    name: 'json',
    alias: ['jsonc'],
    extensions: ['json'],
    async load() {
      const { json } = await import('@codemirror/lang-json');
      return json();
    },
  }),
  LanguageDescription.of({
    name: 'yaml',
    alias: ['yml'],
    extensions: ['yaml', 'yml'],
    async load() {
      const { yaml } = await import('@codemirror/lang-yaml');
      return yaml();
    },
  }),
  LanguageDescription.of({
    name: 'xml',
    extensions: ['xml'],
    async load() {
      const { xml } = await import('@codemirror/lang-xml');
      return xml();
    },
  }),
  LanguageDescription.of({
    name: 'html',
    alias: ['htm'],
    extensions: ['html', 'htm'],
    async load() {
      const { html } = await import('@codemirror/lang-html');
      return html();
    },
  }),
  LanguageDescription.of({
    name: 'css',
    extensions: ['css'],
    async load() {
      const { css } = await import('@codemirror/lang-css');
      return css();
    },
  }),
  LanguageDescription.of({
    name: 'java',
    extensions: ['java'],
    async load() {
      const { java } = await import('@codemirror/lang-java');
      return java();
    },
  }),
  LanguageDescription.of({
    name: 'go',
    alias: ['golang'],
    extensions: ['go'],
    async load() {
      const { go } = await import('@codemirror/lang-go');
      return go();
    },
  }),
  LanguageDescription.of({
    name: 'cpp',
    alias: ['c', 'c++', 'h', 'hpp'],
    extensions: ['c', 'cc', 'cpp', 'h', 'hpp'],
    async load() {
      const { cpp } = await import('@codemirror/lang-cpp');
      return cpp();
    },
  }),

  // --- legacy stream modes: no dedicated CM6 package exists -----------------
  legacy('shell', ['bash', 'sh', 'zsh', 'console'], async () => {
    const { shell } = await import('@codemirror/legacy-modes/mode/shell');
    const { StreamLanguage } = await import('@codemirror/language');
    return StreamLanguage.define(shell);
  }),
  legacy('powershell', ['ps1', 'pwsh'], async () => {
    const { powerShell } = await import('@codemirror/legacy-modes/mode/powershell');
    const { StreamLanguage } = await import('@codemirror/language');
    return StreamLanguage.define(powerShell);
  }),
  legacy('csharp', ['cs', 'c#'], async () => {
    const { csharp } = await import('@codemirror/legacy-modes/mode/clike');
    const { StreamLanguage } = await import('@codemirror/language');
    return StreamLanguage.define(csharp);
  }),
  legacy('kotlin', ['kt', 'kts'], async () => {
    const { kotlin } = await import('@codemirror/legacy-modes/mode/clike');
    const { StreamLanguage } = await import('@codemirror/language');
    return StreamLanguage.define(kotlin);
  }),
  legacy('swift', [], async () => {
    const { swift } = await import('@codemirror/legacy-modes/mode/swift');
    const { StreamLanguage } = await import('@codemirror/language');
    return StreamLanguage.define(swift);
  }),
  legacy('toml', [], async () => {
    const { toml } = await import('@codemirror/legacy-modes/mode/toml');
    const { StreamLanguage } = await import('@codemirror/language');
    return StreamLanguage.define(toml);
  }),
];

/**
 * The long tail, resolved on demand.
 *
 * The list above is hand-tuned because its aliases matter: `psql`, `c#`, `kts`
 * and `console` are what people actually type, and the stock catalogue does not
 * carry all of them. Everything *else* — php, ruby, dockerfile, lua, haskell,
 * clojure, diff and ~130 more — comes from `@codemirror/language-data`, which
 * is 3.4 KB gzipped and reached only through this dynamic import. A note that
 * never names an unusual language never downloads it.
 *
 * Callers must memoise the result: see the note on `resolved`/`pending` in
 * `markdownLean.ts`, which explains why a fresh promise per lookup would spin.
 */
export async function findInCatalogue(
  name: string,
): Promise<LanguageDescription | null> {
  const { languages } = await import('@codemirror/language-data');
  return LanguageDescription.matchLanguageName(languages, name, true);
}
