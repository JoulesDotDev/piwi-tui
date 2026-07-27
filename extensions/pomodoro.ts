/**
 * pomodoro — a live work/break cycle widget above the editor.
 *
 *   /pomodoro                 25 min focus / 5 min break, looping rounds
 *   /pomodoro 50 10           custom work/break minutes
 *   /pomodoro 25 0            single countdown, no break (clears when done)
 *   /pomodoro stop            cancel
 *
 * The one "widget" that makes sense in a terminal: a real TUI component that
 * ticks each second, pings at every focus→break→focus turn, and counts rounds
 * until you stop it. Drop-in, no dependencies.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

const KEY = 'pomodoro';
let timer: ReturnType<typeof setInterval> | null = null;
let doneTimer: ReturnType<typeof setTimeout> | null = null;

const mmss = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

interface PomoTheme { fg(color: string, text: string): string; bold(text: string): string }
class PomodoroWidget {
  constructor(private readonly theme: PomoTheme, private readonly phase: 'focus' | 'break', private readonly round: number, private readonly remain: number, private readonly duration: number, private readonly complete = false) {}
  render(width: number): string[] {
    const isFocus = this.phase === 'focus';
    const tone = isFocus ? 'accent' : 'success';
    const label = isFocus ? 'FOCUS' : 'BREAK';
    const icon = isFocus ? '●' : '○';
    const time = mmss(this.remain);
    if (this.complete) {
      const text = width < 18 ? 'Focus done' : '✓ Focus complete · take a break';
      return [truncateToWidth(this.theme.fg('success', text), Math.max(1, width), '')];
    }
    const pct = Math.max(0, Math.min(1, 1 - this.remain / Math.max(1, this.duration)));
    const barWidth = width >= 52 ? 10 : width >= 38 ? 6 : 0;
    const bar = barWidth ? ` ${'▰'.repeat(Math.round(pct * barWidth))}${'▱'.repeat(barWidth - Math.round(pct * barWidth))}` : '';
    const full = `${icon} ${time} · ${label} · round ${this.round}${bar}`;
    const medium = `${icon} ${time} ${label} #${this.round}`;
    const compact = `${time} ${isFocus ? 'F' : 'B'}${this.round}`;
    const text = width >= 38 ? full : width >= 18 ? medium : compact;
    return [truncateToWidth(this.theme.fg(tone, text), Math.max(1, width), '')];
  }
  invalidate(): void {}
}

export default function pomodoroExtension(pi: ExtensionAPI): void {
  pi.on('session_shutdown', () => {
    if (timer) clearInterval(timer);
    if (doneTimer) clearTimeout(doneTimer);
    timer = doneTimer = null;
  });

  pi.registerCommand('pomodoro', {
    description: 'Start a Pomodoro (default 25/5; work 1–180 min, break 0–60 min)',
    getArgumentCompletions: (prefix) => {
      const options = ['25 5', '50 10', '25 0', 'stop'];
      const matches = options.filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === 'stop' || arg === 'cancel' || arg === 'off') {
        if (timer) clearInterval(timer);
        if (doneTimer) clearTimeout(doneTimer);
        timer = doneTimer = null;
        ctx.ui.setWidget(KEY, undefined);
        ctx.ui.notify('Pomodoro stopped.');
        return;
      }

      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) {
        ctx.ui.notify('Usage: /pomodoro [work 1–180] [break 0–60] or /pomodoro stop; break 0 runs once.', 'warning');
        return;
      }
      const work = clamp(parts[0] === undefined ? 25 : Number(parts[0]), 1, 180);
      // an explicit 0 means "no break" (single countdown); omitted → classic 5
      const brk = parts[1] === undefined ? 5 : clamp(Number(parts[1]), 0, 60);
      // Valid new timer: replace any existing one only now.
      if (timer) clearInterval(timer);
      if (doneTimer) clearTimeout(doneTimer);
      timer = doneTimer = null;

      let phase: 'focus' | 'break' = 'focus';
      let round = 1;
      let end = Date.now() + work * 60_000;

      const paint = (remain: number): void => {
        ctx.ui.setWidget(KEY, (_tui, theme) => {
          return new PomodoroWidget(theme, phase, round, remain, phase === 'focus' ? work * 60_000 : brk * 60_000);
        });
      };

      const tick = (): void => {
        let remain = end - Date.now();
        if (remain <= 0 && brk === 0) {
          // no-break mode: one countdown, then a short banner that clears itself
          if (timer) clearInterval(timer);
          timer = null;
          ctx.ui.setWidget(KEY, (_tui, theme) => {
            return new PomodoroWidget(theme, 'focus', round, 0, work * 60_000, true);
          });
          ctx.ui.notify(`Pomodoro complete (${work}m).`, 'info');
          doneTimer = setTimeout(() => ctx.ui.setWidget(KEY, undefined), 10_000);
          doneTimer.unref?.();
          return;
        }
        // Catch up against scheduled boundaries after sleep/suspend instead of restarting a full phase now.
        let transitions = 0;
        while (remain <= 0 && transitions++ < 1000) {
          if (phase === 'focus') {
            phase = 'break';
            end += brk * 60_000;
          } else {
            phase = 'focus';
            round += 1;
            end += work * 60_000;
          }
          remain = end - Date.now();
        }
        if (transitions > 1) ctx.ui.notify(`Pomodoro caught up after pause — ${phase}, round ${round}.`, 'info');
        else if (transitions === 1) ctx.ui.notify(phase === 'break' ? `Round ${round} done — ${brk} min break.` : `Break over — round ${round}, ${work} min focus.`, 'info');
        paint(remain);
      };

      tick();
      timer = setInterval(tick, 1000);
      timer.unref?.(); // don't keep the process alive on our account
      ctx.ui.notify(brk > 0 ? `Pomodoro started — ${work} min focus / ${brk} min break, looping until /pomodoro stop.` : `Pomodoro started — ${work} min.`);
    },
  });
}
