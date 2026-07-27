/**
 * btw — a genuinely parallel, context-aware side question.
 *
 * Each question runs in an in-memory Pi sub-session seeded with the active main
 * branch. It never writes messages into the main agent context, so it cannot
 * interrupt main work or hold ordinary user input behind a BTW answer.
 */
import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { Box, Text, truncateToWidth } from '@earendil-works/pi-tui';

interface BtwData { kind: 'question' | 'answer' | 'error'; question: string; answer?: string }
const MAX_QUESTION = 1_000;
const MAX_ANSWER = 2_000;
const MAX_RUNNING = 2;
let running = 0;
const CONTROL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const clean = (value: string, limit: number): string => Array.from(value.replace(CONTROL, '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');

interface BtwTheme { fg(color: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string }
class BtwCard {
  constructor(private readonly data: BtwData, private readonly theme: BtwTheme) {}
  render(width: number): string[] {
    const state = this.data.kind === 'question' ? 'ASKED' : this.data.kind === 'answer' ? 'ANSWER' : 'UNAVAILABLE';
    const color = this.data.kind === 'error' ? 'error' : 'accent';
    if (width < 10) return [truncateToWidth(this.theme.fg(color, this.data.kind === 'question' ? 'BTW?' : this.data.kind === 'answer' ? 'BTW✓' : 'BTW!'), Math.max(1, width), '')];
    const footer = this.data.kind === 'question'
      ? 'Answering in parallel · main work keeps moving'
      : this.data.kind === 'answer'
        ? 'Full active context · not injected into main work'
        : 'Try again when a model is available';
    const source = this.data.kind === 'question' ? this.data.question : this.data.answer ?? 'No answer returned.';
    const body = width < 40 && source.length > 360 ? `${source.slice(0, 357)}…` : source;
    const text = [
      this.theme.fg(color, this.theme.bold(`↳ BTW · ${state}`)),
      this.theme.fg('text', body),
      ...(width < 40 ? [] : [this.theme.fg('muted', footer)]),
    ].join('\n');
    const box = new Box(1, 1, (content) => this.theme.bg('customMessageBg', content));
    box.addChild(new Text(text, 0, 0));
    return box.render(width);
  }
  invalidate(): void {}
}
function resourceLoader(ctx: ExtensionCommandContext): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => ctx.getSystemPrompt(),
    getAppendSystemPrompt: () => [
      'You are answering a brief BTW side question in parallel with the main agent.',
      'The preceding conversation is read-only context; do not continue, modify, or take over its work.',
      'Answer only the user’s side question concisely. You have no tools and your answer is not injected into the main agent.',
    ],
    extendResources: () => {},
    reload: async () => {},
  };
}
function answerFrom(session: AgentSession): string | undefined {
  const messages = session.agent.state.messages as Message[];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const text = (message as AssistantMessage).content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
    return text ? clean(text, MAX_ANSWER) : undefined;
  }
  return undefined;
}
async function launch(pi: ExtensionAPI, question: string, ctx: ExtensionCommandContext): Promise<void> {
  running += 1;
  try {
    if (!ctx.model) throw new Error('No active model is selected.');
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: ctx.model,
      modelRegistry: ctx.modelRegistry as AgentSession['modelRegistry'],
      thinkingLevel: pi.getThinkingLevel(),
      tools: [],
      resourceLoader: resourceLoader(ctx),
    });
    // This is the compaction-aware active branch, not a model-generated summary.
    session.agent.state.messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as typeof session.agent.state.messages;
    await session.prompt(question, { source: 'extension' });
    const answer = answerFrom(session);
    pi.appendEntry<BtwData>('btw-aside', answer
      ? { kind: 'answer', question, answer }
      : { kind: 'error', question, answer: 'The BTW session returned no text answer.' });
  } catch (error) {
    pi.appendEntry<BtwData>('btw-aside', { kind: 'error', question, answer: clean((error as Error).message || 'The BTW session could not start.', 300) });
  } finally {
    running = Math.max(0, running - 1);
  }
}

export default function btwExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<BtwData>('btw-aside', (entry, _options, theme) => entry.data ? new BtwCard(entry.data, theme) : undefined);
  pi.registerCommand('btw', {
    description: 'Ask a parallel, context-aware side question (/btw <question>)',
    handler: async (args, ctx) => {
      const question = clean(args, MAX_QUESTION);
      if (!question) return void ctx.ui.notify('Usage: /btw <brief question>', 'warning');
      if (running >= MAX_RUNNING) return void ctx.ui.notify('Two BTW questions are already answering; try again shortly.', 'warning');
      pi.appendEntry<BtwData>('btw-aside', { kind: 'question', question });
      void launch(pi, question, ctx);
    },
  });
}
