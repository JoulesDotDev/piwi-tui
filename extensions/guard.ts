/**
 * guard — an optional safety layer that keeps the agent inside the project folder.
 *
 *   • read / write / edit — resolve the structured `path`; confirm (Allow/Block)
 *     anything landing outside the project. Reads of likely secret files (.env,
 *     keys, …) are confirmed even inside.
 *   • bash — an opaque string, so we *heuristically* scan for paths that escape the
 *     folder (absolute /…, home ~ or ~/…, parent ../…), including redirect targets
 *     (`>/etc/x`), and confirm those. Catches the common cases (`rm /Users/you/x`,
 *     `cat ~/.ssh/id_rsa`, `rm -rf ~`); NOT a sandbox — subshells, globs, and dynamic
 *     values can hide a target. True bash confinement needs OS-level sandboxing.
 *     Loopback URLs and /dev/* sinks are exempt (everyday dev traffic).
 *
 * pi is permissive by default; this adds a confirm gate. `/guard off` disables it
 * for the current session; safe mode returns on restart. Drop-in, no dependencies.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SECRET_FILE = /^(\.env(\..+)?|\.npmrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|keystore|jks))$/i;
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
const READ_TOOLS = new Set(['read', 'grep']);
/** Loopback URLs are everyday dev traffic — stripped before the path scan, which
 *  would otherwise read the `//host/path` tail as an absolute filesystem path. Only
 *  loopback; an external URL still trips the scan so bash egress stays visible. */
const LOOPBACK_URL = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s"'<>|)&;]*/gi;
/** The /dev sink/source family — everyday shell plumbing, never worth a prompt. */
const DEV_SINK = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|urandom|random|fd\/\d+)$/;

