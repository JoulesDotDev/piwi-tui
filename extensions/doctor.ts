/**
 * doctor — read-only local project readiness card.
 *
 * Intentionally command-only: no model tool schema, no persistence, no network,
 * and it never runs project scripts, installs, tests, or arbitrary shell commands.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { Text } from '@earendil-works/pi-tui';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type Tone = 'accent' | 'success' | 'warning' | 'error' | 'muted' | 'dim' | 'text' | 'borderAccent';
interface Row { text: string; tone?: Tone; bold?: boolean }
interface DoctorData { title: string; rows: Row[] }

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const clean = (value: string, limit = 180): string => Array.from(value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
const file = (cwd: string, name: string): boolean => existsSync(join(cwd, name));

function onPath(name: string): boolean {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => suffixes.some((suffix) => existsSync(join(dir, `${name}${suffix}`))));
}
function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3_000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function packageScripts(cwd: string): string[] {
  try {
    const data = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    return Object.keys(data.scripts ?? {}).filter((name) => typeof data.scripts?.[name] === 'string').slice(0, 8);
  } catch { return []; }
}
function collect(cwd: string, trusted: boolean): DoctorData {
  const rows: Row[] = [];
  rows.push({ text: `Project doctor · ${basename(cwd) || cwd}`, tone: 'accent', bold: true });
  rows.push({ text: trusted ? '✓ Project trusted' : '⚠ Project untrusted — local project data is hidden', tone: trusted ? 'success' : 'warning' });

  const manifests = [
    ['package.json', 'Node package'], ['pyproject.toml', 'Python project'], ['Cargo.toml', 'Rust crate'],
    ['go.mod', 'Go module'], ['Gemfile', 'Ruby bundle'], ['pom.xml', 'Maven project'], ['build.gradle', 'Gradle project'],
  ].filter(([name]) => file(cwd, name)) as Array<[string, string]>;
  const locks = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'Cargo.lock', 'go.sum'].filter((name) => file(cwd, name));
  rows.push({ text: manifests.length ? `• ${manifests.map(([, label]) => label).join(' · ')}` : '• No common project manifest detected', tone: manifests.length ? 'text' : 'muted' });
  if (locks.length) rows.push({ text: `  Lockfiles · ${locks.join(', ')}`, tone: 'dim' });

  const docs = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTRIBUTING.md'].filter((name) => file(cwd, name));
  rows.push({ text: docs.length ? `• Guidance · ${docs.join(', ')}` : '• No root guidance file found', tone: docs.length ? 'text' : 'muted' });

  const scripts = file(cwd, 'package.json') ? packageScripts(cwd) : [];
  if (scripts.length) rows.push({ text: `• Package scripts · ${scripts.join(' · ')}`, tone: 'text' });

  const insideGit = git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (insideGit) {
    const branch = git(cwd, ['branch', '--show-current']) || 'detached HEAD';
    const status = git(cwd, ['status', '--short']) ?? '';
    const changed = status.split('\n').filter(Boolean).length;
    rows.push({ text: changed ? `• Git · ${branch} · ${changed} changed file${changed === 1 ? '' : 's'}` : `• Git · ${branch} · clean`, tone: changed ? 'warning' : 'success' });
  } else rows.push({ text: '• Git · not a repository', tone: 'muted' });

  const expected = file(cwd, 'package.json') ? (file(cwd, 'bun.lock') || file(cwd, 'bun.lockb') ? ['bun'] : ['node', 'npm'])
    : file(cwd, 'pyproject.toml') ? ['python'] : file(cwd, 'Cargo.toml') ? ['cargo'] : file(cwd, 'go.mod') ? ['go'] : [];
  if (expected.length) {
    const missing = expected.filter((name) => !onPath(name));
    rows.push({ text: missing.length ? `• Missing executable${missing.length > 1 ? 's' : ''} · ${missing.join(', ')}` : `• Tools ready · ${expected.join(', ')}`, tone: missing.length ? 'error' : 'success' });
  }
  rows.push({ text: 'Read-only · no scripts, tests, installs, or network calls were run', tone: 'dim' });
  return { title: 'doctor', rows };
}

export default function doctorExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<DoctorData>('doctor-view', (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const out = data.rows.map((row) => {
      let text = clean(row.text);
      if (row.tone) text = theme.fg(row.tone, text);
      return row.bold ? theme.bold(text) : text;
    }).join('\n');
    return new Text(out, 0, 0);
  });
  pi.registerCommand('doctor', {
    description: 'Show a read-only local project readiness card',
    handler: async (_args, ctx) => {
      if (!ctx.isProjectTrusted()) return void ctx.ui.notify('Trust the project before running its doctor.', 'warning');
      pi.appendEntry<DoctorData>('doctor-view', collect(ctx.cwd, true));
    },
  });
}
