/**
 * autoname — give each new session a readable title from its first message.
 *
 * pi doesn't title sessions automatically (only manual rename in the selector, or
 * programmatic setSessionName). This fills that gap with a local heuristic.
 * Heuristic and zero-cost — no extra model call. Drop-in, no dependencies.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

function firstUserText(ctx: ExtensionContext): string | undefined {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message') continue;
    const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || msg.role !== 'user') continue;
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text').map((c) => c.text).join(' ')
          : '';
    if (text.trim()) return text.trim();
  }
  return undefined;
}

function toTitle(raw: string): string | undefined {
  const t = raw
    .normalize('NFKC')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/(?:https?:\/\/)?[^\s]+:[^\s]+@[^\s]+/g, '[private URL]')
    .replace(/```[\s\S]*?```/g, ' ') // drop code fences
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.startsWith('/')) return undefined; // empty or a slash command — not a topic
  const firstSentence = t.split(/(?<=[.!?])\s|\n/)[0].trim() || t;
  const words = firstSentence.split(' ').slice(0, 8).join(' ');
  const title = words.length > 60 ? words.slice(0, 57).trimEnd() + '…' : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export default function autonameExtension(pi: ExtensionAPI): void {
  let done = false;
  pi.on('session_start', (_event, ctx) => {
    // Name only genuinely new sessions; do not retroactively rename resumed/forked history.
    done = !!pi.getSessionName() || ctx.sessionManager.getEntries().length > 0;
  });
  pi.on('agent_end', (_event, ctx) => {
    if (done || pi.getSessionName()) {
      done = true;
      return;
    }
    const text = firstUserText(ctx);
    if (!text) return;
    const title = toTitle(text);
    if (!title) return;
    pi.setSessionName(title);
    done = true;
  });
}
