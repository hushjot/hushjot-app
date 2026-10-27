/**
 * Fenced-code entry.
 *
 * Typing ```` ``` ````, a language, a newline and a closing ```` ``` ```` is four
 * fiddly motions for the one construct this notepad highlights specially, so
 * `Mod-e` does the whole thing. `Mod-e` rather than `Mod-i`: it is the "code"
 * shortcut in Slack, GitHub and Notion, and it leaves `Mod-i` for italic, which
 * `formatKeys.ts` binds.
 *
 * Two behaviours are deliberate.
 *
 * **The cursor lands in the language slot, not the body.** An untagged fence
 * gets no highlighting at all, so the slot is the valuable position. It costs
 * one extra Enter for a bare fence and saves a navigation round-trip on every
 * tagged one.
 *
 * **Enter always leaves the slot; Tab accepts a completion.** The usual
 * "Enter means accept when the popup is open" rule makes the same key do two
 * things depending on invisible state. `leaveLanguageSlot` owns Enter
 * unconditionally, which is why it can be bound ahead of the list-continuation
 * handler without ever stealing from it — it returns false unless the cursor is
 * in a slot this module itself created.
 *
 * That last point is why `fenceSlot` is a StateField rather than a regex test.
 * A line reading ```` ``` ```` may be an opener *or* a closer, and guessing wrong
 * would swallow a newline the user meant to insert. Tracking the slot we just
 * made removes the guess.
 *
 * Paste-as-fence (`Mod-Shift-v`) is NOT in the keymap, and must not be: a
 * keymap command returning true calls preventDefault on the keydown, which
 * cancels the browser's own paste and leaves no clipboard data to read. It is a
 * keydown handler that records intent and lets the default through, then the
 * paste handler reads `clipboardData` off the real event — no
 * `navigator.clipboard` permission prompt, and nothing async on the key path.
 *
 * Riding on the browser's paste is also what makes one code path serve both
 * platforms, which is why the detector takes Meta *or* Ctrl rather than the
 * platform's own modifier. On macOS ⌘⇧V is "paste as plain text" in Chrome,
 * Safari and Firefox — a real paste event with `text/plain` on it, so the
 * handler below sees exactly what Ctrl+Shift+V gives it elsewhere. The
 * corollary is that Ctrl+Shift+V on a Mac can never work: Ctrl is not the
 * paste modifier there, so no paste event is generated to intercept. The
 * welcome note in `src/ui/state/seed.ts` names both forms for that reason.
 */
import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, type Command } from '@codemirror/view';
import { startCompletion, closeCompletion } from '@codemirror/autocomplete';

const FENCE = '```';

/** Position of the fence body we just opened, or null when not in a slot. */
const setSlot = StateEffect.define<number>();
const clearSlot = StateEffect.define<null>();

export const fenceSlot = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSlot)) return effect.value;
      if (effect.is(clearSlot)) return null;
    }
    if (value === null) return null;

    const mapped = tr.changes.mapPos(value, -1);
    if (!tr.docChanged && !tr.selection) return mapped;

    // The slot is only live while the cursor is still on the opener line
    // directly above the body. Anything else — a click away, an edit
    // elsewhere — retires it, so Enter goes back to meaning Enter.
    const body = tr.state.doc.lineAt(mapped);
    if (body.number < 2) return null;
    const opener = tr.state.doc.line(body.number - 1);
    const head = tr.state.selection.main.head;
    return head >= opener.from && head <= opener.to ? mapped : null;
  },
});

/**
 * Build the replacement for a fence around `body`, along with the cursor
 * offset of the language slot. Fences sit at the enclosing indentation; the
 * body is left exactly as it came in, because re-indenting pasted code is how
 * you corrupt a Python snippet.
 */
export function fenceSpec(
  state: EditorState,
  from: number,
  to: number,
  body: string,
): TransactionSpec & { slot: number } {
  const line = state.doc.lineAt(from);
  const indent = /^[ \t]*/.exec(line.text)![0]!;

  // Start on a fresh line when there is real text to the left of the cursor.
  const before = state.doc.sliceString(line.from, from);
  const lead = before.trim().length > 0 ? `\n${indent}` : '';

  // Push any text to the right of the cursor below the closing fence.
  const after = state.doc.sliceString(to, state.doc.lineAt(to).to);
  const trail = after.trim().length > 0 ? `\n${indent}` : '';

  const inner = body.length > 0 ? body : indent;
  const insert = `${lead}${FENCE}\n${inner}\n${indent}${FENCE}${trail}`;

  // Immediately after the opening backticks.
  const slotPos = from + lead.length + FENCE.length;

  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(slotPos),
    // +1 steps over the newline that ends the opener line.
    slot: slotPos + 1,
    scrollIntoView: true,
    userEvent: 'input',
  };
}

function applyFence(view: EditorView, from: number, to: number, body: string): void {
  const { slot, ...spec } = fenceSpec(view.state, from, to, body);
  view.dispatch({ ...spec, effects: setSlot.of(slot) });
  // Show the language list straight away — it is the only thing in the product
  // that tells a user `kotlin` or `dockerfile` are available.
  startCompletion(view);
}

/**
 * Mod-e: wrap the selection in a fence, or open an empty one. Either way the
 * cursor ends up in the language slot.
 */
export const insertCodeFence: Command = (view) => {
  const range = view.state.selection.main;
  const body = range.empty ? '' : view.state.sliceDoc(range.from, range.to);
  applyFence(view, range.from, range.to, body);
  return true;
};

/**
 * Enter: step from the language slot down to the code body. Returns false
 * everywhere else, so list and blockquote continuation is untouched.
 */
export const leaveLanguageSlot: Command = (view) => {
  const slot = view.state.field(fenceSlot, false);
  if (slot == null) return false;

  const body = view.state.doc.lineAt(slot);
  closeCompletion(view);
  view.dispatch({
    selection: EditorSelection.cursor(body.to),
    effects: clearSlot.of(null),
    scrollIntoView: true,
  });
  return true;
};

/**
 * Mod-Shift-v intent. Set on keydown and consumed by the paste handler; any
 * other key clears it so a stale flag cannot fence an ordinary paste.
 */
let pasteAsCode = false;

const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt']);

export const fencePasteHandlers = EditorView.domEventHandlers({
  keydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'v' || event.key === 'V')) {
      pasteAsCode = true;
    } else if (!MODIFIERS.has(event.key)) {
      pasteAsCode = false;
    }
    // Never handled here: the browser's own paste must still fire.
    return false;
  },

  paste(event, view) {
    if (!pasteAsCode) return false;
    pasteAsCode = false;

    const text = event.clipboardData?.getData('text/plain');
    if (!text) return false;

    event.preventDefault();
    const range = view.state.selection.main;
    applyFence(view, range.from, range.to, text.replace(/\n+$/, ''));
    return true;
  },
});
