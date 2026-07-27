import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..');
const extensions = readdirSync(join(root, 'extensions')).filter((file) => file.endsWith('.ts')).sort();
const outdir = join(tmpdir(), `piwi-tui-check-${process.pid}`);

try {
  const build = await Bun.build({
    entrypoints: extensions.map((file) => join(root, 'extensions', file)),
    outdir,
    target: 'node',
    external: ['@earendil-works/*', 'typebox'],
  });
  if (!build.success) throw new Error(`Extension build failed:\n${build.logs.join('\n')}`);

  const args = extensions.flatMap((file) => ['-e', join(root, 'extensions', file)]);
  args.push('--list-models');
  const loaded = spawnSync('pi', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (loaded.error) throw loaded.error;
  if (loaded.status !== 0) throw new Error(`Extension load failed (${loaded.status}):\n${loaded.stderr}`);

  const tuiRender = spawnSync('bun', [join(root, 'scripts', 'tui-render-test.ts')], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (tuiRender.error) throw tuiRender.error;
  if (tuiRender.status !== 0) throw new Error(`TUI render check failed (${tuiRender.status}):\n${tuiRender.stderr}`);
  const interactiveViewTest = spawnSync('bun', [join(root, 'scripts', 'interactive-view-test.ts')], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (interactiveViewTest.error) throw interactiveViewTest.error;
  if (interactiveViewTest.status !== 0) throw new Error(`Interactive view regression check failed (${interactiveViewTest.status}):\n${interactiveViewTest.stderr}`);
  const interactiveCommandTest = spawnSync('bun', [join(root, 'scripts', 'interactive-command-test.ts')], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (interactiveCommandTest.error) throw interactiveCommandTest.error;
  if (interactiveCommandTest.status !== 0) throw new Error(`Interactive command regression check failed (${interactiveCommandTest.status}):\n${interactiveCommandTest.stderr}`);
  const guardTest = spawnSync('bun', [join(root, 'scripts', 'guard-test.ts')], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (guardTest.error) throw guardTest.error;
  if (guardTest.status !== 0) throw new Error(`Guard regression check failed (${guardTest.status}):\n${guardTest.stderr}`);
  const wikiTest = spawnSync('bun', [join(root, 'scripts', 'wiki-test.ts')], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (wikiTest.error) throw wikiTest.error;
  if (wikiTest.status !== 0) throw new Error(`Wiki import regression check failed (${wikiTest.status}):\n${wikiTest.stderr}`);
  const todoTest = spawnSync('bun', [join(root, 'scripts', 'todo-test.ts')], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (todoTest.error) throw todoTest.error;
  if (todoTest.status !== 0) throw new Error(`Todo retention regression check failed (${todoTest.status}):\n${todoTest.stderr}`);
  const petLockTest = spawnSync('bun', [join(root, 'scripts', 'pet-lock-test.ts')], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (petLockTest.error) throw petLockTest.error;
  if (petLockTest.status !== 0) throw new Error(`Pet lock regression check failed (${petLockTest.status}):\n${petLockTest.stderr}`);
  const counterTest = spawnSync('bun', [join(root, 'scripts', 'counter-test.ts')], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (counterTest.error) throw counterTest.error;
  if (counterTest.status !== 0) throw new Error(`Counter regression check failed (${counterTest.status}):\n${counterTest.stderr}`);
  const extractionTest = spawnSync('bun', [join(root, 'scripts', 'extraction-test.ts')], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (extractionTest.error) throw extractionTest.error;
  if (extractionTest.status !== 0) throw new Error(`Document extraction regression check failed (${extractionTest.status}):\n${extractionTest.stderr}`);
  const subagentConfigTest = spawnSync('bun', [join(root, 'scripts', 'subagent-config-test.ts')], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (subagentConfigTest.error) throw subagentConfigTest.error;
  if (subagentConfigTest.status !== 0) throw new Error(`Subagent configuration regression check failed (${subagentConfigTest.status}):\n${subagentConfigTest.stderr}`);

  const dark = JSON.parse(readFileSync(join(root, 'themes', 'piwi-theme.json'), 'utf8')) as { name: string; vars?: Record<string, string | number>; colors: Record<string, string | number>; export?: { pageBg?: string } };
  const light = JSON.parse(readFileSync(join(root, 'themes', 'piwi-theme-light.json'), 'utf8')) as { name: string; vars?: Record<string, string | number>; colors: Record<string, string | number>; export?: { pageBg?: string } };
  const schema = JSON.parse(readFileSync(join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'modes', 'interactive', 'theme', 'theme-schema.json'), 'utf8')) as { properties: { colors: { required: string[] } } };
  const darkKeys = Object.keys(dark.colors).sort();
  const lightKeys = Object.keys(light.colors).sort();
  if (JSON.stringify(darkKeys) !== JSON.stringify(lightKeys)) throw new Error('Theme color keys differ between dark and light themes.');
  for (const theme of [dark, light]) {
    const missing = schema.properties.colors.required.filter((key) => !(key in theme.colors));
    if (!theme.name || theme.name.includes('/') || missing.length) throw new Error(`Invalid theme ${theme.name}: missing ${missing.join(', ')}`);
    const vars = theme.vars ?? {};
    for (const [key, value] of Object.entries(theme.colors)) {
      const valid = typeof value === 'number' ? value >= 0 && value <= 255
        : value === '' || /^#[0-9a-f]{6}$/i.test(value) || value in vars;
      if (!valid) throw new Error(`Invalid theme color ${theme.name}.${key}: ${value}`);
    }
    const hex = (value: string | number): string => {
      const resolved = typeof value === 'string' && value in vars ? vars[value]! : value;
      if (typeof resolved !== 'string' || !/^#[0-9a-f]{6}$/i.test(resolved)) throw new Error(`Cannot measure ${theme.name} color ${value}.`);
      return resolved;
    };
    const luminance = (value: string): number => {
      const channels = value.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255).map((part) => part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const page = hex(theme.export?.pageBg ?? '#000000');
    for (const [name, value] of Object.entries(theme.export ?? {})) hex(value);
    const contrast = (foreground: string | number, background: string | number, label: string, minimum = 4.5): void => {
      const ratio = (Math.max(luminance(hex(foreground)), luminance(hex(background))) + 0.05) / (Math.min(luminance(hex(foreground)), luminance(hex(background))) + 0.05);
      if (ratio < minimum) throw new Error(`Low ${theme.name} ${label} contrast (${ratio.toFixed(2)}:1).`);
    };
    for (const role of ['text', 'accent', 'success', 'error', 'warning', 'muted', 'dim']) contrast(theme.colors[role]!, page, role);
    // Transcript surfaces are where Piwi’s custom cards and tools spend most of their time.
    contrast(theme.colors.userMessageText!, theme.colors.userMessageBg!, 'user message');
    contrast(theme.colors.customMessageText!, theme.colors.customMessageBg!, 'custom message');
    contrast(theme.colors.toolTitle!, theme.colors.toolPendingBg!, 'pending tool title');
    contrast(theme.colors.toolTitle!, theme.colors.toolSuccessBg!, 'success tool title');
    contrast(theme.colors.toolTitle!, theme.colors.toolErrorBg!, 'error tool title');
    contrast(theme.colors.toolOutput!, theme.colors.toolPendingBg!, 'pending tool output', 3);
  }

  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(`check passed: ${extensions.length} extensions build/load; renderer widths/completions + interactive controls; guard paths; wiki imports; retained todo; document extraction; helper config; pet/counter locks; ${darkKeys.length} theme colors + contrast match schema`);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
