import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import guard from '../extensions/guard.ts';

const root = mkdtempSync(join(tmpdir(), 'piwi-guard-'));
const cwd = join(root, 'project');
const outside = join(root, 'outside');
mkdirSync(cwd); mkdirSync(outside);
writeFileSync(join(cwd, 'inside.txt'), 'inside');
writeFileSync(join(cwd, '.env'), 'TOKEN=secret');
writeFileSync(join(outside, 'outside.txt'), 'outside');
symlinkSync(outside, join(cwd, 'link-out'));
symlinkSync(join(root, 'missing'), join(cwd, 'link-dangling'));

const handlers = new Map<string, Function>();
guard({ on(event: string, handler: Function) { handlers.set(event, handler); }, registerCommand() {} });
const hook = handlers.get('tool_call');
if (!hook) throw new Error('Guard did not register a tool_call hook.');
const ctx = { cwd, hasUI: false, ui: {} };
const blocked = async (toolName: string, input: Record<string, unknown>): Promise<boolean> => Boolean((await hook({ toolName, input }, ctx))?.block);
const expect = async (label: string, expected: boolean, toolName: string, input: Record<string, unknown>): Promise<void> => {
  const actual = await blocked(toolName, input);
  if (actual !== expected) throw new Error(`${label}: expected ${expected ? 'block' : 'allow'}, got ${actual ? 'block' : 'allow'}`);
};

try {
  // Literal Bash handling: safe forms stay quiet; clear escapes fail closed headlessly.
  for (const [label, command] of [
    ['inside relative', 'cat ./inside.txt'],
    ['inside absolute', `cat ${join(cwd, 'inside.txt')}`],
    ['new local redirect', 'printf x > ./created.txt'],
    ['regex source', "node -e 'text.replace(/word/g, replacement)'"],
    ['perl regex', "perl -pe '/word/g' input.txt"],
    ['rg glob option', "rg -g '*.ts' 'pattern' ."],
    ['awk slash separator', "find . -maxdepth 2 -print | awk -F/ 'NF==2 {print $2}'"],
    ['loopback URL', 'curl http://localhost:3000/health'],
    ['dev sink', 'printf x >/dev/null'],
    ['shell comment', 'echo ready # /definitely/not/a/path'],
    ['attached local option path', 'curl -o./local-output http://localhost:3000/health'],
    ['ordinary argument', 'echo local-output'],
    ['simple safe variable', 'target=./inside.txt; cat "$target"'],
    ['rsync inline exclude pattern', "rsync -a --exclude='extensions/.omc' ./ ./mirror/"],
    ['rsync separate exclude pattern', "rsync -a --exclude extensions/.omc ./ ./mirror/"],
  ] as const) await expect(label, false, 'bash', { command });

  for (const [label, command] of [
    ['parent traversal', 'cat ../outside/outside.txt'],
    ['quoted external path', `cat '${join(outside, 'outside.txt')}'`],
    ['external directory path', 'cat /etc/'],
    ['external redirect', `printf x > ${join(outside, 'new.txt')}`],
    ['home path', 'cat ~/anything'],
    ['bare home', 'rm -rf ~'],
    ['external URL', 'curl https://example.com/path'],
    ['outgoing symlink', 'cat link-out/outside.txt'],
    ['dangling symlink', 'cat link-dangling/file'],
    ['simple escaping variable', `target=${join(outside, 'outside.txt')}; cat "$target"`],
    ['next line after comment', `echo ready # comment\ncat ${join(outside, 'outside.txt')}`],
    ['attached external option path', `curl -o${join(outside, 'new.txt')} http://localhost:3000/health`],
    ['equals external option path', `cp --target-directory=${outside} inside.txt`],
    ['named home path', 'cat ~root/.ssh/id_rsa'],
    ['file URL', 'curl file:///etc/passwd'],
    ['rsync exclude file', 'rsync -a --exclude-from=/etc/rsync-excludes ./ ./mirror/'],
    ['rsync outside destination', `rsync -a --exclude='extensions/.omc' ./ ${outside}/`],
  ] as const) await expect(label, true, 'bash', { command });

  await expect('process safe command', false, 'process', { action: 'start', command: 'cat ./inside.txt' });
  await expect('process external command', true, 'process', { action: 'start', command: `cat ${join(outside, 'outside.txt')}` });

  // Structured built-ins: write/edit, read/search, and directory inspection share path policy.
  for (const [label, toolName, path] of [
    ['structured inside read', 'read', 'inside.txt'],
    ['structured inside write', 'write', 'created.txt'],
    ['structured inside edit', 'edit', 'inside.txt'],
    ['structured inside grep', 'grep', 'inside.txt'],
    ['structured inside find', 'find', '.'],
    ['structured inside ls', 'ls', '.'],
    ['structured secret write', 'write', '.env'],
  ] as const) await expect(label, false, toolName, { path });

  for (const [label, toolName, path] of [
    ['structured outside read', 'read', '../outside/outside.txt'],
    ['structured outside write', 'write', '../outside/new.txt'],
    ['structured outside edit', 'edit', '../outside/outside.txt'],
    ['structured outside grep', 'grep', '../outside/outside.txt'],
    ['structured outside find', 'find', '../outside'],
    ['structured outside ls', 'ls', '../outside'],
    ['structured secret read', 'read', '.env'],
    ['structured secret grep', 'grep', '.env'],
    ['structured outgoing symlink', 'read', 'link-out/outside.txt'],
    ['structured dangling symlink', 'read', 'link-dangling/file'],
  ] as const) await expect(label, true, toolName, { path });

  console.log('guard literal-path regression checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
