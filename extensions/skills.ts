/**
 * skills authoring — list_skills + create_skill.
 *
 * pi LOADS and invokes skills natively from ~/.pi/agent/skills/ (global) and
 * <cwd>/.pi/skills/ (project), each a `<slug>/SKILL.md` folder (+ any helper files
 * it references by relative name). This extension only adds AUTHORING:
 *   • create_skill — write a new skill folder (scope: global | project) with helpers
 *   • list_skills  — report the skills found in both locations
 * Drop-in, no dependencies.
 */
import { CONFIG_DIR_NAME, defineTool, getAgentDir, truncateHead, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Box, Text } from '@earendil-works/pi-tui';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

class SkillToolCard {
  constructor(private readonly title: string, private readonly lines: string[], private readonly theme: { fg(c: string, s: string): string; bg(c: string, s: string): string; bold(s: string): string }) {}
  render(width: number): string[] { const box = new Box(1, 1, (content) => this.theme.bg('customMessageBg', content)); box.addChild(new Text([this.theme.fg('accent', this.theme.bold(`◇ Skills · ${this.title}`)), ...this.lines.map((line) => this.theme.fg('text', line))].join('\n'), 0, 0)); return box.render(width); }
  invalidate(): void {}
}
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
const dirFor = (scope: 'global' | 'project', cwd: string): string => {
  const dir = scope === 'global' ? join(getAgentDir(), 'skills') : join(cwd, CONFIG_DIR_NAME, 'skills');
  const root = scope === 'global' ? getAgentDir() : cwd;
  const rel = relative(canonical(root), canonical(dir));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refusing a ${scope} skills path that escapes through a symlink.`);
  return dir;
};
const cleanLine = (text: string, max: number): string => Array.from(text.normalize('NFKC')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ').trim()).slice(0, max).join('');

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';

/** name + description from a SKILL.md's YAML-ish frontmatter (scalars + block scalars). */
function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      val = parts.join(val[0] === '|' ? '\n' : ' ');
    } else val = val.replace(/^["']|["']$/g, '');
    out[kv[1]] = val.trim();
  }
  return { name: out.name, description: out.description };
}

function listScope(scope: 'global' | 'project', cwd: string): { name: string; description: string }[] {
  const dir = dirFor(scope, cwd);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const file = join(dir, entry.name, 'SKILL.md');
        if (!existsSync(file)) return false;
        const rel = relative(canonical(dir), canonical(file));
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      })
      .map((entry) => {
        const fm = frontmatter(readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8'));
        return { name: cleanLine(fm.name?.trim() || entry.name, 100), description: cleanLine(fm.description?.trim() || '', 500) };
      });
  } catch {
    return [];
  }
}

/** basename-only, sanitized; never SKILL.md. */
function safeHelper(name: string): string | null {
  const s = basename(name.trim()).replace(/[^A-Za-z0-9._-]/g, '_');
  return !s || s === '.' || s === '..' || s.toLowerCase() === 'skill.md' ? null : s;
}

export default function skillsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: 'list_skills',
      label: 'List skills',
      renderShell: 'self',
      renderCall: (_args, theme) => new SkillToolCard('listing', ['Project + global'], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as { project?: unknown[]; global?: unknown[]; truncated?: boolean } | undefined; return new SkillToolCard(context.isError ? 'unavailable' : 'ready', [`${d?.project?.length ?? 0} project · ${d?.global?.length ?? 0} global`, d?.truncated ? 'List truncated' : ''], theme); },
      description:
        'List skills managed in ~/.pi/agent/skills and .pi/skills. Project skills are omitted when the ' +
        'project is untrusted. This excludes skills discovered from packages, CLI options, ancestor directories, or .agents.',
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const project = ctx.isProjectTrusted() ? listScope('project', ctx.cwd) : [];
        const global = listScope('global', ctx.cwd);
        if (!project.length && !global.length) return { content: [{ type: 'text', text: 'No accessible global or project skills found.' }], details: { project, global } };
        const fmt = (list: { name: string; description: string }[]) => list.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n');
        const blocks: string[] = [];
        if (project.length) blocks.push(`Project skills (${project.length}):\n${fmt(project)}`);
        if (global.length) blocks.push(`Global skills (${global.length}):\n${fmt(global)}`);
        const raw = blocks.join('\n\n');
        const clipped = truncateHead(raw);
        const note = clipped.truncated ? `\n\n[Skill list truncated: ${clipped.outputLines}/${clipped.totalLines} lines.]` : '';
        return { content: [{ type: 'text', text: clipped.content + note }], details: { project, global, truncated: clipped.truncated } };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'create_skill',
      label: 'Create skill',
      renderShell: 'self',
      renderCall: (args, theme) => new SkillToolCard('creating', [args.name, `${args.scope ?? 'project'} · ${args.files?.length ?? 0} helper files`], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as { scope?: string; slug?: string; files?: string[]; created?: boolean } | undefined; return new SkillToolCard(context.isError ? 'unavailable' : d?.created === false ? 'cancelled' : 'created', [d?.slug ?? 'Skill', `${d?.scope ?? 'project'} · ${d?.files?.length ?? 0} files`], theme); },
      description:
        'Create a reusable markdown skill. project (default) writes .pi/skills and requires a trusted ' +
        'project; global writes ~/.pi/agent/skills. Every creation requires interactive approval. Keep content focused ' +
        'on when the skill applies and how to execute it; put referenced templates or scripts in files. ' +
        'The skill loads next session or after /reload.',
      promptSnippet: 'Create a reusable project or global skill',
      promptGuidelines: [
        'Use create_skill only when the user asks to preserve a repeatable procedure or recurring correction.',
      ],
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', description: 'Kebab-case skill name, e.g. "commit-style".' }),
        description: Type.String({ minLength: 1, maxLength: 240, description: 'One line — what the skill is for.' }),
        content: Type.String({ minLength: 1, maxLength: 100000, description: 'Skill instructions: when it applies and how to execute it.' }),
        scope: Type.Optional(StringEnum(['global', 'project'] as const, { description: 'Global (all projects) or project (default).' })),
        files: Type.Optional(
          Type.Array(
            Type.Object({ name: Type.String({ minLength: 1, maxLength: 120, description: 'Basename only; SKILL.md is reserved.' }), content: Type.String({ maxLength: 1000000, description: 'Helper file contents.' }) }),
            { maxItems: 20, description: 'Helper files stored beside SKILL.md; names must be unique.' },
          ),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const name = cleanLine(params.name, 64);
        const description = cleanLine(params.description, 240);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Skill name must be lowercase kebab-case.');
        if (!description || !params.content.trim()) throw new Error('A skill needs a description and content.');
        const scope = params.scope ?? 'project';
        if (scope === 'project' && !ctx.isProjectTrusted()) throw new Error('Project must be trusted before creating a project skill.');
        const helpers = (params.files ?? []).map((item) => ({ name: safeHelper(item.name), content: item.content }));
        if (helpers.some((item) => !item.name)) throw new Error('Helper file names must be safe basenames and cannot be SKILL.md.');
        const helperNames = helpers.map((item) => item.name!);
        if (new Set(helperNames).size !== helperNames.length) throw new Error('Helper file names must be unique.');
        if (!ctx.hasUI) throw new Error(`${scope === 'global' ? 'Global' : 'Project'} skill creation requires interactive approval.`);
        const preview = cleanLine(params.content, 1_200);
        const helperSummary = helperNames.length ? `\n\nHelper files: ${helpers.map((item) => `${item.name} (${item.content.length} chars)`).join(', ')}` : '';
        const ok = await ctx.ui.confirm(scope === 'global' ? 'Create a skill for every project?' : 'Create a project skill?', `${name}: ${description}\n\n${preview}${params.content.length > preview.length ? ' … [preview truncated]' : ''}${helperSummary}`);
        if (!ok) return { content: [{ type: 'text', text: `${scope === 'global' ? 'Global' : 'Project'} skill creation cancelled.` }], details: { scope, created: false } };
        const root = dirFor(scope, ctx.cwd);
        mkdirSync(root, { recursive: true });
        let slug = slugify(name);
        let i = 1;
        while (existsSync(join(root, slug))) slug = `${slugify(name)}-${++i}`;
        const folder = join(root, slug);
        mkdirSync(folder, { mode: 0o700 });
        writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${params.content.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
        const written: string[] = [];
        for (const helper of helpers) {
          const safe = helper.name!;
          writeFileSync(join(folder, safe), helper.content, { encoding: 'utf8', mode: 0o600 });
          written.push(safe);
        }
        const helperNote = written.length ? ` with ${written.length} helper file${written.length > 1 ? 's' : ''} (${written.join(', ')})` : '';
        const loc = scope === 'global' ? '~/.pi/agent/skills' : '.pi/skills';
        return {
          content: [{ type: 'text', text: `Created ${scope} skill "${name}" at ${loc}/${slug}${helperNote}. It will be available next session or after /reload.` }],
          details: { scope, slug, files: written },
        };
      },
    }),
  );
}
