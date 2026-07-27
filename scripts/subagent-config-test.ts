import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent = mkdtempSync(join(tmpdir(), 'piwi-subagent-config-'));
process.env.PI_CODING_AGENT_DIR = agent;

try {
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'subagents.json'), JSON.stringify({ model: 'openai-codex/gpt-5.4-mini', thinking: 'low' }));
  const { helperConfig, helperCliArgs } = await import(`../extensions/subagent.ts?config-test=${Date.now()}`);
  const config = helperConfig();
  if (config.model !== 'openai-codex/gpt-5.4-mini' || config.thinking !== 'low') throw new Error('Valid helper defaults were not loaded.');
  const args = helperCliArgs('Audit one function.', config.model, config.thinking);
  const modelAt = args.indexOf('--model');
  const thinkingAt = args.indexOf('--thinking');
  if (args[modelAt + 1] !== config.model || args[thinkingAt + 1] !== config.thinking) throw new Error('Helper defaults were not passed to the child CLI.');
  if (args.at(-1) !== 'Audit one function.') throw new Error('Helper task was not the final CLI argument.');

  writeFileSync(join(agent, 'subagents.json'), JSON.stringify({ model: '  ', thinking: 'impossible' }));
  const invalid = helperConfig();
  if (invalid.model !== undefined || invalid.thinking !== undefined) throw new Error('Invalid helper defaults were accepted.');
  console.log('subagent model/thinking configuration regression passed');
} finally {
  rmSync(agent, { recursive: true, force: true });
}
