/**
 * plan mode + ask_user.
 *
 * Plans are checklist markdown in <cwd>/.pi/plans/<slug>.md — human-readable and
 * git-diffable. `plan` drafts one (with the user's approval), `plan_step` checks
 * items off, `plan_read` reads it back, and `/plan [slug]` renders it into the
 * transcript. `ask_user` asks the user a decision via pi's native select/input
 * dialogs. Drop-in, no dependencies.
 */
import { CONFIG_DIR_NAME, defineTool, truncateHead, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function canonical(path: string): string {
  const abs = resolve(path);
  let existing = abs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = realpathSync(existing);
  return existing === abs ? real : join(real, relative(existing, abs));
}
const plansDir = (cwd: string): string => {
  const dir = join(cwd, CONFIG_DIR_NAME, 'plans');
  const rel = relative(canonical(cwd), canonical(dir));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing a plans directory that escapes through a symlink.');
  return dir;
};
const clean = (text: string, max = 300): string => Array.from(text.normalize('NFKC')
  .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ').trim()).slice(0, max).join('');
function assertChild(root: string, file: string): void {
  const rel = relative(canonical(root), canonical(file));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing a plan file that escapes through a symlink.');
}
function atomicWrite(file: string, text: string): void {
  assertChild(dirname(file), file);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';

function planFiles(cwd: string): string[] {
  try {
    return readdirSync(plansDir(cwd)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}
/** The active plan = most recently modified .md (or a named slug). */
function resolvePlan(cwd: string, slug?: string): string | null {
  const files = planFiles(cwd);
  if (!files.length) return null;
  if (slug) {
    const want = `${slugify(slug)}.md`;
    return files.includes(want) ? want : null;
  }
  return files
    .map((f) => {
      try {
        return { f, m: statSync(join(plansDir(cwd), f)).mtimeMs };
      } catch {
        return { f, m: 0 }; // deleted between listing and stat — sort it last
      }
    })
    .sort((a, b) => b.m - a.m)[0].f;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve_) => setTimeout(resolve_, ms));
async function planLock<T>(cwd: string, action: () => T): Promise<T> {
  const lock = join(plansDir(cwd), '.lock');
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random()}`;
  mkdirSync(dirname(lock), { recursive: true });
  const candidate = `${lock}.${process.pid}.${Date.now()}.${Math.random()}.candidate`;
  writeFileSync(candidate, ownerToken, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  let acquired = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { linkSync(candidate, lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await sleep(20 + Math.floor(Math.random() * 15));
    }
  }
  rmSync(candidate, { force: true });
  if (!acquired) throw new Error('Another Pi session is saving plans. Try again in a moment; if it persists after a crash, run /locks.');
  try { return action(); }
  finally { try { if (readFileSync(lock, 'utf8') === ownerToken) rmSync(lock, { force: true }); } catch { /* recovered elsewhere */ } }
}
const readPlan = (cwd: string, file: string): string => {
  const root = plansDir(cwd);
  const target = join(root, file);
  assertChild(root, target);
  return readFileSync(target, 'utf8');
};

export default function planExtension(pi: ExtensionAPI): void {
  const projectTools = new Set(['plan', 'plan_step', 'plan_read']);
  pi.on('tool_call', (event, ctx) => {
    if (projectTools.has(event.toolName) && !ctx.isProjectTrusted()) return { block: true, reason: 'Trust the project before accessing plans.' };
  });
  // ---------- ask_user ----------
  pi.registerTool(
    defineTool({
      name: 'ask_user',
      label: 'Ask the user',
      description:
        'Ask one brief question when a user decision is required to continue or would materially change ' +
        'scope, architecture, cost, risk, or tradeoffs. Do not ask for facts you can verify or minor details ' +
        'you can reasonably infer. Provide choices when useful; free text remains available.',
      promptSnippet: 'Ask one brief, consequential user question',
      promptGuidelines: [
        'Use ask_user only when the answer materially changes the work or is required to continue; otherwise make a reasonable assumption and state it.',
      ],
      parameters: Type.Object({
        question: Type.String({ minLength: 1, maxLength: 200, description: 'Brief question requiring a user decision.' }),
        choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 8, description: 'Suggested answers; free text is also allowed.' })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const q = params.question.trim();
        if (!ctx.hasUI) return { content: [{ type: 'text', text: 'Interactive UI unavailable. Continue with a reasonable assumption and state it.' }], details: { asked: false } };
        const choices = (params.choices ?? []).map((c) => c.trim()).filter(Boolean);
        let answer: string | undefined;
        if (choices.length) {
          const OTHER = '✎ Something else…';
          const picked = await ctx.ui.select(q, [...choices, OTHER], { signal });
          answer = picked === OTHER ? await ctx.ui.input(q, 'Type your answer', { signal }) : picked;
        } else {
          answer = await ctx.ui.input(q, 'Your answer', { signal });
        }
        if (answer === undefined || !answer.trim()) return { content: [{ type: 'text', text: 'Question dismissed without an answer. Do not repeat it.' }], details: { cancelled: true } };
        const finalAnswer = answer.trim().slice(0, 20_000);
        return { content: [{ type: 'text', text: finalAnswer }], details: { answer: finalAnswer } };
      },
    }),
  );

  // ---------- plan tools ----------
  pi.registerTool(
    defineTool({
      name: 'plan',
      label: 'Save a plan',
      description:
        'Save or replace a markdown checklist in .pi/plans/ for substantial multi-step work. Provide a title ' +
        'and ordered steps. Interactive sessions request approval before saving; non-interactive sessions ' +
        'save immediately. Update completed items with plan_step.',
      promptSnippet: 'Save a checklist for substantial multi-step work',
      promptGuidelines: [
        'Use a plan for substantial multi-step work and keep it current with plan_step.',
      ],
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 100, description: 'Plan title.' }),
        steps: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 50, description: 'Ordered checklist steps.' }),
        slug: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: 'Optional file slug; defaults to the title.' })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const title = clean(params.title, 100);
        const steps = params.steps.map((step) => clean(step)).filter(Boolean);
        if (!title || !steps.length) throw new Error('A plan needs a title and at least one step.');
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(`Save this plan? "${title}"`, `${steps.length} steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`, { signal });
          if (!ok) return { content: [{ type: 'text', text: 'Plan not saved; the user declined.' }], details: { saved: false } };
        }
        const slug = slugify(params.slug || title);
        return planLock(ctx.cwd, () => {
          mkdirSync(plansDir(ctx.cwd), { recursive: true });
          const md = `# ${title}\n\n${steps.map((step) => `- [ ] ${step}`).join('\n')}\n`;
          atomicWrite(join(plansDir(ctx.cwd), `${slug}.md`), md);
          return { content: [{ type: 'text' as const, text: `Saved plan "${title}" (${steps.length} steps) → .pi/plans/${slug}.md. Check steps off with plan_step; view with /plan.` }], details: { slug, steps: steps.length } };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'plan_step',
      label: 'Check plan step',
      description:
        'Mark a plan step done or not-done by its number (1-based). Omit slug to use the active (most ' +
        'recent) plan. Do this as you complete each step so the checklist stays honest.',
      promptSnippet: 'Check a plan step off',
      parameters: Type.Object({
        step: Type.Integer({ minimum: 1, description: 'Step number (1-based).' }),
        done: Type.Optional(Type.Boolean({ description: 'true = done (default), false = reopen.' })),
        slug: Type.Optional(Type.String({ description: 'Plan slug; omit for the active plan.' })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return planLock(ctx.cwd, () => {
          const file = resolvePlan(ctx.cwd, params.slug);
          if (!file) throw new Error(params.slug ? `No plan "${params.slug}".` : 'No plans yet.');
          const lines = readPlan(ctx.cwd, file).split('\n');
          const indexes = lines.map((line, index) => (/^- \[[ x]\] /i.test(line.trim()) ? index : -1)).filter((index) => index >= 0);
          const target = indexes[params.step - 1];
          if (target === undefined) throw new Error(`Plan "${file}" has no step ${params.step}.`);
          const done = params.done !== false;
          lines[target] = lines[target].replace(/- \[[ x]\] /i, `- [${done ? 'x' : ' '}] `);
          atomicWrite(join(plansDir(ctx.cwd), file), lines.join('\n'));
          const total = indexes.length;
          const checked = lines.filter((line) => /^- \[x\] /i.test(line.trim())).length;
          return { content: [{ type: 'text' as const, text: `Step ${params.step} ${done ? 'done' : 'reopened'} in ${file} (${checked}/${total} complete).` }], details: { file, checked, total } };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'plan_read',
      label: 'Read plan',
      description: 'Read the active plan (or a named slug) — its title, steps, and which are done. Omit slug for the most recent.',
      parameters: Type.Object({ slug: Type.Optional(Type.String({ description: 'Plan slug; omit for the active plan.' })) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const file = resolvePlan(ctx.cwd, params.slug);
        if (!file) {
          const all = planFiles(ctx.cwd).map((f) => f.replace(/\.md$/, ''));
          return { content: [{ type: 'text', text: all.length ? `No plan "${params.slug}". Plans: ${all.join(', ')}.` : 'No plans yet. Draft one with the plan tool.' }], details: { plans: all } };
        }
        const raw = readPlan(ctx.cwd, file);
        const clipped = truncateHead(raw);
        const note = clipped.truncated ? `\n\n[Plan truncated: ${clipped.outputLines}/${clipped.totalLines} lines.]` : '';
        return { content: [{ type: 'text', text: clipped.content + note }], details: { file, truncated: clipped.truncated } };
      },
    }),
  );

  // ---------- /plan view ----------
  pi.registerEntryRenderer<{ lines: { text: string; color?: string; bold?: boolean }[] }>('plan-view', (entry, _opts, theme) => {
    if (!entry.data) return undefined;
    const out = entry.data.lines
      .map((l) => {
        let s = l.text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
        if (l.color) s = theme.fg(l.color as never, s);
        if (l.bold) s = theme.bold(s);
        return s;
      })
      .join('\n');
    return new Text(out, 0, 0);
  });

  pi.registerCommand('plan', {
    description: 'Show the active plan (or a named one)',
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) return void ctx.ui.notify('Trust the project before viewing plans.', 'warning');
      const file = resolvePlan(ctx.cwd, args.trim() || undefined);
      const send = (lines: { text: string; color?: string; bold?: boolean }[], _fallback: string): void => {
        const visible = lines.slice(0, 500);
        if (lines.length > visible.length) visible.push({ text: `… ${lines.length - visible.length} more lines; use plan_read for targeted access.`, color: 'muted' });
        pi.appendEntry('plan-view', { lines: visible });
      };
      if (!file) {
        const all = planFiles(ctx.cwd).map((f) => f.replace(/\.md$/, ''));
        const msg = all.length ? `Plans · ${all.length}` : 'No plans yet — the plan tool drafts one.';
        const lines = all.length
          ? [{ text: msg, color: 'accent', bold: true }, { text: '' }, ...all.map((slug) => ({ text: `  • ${slug}`, color: 'text' })), { text: '' }, { text: 'Use /plan <slug> to open one.', color: 'muted' }]
          : [{ text: msg, color: 'muted' }];
        send(lines, msg);
        return;
      }
      const md = readPlan(ctx.cwd, file);
      const lines: { text: string; color?: string; bold?: boolean }[] = [];
      for (const raw of md.split('\n')) {
        const l = raw.trimEnd();
        if (l.startsWith('# ')) lines.push({ text: l.slice(2), color: 'accent', bold: true }, { text: '' });
        else if (/^- \[x\] /i.test(l.trim())) lines.push({ text: `  ✓ ${l.trim().slice(6)}`, color: 'dim' });
        else if (/^- \[ \] /.test(l.trim())) lines.push({ text: `  ○ ${l.trim().slice(6)}`, color: 'text' });
        else if (l.trim()) lines.push({ text: `  ${l.trim()}`, color: 'muted' });
      }
      const total = (md.match(/^- \[[ x]\] /gim) || []).length;
      const done = (md.match(/^- \[x\] /gim) || []).length;
      lines.push({ text: '' }, { text: `${done}/${total} complete`, color: 'muted' });
      send(lines, file);
    },
  });
}
