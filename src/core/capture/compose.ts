/**
 * What a share from the operating system becomes, as Markdown.
 *
 * Android's share sheet hands over three optional fields — `title`, `text`,
 * `url` — and the apps that fill them do not agree on which is which. Chrome
 * sharing a page sends all three. Chrome sharing a *selection* sends the
 * selection as `text` and the page as `url`. A reader app often sends the
 * headline as `title` and the link inside `text`, leaving `url` empty. Several
 * send the link twice. So this is not string concatenation: it is a small set
 * of de-duplication rules, and each one exists because some app out there does
 * the thing it guards against.
 *
 * Pure, and deliberately in `core/` rather than beside the service worker: it
 * is the only part of quick capture that has decisions in it, and it is the
 * only part a unit test can reach. The worker and the iOS fragment both funnel
 * through here so there is one answer to "what does a captured note look
 * like", not two that drift.
 *
 * What it does *not* do is derive a title. `deriveTitle` already reads the
 * first usable line of any note, so emitting the shared title as a heading is
 * enough — computing a title here would be a second implementation of a
 * function that already exists, which is the mistake `contract/` exists to
 * catch elsewhere.
 */

/** The three fields a Web Share Target may deliver. All optional, all untrusted. */
export interface SharedText {
  title?: string;
  text?: string;
  url?: string;
}

/**
 * Trim, and treat whitespace-only as absent.
 *
 * A field an app filled with a single space is not a field; letting it through
 * produces `# ` headings and blank trailing lines.
 */
function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The Markdown the share becomes, or `null` when there is nothing in it.
 *
 * `null` is not an error — an empty share is a real thing (an app that offers
 * "share" on an empty selection) and the caller's response is to do nothing at
 * all. Creating a blank note on the user's behalf would be worse than ignoring
 * them.
 */
export function composeCapture(input: SharedText): string | null {
  const title = clean(input.title);
  const text = clean(input.text);
  const url = clean(input.url);

  const parts: string[] = [];

  // The title becomes a heading unless the text already opens with it. Apps
  // that send the same string as both `title` and `text` are common enough
  // that without this the first two lines of a captured note are duplicates.
  if (title && !startsWithLine(text, title)) parts.push(`# ${title}`);
  if (text) parts.push(text);
  // `url` last, and only when it is not already somewhere in the body —
  // sharing a selection from a browser routinely delivers the page URL in both
  // fields, and a link repeated under itself reads as a mistake.
  if (url && !text.includes(url)) parts.push(url);

  const body = parts.join('\n\n');
  return body === '' ? null : body;
}

/** Whether `text`'s first line is exactly `title`, ignoring a leading `# `. */
function startsWithLine(text: string, title: string): boolean {
  if (!text) return false;
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  return first === title || first === `# ${title}`;
}
