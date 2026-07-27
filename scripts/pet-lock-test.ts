import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent = mkdtempSync(join(tmpdir(), 'piwi-pet-lock-'));
process.env.PI_CODING_AGENT_DIR = agent;

try {
  const { default: pet } = await import(`../extensions/pet.ts?lock-test=${Date.now()}`);
  const handlers = new Map<string, Function>();
  pet({
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerCommand() {},
  } as never);
  const start = handlers.get('session_start');
  if (!start) throw new Error('Pet did not register session_start.');

  mkdirSync(agent, { recursive: true });
  const lock = join(agent, 'pet.json.lock');
  writeFileSync(lock, '999999:existing-owner', { flag: 'wx' });
  setTimeout(() => rmSync(lock, { force: true }), 80);

  await start(
    { reason: 'startup' },
    { mode: 'json', ui: { setWidget() {} } },
  );

  if (existsSync(lock)) throw new Error('Pet lock was not released.');
  const state = JSON.parse(readFileSync(join(agent, 'pet.json'), 'utf8')) as { version?: number };
  if (state.version !== 2) throw new Error('Pet state was not written after lock contention.');
  console.log('pet exclusive-file lock regression passed');
} finally {
  rmSync(agent, { recursive: true, force: true });
}
