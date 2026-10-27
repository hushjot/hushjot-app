/**
 * Plain-text helpers over note content. Framework-free and DOM-free.
 */

/**
 * Word count over Markdown source.
 *
 * Counts the source as written rather than trying to strip markup first:
 * stripping requires parsing, parsing costs more than the count is worth, and
 * a writer watching the number cares about the trend, not a precise figure.
 */
export function countWords(content: string): number {
  let count = 0;
  let inWord = false;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    // space, tab, newline, carriage return
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;
    if (isSpace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }

  return count;
}
