/**
 * locks — quiet, read-only recovery diagnostics for Piwi's persistent state.
 *
 * This deliberately never removes a real lock. A stale-looking PID is not proof
 * that unlinking is safe: PID reuse, another host, or a paused writer can corrupt
 * state. Normal busy errors stay simple; /locks is the advanced escape hatch.
 */
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Text } from '@earendil-works/pi-tui';

type Tone = 'accent' | 'success' | 'warning' | 'error' | 'muted' | 'dim' | 'text';
interface Row { text: string; tone?: Tone; bold?: boolean }
interface LocksData { rows: Row[] }
interface LockTarget { label: string; file: string; ownerFile?: string }

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const clean = (value: string, limit = 220): string => Array.from(value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
const age = (ms: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};
function ownerState(token: string): { text: string; tone: Tone } {
  const pid = Number(token.split(':', 1)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return { text: 'owner unknown', tone: 'warning' };
  try {
    process.kill(pid, 0);
    return { text: `Pi process ${pid} appears active`, tone: 'warning' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { text: `Pi process ${pid} is no longer present`, tone: 'warning' };
    return { text: `cannot verify Pi process ${pid}`, tone: 'warning' };
  }
}
function candidates(lock: string): number {
  try {
    const prefix = `${basename(lock)}.candidate`;
    return readdirSync(dirname(lock)).filter((name) => name.startsWith(prefix)).length;
  } catch { return 0; }
}
function inspect(target: LockTarget): Row[] {
  if (!existsSync(target.file)) {
    const leftover = candidates(target.file);
    return [{ text: `✓ ${target.label} · ready${leftover ? ` · ${leftover} harmless temporary candidate${leftover === 1 ? '' : 's'}` : ''}`, tone: 'success' }];
  }
  try {
    const stat = lstatSync(target.file);
    if (stat.isSymbolicLink()) return [{ text: `⚠ ${target.label} · unsafe symlinked lock path`, tone: 'error' }];
    const ownerPath = target.ownerFile ?? (stat.isDirectory() ? join(target.file, 'owner') : target.file);
    const token = clean(readFileSync(ownerPath, 'utf8'), 160);
    const state = ownerState(token);
    const kind = stat.isDirectory() ? 'directory lock' : 'lock';
    return [
      { text: `⚠ ${target.label} · ${kind} from ${age(stat.mtimeMs)}`, tone: 'warning', bold: true },
      { text: `  ${state.text}`, tone: state.tone },
      { text: `  ${target.file}`, tone: 'dim' },
    ];
  } catch (error) {
    return [{ text: `⚠ ${target.label} · could not inspect lock: ${clean((error as Error).message, 140)}`, tone: 'warning' }];
  }
}
function collect(cwd: string): LocksData {
  const projectPi = join(cwd, '.pi');
  const agent = getAgentDir();
  const targets: LockTarget[] = [
    { label: 'Project memory', file: join(projectPi, 'MEMORY.md.lock') },
    { label: 'Agenda and boards', file: join(projectPi, 'agenda', '.lock') },
    { label: 'Plans', file: join(projectPi, 'plans', '.lock') },
    { label: 'Quick checklist', file: join(projectPi, 'TODO.md.lock') },
    { label: 'Global memory', file: join(agent, 'MEMORY.md.lock') },
    { label: 'Pet', file: join(agent, 'pet.json.lock') },
  ];
  const rows: Row[] = [{ text: 'Lock check', tone: 'accent', bold: true }];
  for (const target of targets) rows.push(...inspect(target));
  const active = rows.some((row) => row.text.startsWith('⚠'));
  rows.push({ text: active ? 'Nothing was changed. Try the original action again first; if a lock persists after a crash, review the path above before removing it.' : 'Everything is ready — no active Piwi locks found.', tone: active ? 'muted' : 'dim' });
  return { rows };
}

export default function locksExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<LocksData>('locks-view', (entry, _options, theme) => {
    if (!entry.data) return undefined;
    const text = entry.data.rows.map((row) => {
      let value = clean(row.text);
      if (row.tone) value = theme.fg(row.tone, value);
      return row.bold ? theme.bold(value) : value;
    }).join('\n');
    return new Text(text, 0, 0);
  });
  pi.registerCommand('locks', {
    description: 'Diagnose persistent Piwi state locks without changing anything',
    handler: async (_args, ctx) => {
      if (!ctx.isProjectTrusted()) return void ctx.ui.notify('Trust the project before inspecting its locks.', 'warning');
      pi.appendEntry<LocksData>('locks-view', collect(ctx.cwd));
    },
  });
}
