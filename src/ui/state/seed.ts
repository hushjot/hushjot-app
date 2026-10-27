/**
 * First-run content, for a database that has never held a note.
 *
 * "Never held" is the operative word, and it is not the same as "is empty
 * now": deletion leaves a tombstone, so a user who cleared every note used to
 * look like a new one and got these back on the next reload. Nor is an empty
 * *local* database evidence of an empty account — that mistake wrote a second
 * copy of both of these onto every device that started from clean storage.
 *
 * `src/core/notes/firstRun.ts` holds the test that gets it right, and
 * `Workspace.completeFirstRun` is the only thing that writes these.
 *
 * It opens with five steps and only then the full tour: the note is the
 * manual, and a first-time user should reach "that is all you need" before
 * the reference starts. It stays one note rather than a short note plus a
 * guide because `tests/unit/shortcuts.test.ts` holds this text to naming
 * every app shortcut, and the first-run benches expect exactly two notes.
 *
 * Every shortcut here names both platforms, rather than being generated from
 * the running one. This is a note, not chrome: it is written once and then
 * syncs, so a copy seeded on a Mac would go on telling a Windows machine to
 * press ⌘ forever. The toolbar is where platform detection belongs.
 */

export const WELCOME_NOTE = `# Welcome to HushJot

A fast, private, local-first Markdown notepad. There is no Save button —
your text is kept as you type, and it survives a reload.

## Start here

1. Ctrl+J then N (⌘J then N on a Mac) starts a new note. Its first line is
   its title.
2. Ctrl+P (⌘P) finds any note by its title or its text.
3. Ctrl+\\ (⌘\\) opens a second note beside this one.
4. Ctrl+J then H shows this note's earlier versions.
5. Ctrl+J then Shift+A exports every note as a zip. Without sync, this
   browser holds the only copy, so keep one somewhere safe.

That is all you need. Everything below is the full tour — skim it now or come
back later — and F1 lists every command.

## Markdown works out of the box

**Bold**, _italic_, ~~strikethrough~~, \`inline code\` and [links](https://example.com).

- Bullet lists
- [x] Task lists
- [ ] Still to do

> Blockquotes, too.

## Format without typing the symbols

- Ctrl+B (⌘B on a Mac) makes text **bold**
- Ctrl+I (⌘I) makes it _italic_
- Ctrl+Shift+X (⌘⇧X) strikes it ~~through~~
- Ctrl+K (⌘K) makes a link

With text selected, each one wraps the selection, and pressing it again takes
the formatting off. With nothing selected inside a word, it formats the word.

Two more that need no shortcut at all: select some text and type \` * _ ~ or ' to
wrap it, and paste a web address over selected text to turn it into a link.

## Headings, lists and quotes

- Ctrl+Alt+1 to 6 (⌘⌥1 to 6 on a Mac) sets a heading; the same level again
  turns it back into plain text
- Ctrl+Shift+7 (⌘⇧7) numbers the selected lines
- Ctrl+Shift+8 (⌘⇧8) turns them into bullets
- Ctrl+Shift+9 (⌘⇧9) turns them into tasks
- Ctrl+Shift+. (⌘⇧.) quotes them
- Ctrl+Enter (⌘↩) ticks or unticks a task

Put the cursor on one of these and try Ctrl+Enter (⌘↩):

- [ ] Tick me
- [ ] And me

## Tables

Press Ctrl+Alt+T (⌘⌥T on a Mac) to insert one. Pick the size with the arrow
keys or the mouse, or just type it — 3x4 is three columns and four rows — then
press Enter.

| Feature | Status |
| --- | --- |
| Markdown | yes |
| Code highlighting | yes |
| Search | yes |

Inside a table, Tab and Shift+Tab move between cells and Enter moves down a
row. Each move lines the columns up again, and moving past the end adds a row.
Enter on an empty last row leaves the table.

## Fenced code highlights per language

Press Ctrl+E (⌘E on a Mac) to open a code fence. The cursor lands in the
language slot and a list appears — type a few letters, press Tab to pick, then
Enter to drop into the code.

\`\`\`rust
fn main() {
    println!("about 150 languages are recognised");
}
\`\`\`

\`\`\`python
for note in notes:
    print(note.title)
\`\`\`

\`\`\`sql
SELECT id, name
FROM customers
WHERE active = true;
\`\`\`

Rust, Python, TypeScript, Go, Java, Kotlin, Swift, C#, Ruby, PHP, Haskell,
Dockerfile, YAML — and roughly 140 more — all highlight. Grammars load only
when a fence that needs them appears, so startup stays fast. A fence labelled
mermaid is drawn as a diagram in the preview instead.

Already copied some code? Ctrl+Shift+V (⌘⇧V on a Mac) pastes it straight into
a fence. Or select any text and press Ctrl+E (⌘E) to wrap what is already there.

## Finding things

Press Ctrl+P (⌘P on a Mac) to search every note by title and content.
Searching happens entirely on your own device. Enter opens the note you pick;
Ctrl+Enter (⌘↩) opens it beside this one instead.

- Ctrl+F (⌘F) finds text inside this note
- Ctrl+\\ (⌘\\) picks a note to open beside this one — or Ctrl+J then T
- Ctrl+S (⌘S) syncs straight away — your text is already saved as you type
- F1, or Ctrl+Shift+P (⌘⇧P), lists every command with its shortcut. Typing >
  in Ctrl+P does the same.

## Linking notes

Put a note's title in double square brackets to link to it: \`[[Shopping]]\`,
or \`[[Shopping|the list]]\` to show different words. After typing [[ the
titles of your notes are offered. (Those two are in code quotes so they stay
examples; this one is real: [[Scratch]].)

Hold Ctrl (⌘ on a Mac) and click a link to follow it, or put the cursor on it
and press Ctrl+J then Shift+L (⌘J then ⇧L). In the preview a link is a button.
A link to a title that no note has yet offers to create that note.

## Pinning and tagging

Keep a note at the top of the list: hover it and press the pin, or press
Ctrl+J then Shift+P (⌘J then ⇧P on a Mac). Pinned notes lead every list — inside
a folder too — and come first in Ctrl+P. Editing one does not move it.

Type a # and a word anywhere in a note to tag it: \`#recipes\`, or
\`#work/clients\` to nest one tag inside another. (Those two are in code quotes
so they stay examples — a tag written plainly is a real one, as below.) Tags are
part of the text, so they travel with the note when you export it.

- Tagged notes gather under Tags in the sidebar; click one to see them
- Ctrl+J then Shift+T (⌘J then ⇧T) goes to a tag from the keyboard
- In Ctrl+P, \`#work\` narrows the search to that tag, and \`#work invoice\`
  combines the two
- After typing # and a letter or two, the tags you already use are offered
- In the preview, a tag is a button — press it to see the rest of its notes

A # only makes a tag when it starts a word: headings, [links](#anchor), colours
like #ff0000, numbers like #12 and anything inside code are left alone — none of
those five is a tag, and none of them is in the sidebar.

This note is tagged #getting-started, so look for it under Tags.

## Folders

Drag a note onto a folder to move it there, or a folder onto another folder to
nest it. Drop either on All notes to bring it back to the top level.

- Ctrl+J then F makes a new folder, Ctrl+J then Shift+F one inside this folder
- Ctrl+J then O goes to a folder, Ctrl+J then M moves this note into one
- Ctrl+J then Shift+M moves this folder, Ctrl+J then R renames it and
  Ctrl+J then Shift+D deletes it

## Sharing, history and export

- Ctrl+J then Shift+S shares this note by a private link; Ctrl+J then K lists
  every link you have shared
- Ctrl+J then H shows earlier versions of this note
- Ctrl+J then U brings back a note you deleted
- Ctrl+J then Shift+E exports this note as Markdown, Ctrl+J then Shift+A
  exports every note as a zip
- Ctrl+J then Shift+I opens export and import. Drop Markdown files or a zip
  anywhere on the window to import them.
- Without sync, this browser holds the only copy of your notes, and clearing
  browser data deletes them. Export now and then to keep a backup.

## One key, then another

Everything else is two quick presses: Ctrl+J (⌘J on a Mac), then one key. A
capital letter means hold Shift for it.

- Ctrl+J then N starts a new note, Ctrl+J then C copies this note's text and
  Ctrl+J then D deletes it
- Ctrl+J then J goes back to the note you had open before
- Ctrl+J then L moves to the note list: arrow keys, Home and End to choose,
  Space to peek, Enter to open, Ctrl+Enter (⌘↩) to open beside, Delete to
  delete, Esc to come back
- Ctrl+J then Z sorts the list by date edited, date created or title
- Ctrl+J then B hides or shows the sidebar
- Ctrl+J then Y turns focus mode on or off — everything but the note goes away
- Ctrl+J then E, S or P shows the editor, editor and preview, or preview
- Ctrl+J then 1 to 4 jumps between tiles, as do Ctrl+J then [ or ]
- Ctrl+J then W closes a tile and Ctrl+J then G changes how they are laid out
- Ctrl+J then A opens your account and sync settings
- Ctrl+J then X dismisses any notices on screen
- Ctrl+J then Q locks HushJot

Pause after Ctrl+J (⌘J) and a list of every key appears. Ctrl+J then ? shows
all of them with their shortcuts.

## Sizing and looks

- Ctrl+= (⌘= on a Mac) makes this text bigger
- Ctrl+- (⌘-) makes it smaller
- Ctrl+0 (⌘0) puts it back to normal

Or use the - 14 + buttons in the toolbar. Only the note text resizes — the
folder list and note titles stay as they are — and the size you pick is
remembered on this device.

- Ctrl+J then I switches between light and dark; Ctrl+J then Shift+O goes back
  to following your system
- Ctrl+J then , (comma) chooses the font, the text size and the line wrap
- Ctrl+J then Shift+W switches line wrap between the window's width and a
  fixed one
- Ctrl+J then V turns spellcheck on or off

## Shortcuts worth knowing

On a Mac, read ⌘ for Ctrl, ⌥ for Alt and ⇧ for Shift.

Formatting:

- Ctrl+B bold, Ctrl+I italic, Ctrl+Shift+X strikethrough, Ctrl+K link
- Ctrl+E opens a code fence, or wraps the selected text in one
- Ctrl+Shift+V pastes the clipboard into a code fence
- Select text and type \` * _ ~ or ' to wrap it

Structure:

- Ctrl+Alt+1 to 6 sets a heading
- Ctrl+Shift+7 numbered list, Ctrl+Shift+8 bullets
- Ctrl+Shift+9 task list, Ctrl+Enter ticks a task
- Ctrl+Shift+. blockquote
- Ctrl+Alt+T inserts a table; Tab and Shift+Tab move between cells

Moving around:

- Ctrl+P searches every note, Ctrl+F finds text in this note
- Ctrl+\\ opens a note beside this one, Ctrl+J then J goes back
- Ctrl+J then L goes to the note list, Ctrl+J then Shift+L follows a link
- Ctrl+J then O goes to a folder, Ctrl+J then Shift+T to a tag
- Ctrl+Shift+E switches between editor, split and preview

Everything else:

- Ctrl+N starts a new note — if your browser keeps that one, Ctrl+J then N
- Ctrl+S syncs now
- Ctrl+J then Shift+P pins or unpins a note
- Ctrl+J then ? (or F1) lists every shortcut there is
`;

export const SCRATCH_NOTE = `# Scratch

Paste anything here.
`;
