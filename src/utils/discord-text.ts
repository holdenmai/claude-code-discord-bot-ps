/** Discord's message content limit, with a little headroom. */
export const MESSAGE_LIMIT = 2000;

/**
 * Split a message into Discord-sized pieces, breaking on line boundaries.
 *
 * Discord rejects an over-long `content` outright — the API answers 50035
 * "Invalid Form Body" and the whole reply is lost, which is a bad trade for a
 * report whose length is proportional to how much work it just did. Splitting
 * beats truncating here: for a command that reports per-item results, the tail
 * is usually where the failures are.
 *
 * Lines are kept whole where possible; a single line longer than the limit
 * (a stack trace, a git error dump) is hard-split rather than dropped.
 */
export function splitForDiscord(text: string, limit = MESSAGE_LIMIT - 10): string[] {
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    // +1 for the newline we'd be re-joining with.
    if (current.length + line.length + 1 > limit) flush();
    current = current.length === 0 ? line : `${current}\n${line}`;
  }
  flush();

  return chunks.length > 0 ? chunks : [""];
}

/**
 * Split, then cap how many messages we're willing to post. Anything past the
 * cap is replaced by a one-line note — a command that fans out over dozens of
 * items shouldn't be able to carpet the channel.
 */
export function splitForDiscordCapped(text: string, maxParts: number, limit?: number): string[] {
  const parts = splitForDiscord(text, limit);
  if (parts.length <= maxParts) return parts;

  const kept = parts.slice(0, maxParts);
  const dropped = parts.length - maxParts;
  kept[maxParts - 1] += `\n_… ${dropped} more message(s) of output not shown_`;
  return kept;
}