/** Known public skill roots. Do not exempt all config: it contains credentials/settings. */
const PUBLIC_READ_ROOTS = [join(getAgentDir(), 'skills'), join(homedir(), '.agents', 'skills')];
function lexicalEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
function canonical(path: string): string {
  const abs = resolve(path);
  let existing = abs;
  while (!lexicalEntryExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  // realpath throws for dangling symlinks; fail-safe tool hooks then block access.
  const real = realpathSync(existing);
  return existing === abs ? real : join(real, relative(existing, abs));
}
function insideRoot(root: string, target: string): boolean {
  const rel = relative(canonical(root), canonical(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
function publicRead(abs: string): boolean {
  return PUBLIC_READ_ROOTS.some((root) => existsSync(root) && insideRoot(root, abs));
}
function insideFolder(cwd: string, target: string): boolean {
  return insideRoot(cwd, resolve(cwd, target));
}

function resolveVars(command: string): string {
  const vars: Record<string, string> = {};
  const assign = /(?:^|[\s;&|(])(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s;&|)]*))/g;
  for (const m of command.matchAll(assign)) vars[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  return command.replace(/\$\{(\w+)\}|\$(\w+)/g, (full, a, b) => {
    const name = a ?? b;
    return name in vars ? vars[name] : full;
  });
}
function looksLikeRegexLiteral(value: string): boolean {
  // Source snippets commonly contain /pattern/flags. Treating those as absolute
  // paths creates noisy false positives (for example, `.replace(/word/g, ...)`).
  // This is deliberately narrow: ordinary paths such as /tmp/file still scan.
  const match = /^\/((?:\\.|[^/\\\n])+?)\/([dgimsuvy]*),?$/.exec(value);
  return Boolean(match && (match[2] || /[\\^$.*+?()[\]{}|]/.test(match[1]!)));
}
/** A deliberately small shell lexer: enough for literal paths, quotes, redirects,
 * comments, and source snippets—not an attempt to interpret Bash expansions. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let escaped = false;
  const push = (): void => { if (token) tokens.push(token); token = ''; };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) { token += ch; escaped = false; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"') escaped = true;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '#' && !token) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
      continue; // shell comment after a boundary; resume at the next command line
    }
    if (/\s/.test(ch) || ';|&<>()'.includes(ch)) { push(); continue; }
    token += ch;
  }
  push();
  return tokens;
}
function bashEscape(cwd: string, command: string): string | null {
  // resolveVars handles simple same-command assignments only. Command substitution,
  // eval, globs, inherited environment values, and sourced scripts remain outside
  // this lexical guard's contract; OS sandboxing is required for hard confinement.
  const tokens = shellTokens(command);
  const isAwk = tokens.some((token) => /(?:^|\/)awk$/.test(token));
  for (const token of tokens) {
    if (looksLikeRegexLiteral(token)) continue;
    if (/^(?:https?|file):\/\//i.test(token)) return token; // loopback HTTP URLs were stripped first
    let raw = token.replace(/^\d+>/, ''); // shell redirect fd, e.g. 2>/tmp/log
    // awk's -F/ means “split fields on slash”, never “access filesystem root”.
    if (isAwk && /^-F=?\//.test(raw)) continue;
    if (raw.startsWith('-')) {
      // Attached option values can be paths: -o/tmp/log, -I../headers,
      // or --target-directory=/tmp. Scan only their path-like suffix.
      const starts = [raw.indexOf('/'), raw.indexOf('./'), raw.indexOf('../'), raw.indexOf('~/')].filter((index) => index >= 0);
      const equal = raw.indexOf('=');
      if (equal >= 0 && /^\/?(?:\.\.\/|~\/|\/)/.test(raw.slice(equal + 1))) starts.push(equal + 1);
      if (!starts.length) continue;
      raw = raw.slice(Math.min(...starts));
    }
    if (!raw || raw.includes('$')) continue; // unresolved dynamic expansion
    if (/^~[^/]+(?:\/|$)/.test(raw)) return raw; // Bash expands named-home forms, e.g. ~root/x
    const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    const pathLike = expanded.startsWith('/') || expanded.startsWith('../') || expanded.includes('/') || expanded === '~' || expanded.startsWith('~/');
    const abs = resolve(cwd, expanded);
    if (!pathLike && !lexicalEntryExists(abs)) continue;
    if (DEV_SINK.test(abs)) continue;
    try { if (!insideFolder(cwd, abs)) return abs; }
    catch { return abs; } // dangling symlink or unreadable path: require confirmation
  }
  return null;
}

export default function guardExtension(pi: ExtensionAPI): void {
  let enabled = true;

  const setEnabled = (next: boolean, ctx: ExtensionCommandContext): void => {
    enabled = next;
    ctx.ui.setStatus('guard-yolo', enabled ? undefined : ctx.ui.theme.fg('warning', 'YOLO'));
    ctx.ui.notify(enabled ? 'Guard on — Piwi will ask before secret-file or outside-project access.' : 'YOLO mode on — guard confirmations are disabled.', enabled ? 'info' : 'warning');
  };

  pi.registerCommand('guard', {
    description: 'Configure project access safeguards (/guard on|off|status)',
    getArgumentCompletions: (prefix) => {
      const matches = ['on', 'off', 'status'].filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === 'on') setEnabled(true, ctx);
      else if (action === 'off') setEnabled(false, ctx);
      else if (action === 'status') ctx.ui.notify(enabled ? 'Guard is on.' : 'Guard is off (YOLO mode).', enabled ? 'info' : 'warning');
      else ctx.ui.notify('Usage: /guard on|off|status', 'warning');
    },
  });

  pi.on('session_start', (_event, ctx) => {
    enabled = true;
    ctx.ui.setStatus('guard-yolo', undefined);
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!enabled) return;
    const cwd = ctx.cwd ?? process.cwd();

    if (event.toolName === 'bash' || (event.toolName === 'process' && (event.input as { action?: string }).action === 'start')) {
      const command = (event.input as { command?: string }).command ?? '';
      const escaped = bashEscape(cwd, resolveVars(command).replace(LOOPBACK_URL, ''));
      if (escaped) {
        if (!ctx.hasUI) return { block: true, reason: 'Blocked — outside-project access requires interactive confirmation' };
        const ok = await ctx.ui.confirm('Run a command that accesses something outside the project?', escaped);
        if (!ok) return { block: true, reason: 'Blocked — command accesses a resource outside the project' };
      }
      return;
    }

    if (!PATH_TOOLS.has(event.toolName)) return;
    const path = (event.input as { path?: string }).path;
    if (!path) return;
    const abs = resolve(cwd, path);

    let canonicalAbs = abs;
    try { canonicalAbs = canonical(abs); }
    catch {
      return { block: true, reason: 'Blocked — path contains a dangling or unreadable symlink' };
    }
    if (READ_TOOLS.has(event.toolName) && (SECRET_FILE.test(basename(abs)) || SECRET_FILE.test(basename(canonicalAbs)))) {
      if (!ctx.hasUI) return { block: true, reason: 'Blocked — secret-file read requires interactive confirmation' };
      const ok = await ctx.ui.confirm('Allow the agent to read this secret file?', canonicalAbs);
      if (!ok) return { block: true, reason: 'Blocked — secret file' };
      return;
    }

    if (!insideFolder(cwd, path)) {
      if (READ_TOOLS.has(event.toolName) && publicRead(abs)) return;
      if (!ctx.hasUI) return { block: true, reason: 'Blocked — outside-project access requires interactive confirmation' };
      const verb = READ_TOOLS.has(event.toolName) ? 'read' : event.toolName === 'ls' || event.toolName === 'find' ? 'inspect' : 'modify';
      const ok = await ctx.ui.confirm(`Allow the agent to ${verb} a file outside the project?`, canonical(abs));
      if (!ok) return { block: true, reason: 'Blocked — outside the project folder' };
    }
  });
}
