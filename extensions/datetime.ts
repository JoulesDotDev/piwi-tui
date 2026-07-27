/**
 * now — current date, time, and timezone.
 *
 * A model has a fixed knowledge cutoff but no sense of "today". This tool lets the
 * agent anchor itself in real time and recognise when a question is time-sensitive,
 * so it can compare today against its cutoff and verify with web search / docs
 * instead of answering from possibly-stale memory. The tool description carries
 * the capability detail; one concise prompt guideline covers when to call it.
 *
 * Drop-in: copy this file into ~/.pi/agent/extensions/ (or a project's
 * .pi/extensions/). No dependencies.
 */
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

const pad = (n: number): string => String(n).padStart(2, '0');
class TimeCard { constructor(private readonly lines: string[], private readonly theme: { fg(c: string, s: string): string; bg(c: string, s: string): string; bold(s: string): string }) {} render(width: number): string[] { const box = new Box(1, 1, (content) => this.theme.bg('customMessageBg', content)); box.addChild(new Text([this.theme.fg('accent', this.theme.bold('◷ Current time')), ...this.lines.map((line) => this.theme.fg('text', line))].join('\n'), 0, 0)); return box.render(width); } invalidate(): void {} }

export default function datetimeExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: 'now',
      label: 'Current date & time',
      renderShell: 'self',
      renderCall: (_args, theme) => new TimeCard(['Checking local time…'], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as { localDate?: string; localTime?: string; timezone?: string } | undefined; return new TimeCard([context.isError ? 'Unavailable' : `${d?.localDate ?? ''} · ${d?.localTime ?? ''}`, d?.timezone ?? ''], theme); },
      description:
        'Return the current local and UTC date, time, and timezone. Call before date-relative or ' +
        'freshness-sensitive answers. Verify facts that may have changed since your knowledge cutoff using current sources.',
      promptSnippet: 'Get the current date/time before date-relative answers',
      promptGuidelines: [
        'Call now when the current date or relative timing affects the answer; verify changeable facts with current sources.',
      ],
      parameters: Type.Object({}),
      async execute() {
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const human = new Intl.DateTimeFormat('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }).format(now);
        const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const localTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const iso = now.toISOString();
        const text = `${human}\nLocal: ${localDate} ${localTime} (${tz})\nUTC (ISO): ${iso}`;
        return { content: [{ type: 'text', text }], details: { localDate, localTime, timezone: tz, iso } };
      },
    }),
  );
}
