/*
 * pet — one tiny global companion, powered only by pi's output tokens.
 *
 *   /pet              open the interactive nook
 *   /pet show|hide    control the persistent widget
 *   /pet status       print a compact summary
 *   /pet name <name>  rename the pet
 *
 * State is global across every project: ~/.pi/agent/pet.json
 * One Spark is earned per 500 assistant output tokens. No tools, prompt changes,
 * or model context are added by this extension.
 */
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const WIDGET_KEY = 'pi-pet';
const STATE_FILE = join(getAgentDir(), 'pet.json');
const LOCK_DIR = `${STATE_FILE}.lock`;
const STATE_VERSION = 2;
const OUTPUT_PER_SPARK = 500;
const OUTPUT_PER_XP = 1000;
const MAX_REWARD_KEYS = 5000;
const MAX_DECAY_HOURS = 240;

type StatName = 'fullness' | 'joy' | 'energy';
type ItemKind = 'food' | 'toy' | 'accessory' | 'decor';
type CareKind = 'feed' | 'play' | 'rest' | 'groom';
type PersonalityAxis = 'kind' | 'curious' | 'calm';
type EvolutionPath = 'luminary' | 'tinkerer' | 'dreamer';
type GrowthStage = 'hatchling' | 'brightling' | 'evolved';
type ToolKind = 'read' | 'search' | 'edit' | 'write' | 'test' | 'shell' | 'vcs';
type PetColor = 'text' | 'accent' | 'muted' | 'dim' | 'success' | 'warning' | 'error' | 'borderMuted' | 'selectedBg';

interface PetTheme {
  fg(color: PetColor, text: string): string;
  bg(color: PetColor, text: string): string;
  bold(text: string): string;
}

interface PetState {
  version: number;
  name: string;
  named: boolean;
  species: 'pip';
  xp: number;
  sparks: number;
  outputRemainder: number;
  outputXpRemainder: number;
  lifetimeOutput: number;
  stats: Record<StatName, number>;
  inventory: Record<string, number>;
  equipped: { accessory?: string; decor: string[]; title?: string };
  settings: { visible: boolean; animation: 'full' | 'calm' | 'off' };
  evolution: { path?: EvolutionPath; evolvedAt?: number };
  care: { total: number; counts: Record<CareKind, number> };
  personality: Record<PersonalityAxis, number>;
  achievements: Record<string, number>;
  claimedLevelRewards: number[];
  journal: JournalEntry[];
  tools: { counts: Record<ToolKind, number>; activitiesCompleted: number };
  adventure: {
    active?: { destinationId: string; startedAt: number; readyAt: number; rewardIndex: number };
    completions: Record<string, number>;
    postcards: string[];
    visitors: string[];
    currentVisitor?: string;
    encounter: { pendingVisitor?: string; nextAt: number; completed: number };
  };
  recordedStage: GrowthStage;
  titles: string[];
  createdAt: number;
  updatedAt: number;
  rewarded: string[];
}

interface JournalEntry {
  id: string;
  at: number;
  type: 'adoption' | 'care' | 'growth' | 'evolution' | 'achievement' | 'level' | 'adventure' | 'visitor';
  text: string;
}

interface CatalogItem {
  id: string;
  name: string;
  kind: ItemKind;
  price: number;
  description: string;
  stat?: StatName;
  amount?: number;
  levelRequired?: number;
  shop?: boolean;
  symbol: string;
}

const CATALOG: CatalogItem[] = [
  { id: 'berry', name: 'Moon berry', kind: 'food', price: 6, description: '+14 fullness', stat: 'fullness', amount: 14, symbol: '*' },
  { id: 'biscuit', name: 'Byte biscuit', kind: 'food', price: 14, description: '+30 fullness', stat: 'fullness', amount: 30, symbol: '#' },
  { id: 'feast', name: 'Comet feast', kind: 'food', price: 30, description: '+58 fullness', stat: 'fullness', amount: 58, symbol: '@' },
  { id: 'ball', name: 'Bouncy bit', kind: 'toy', price: 45, description: 'Improves play forever', symbol: 'o' },
  { id: 'book', name: 'Tiny handbook', kind: 'toy', price: 90, description: 'A thoughtful play option', levelRequired: 3, symbol: '?' },
  { id: 'bow', name: 'Blue bow', kind: 'accessory', price: 75, description: 'A smart little bow', symbol: '~' },
  { id: 'glasses', name: 'Round glasses', kind: 'accessory', price: 140, description: 'For serious debugging', levelRequired: 3, symbol: 'oo' },
  { id: 'crown', name: 'Spark crown', kind: 'accessory', price: 320, description: 'Regal and faintly electric', levelRequired: 6, symbol: '^' },
  { id: 'plant', name: 'Desk plant', kind: 'decor', price: 95, description: 'A calm green friend', symbol: 'Y' },
  { id: 'cushion', name: 'Soft cushion', kind: 'decor', price: 125, description: 'For excellent naps', levelRequired: 2, symbol: '=' },
  { id: 'lamp', name: 'Star lamp', kind: 'decor', price: 180, description: 'Makes the nook glow', levelRequired: 4, symbol: '+' },
  { id: 'terminal', name: 'Tiny terminal', kind: 'decor', price: 260, description: 'Runs an even tinier pi', levelRequired: 7, symbol: '[_]' },
  { id: 'apple_chip', name: 'Apple chip', kind: 'food', price: 10, description: '+21 fullness', stat: 'fullness', amount: 21, symbol: '%' },
  { id: 'starlight_soup', name: 'Starlight soup', kind: 'food', price: 22, description: '+43 fullness', stat: 'fullness', amount: 43, levelRequired: 3, symbol: '&' },
  { id: 'tea_set', name: 'Tea set', kind: 'toy', price: 110, description: 'A calm play ritual', levelRequired: 4, symbol: 'c' },
  { id: 'music_box', name: 'Music box', kind: 'toy', price: 170, description: 'Makes play extra joyful', levelRequired: 6, symbol: 'm' },
  { id: 'puzzle_cube', name: 'Puzzle cube', kind: 'toy', price: 230, description: 'A curious challenge', levelRequired: 8, symbol: '[]' },
  { id: 'scarf', name: 'Cozy scarf', kind: 'accessory', price: 95, description: 'Warm in every project', levelRequired: 2, symbol: 's' },
  { id: 'headphones', name: 'Headphones', kind: 'accessory', price: 190, description: 'Deep-focus fashion', levelRequired: 5, symbol: 'd' },
  { id: 'constellation_cape', name: 'Constellation cape', kind: 'accessory', price: 420, description: 'A map of tiny stars', levelRequired: 15, symbol: 'C' },
  { id: 'rug', name: 'Nook rug', kind: 'decor', price: 80, description: 'Softens the whole room', symbol: '_' },
  { id: 'bookshelf', name: 'Bookshelf', kind: 'decor', price: 155, description: 'For collected curiosities', levelRequired: 3, symbol: 'H' },
  { id: 'music_corner', name: 'Music corner', kind: 'decor', price: 225, description: 'A place for quiet songs', levelRequired: 6, symbol: '♫' },
  { id: 'telescope', name: 'Telescope', kind: 'decor', price: 310, description: 'Looks beyond the terminal', levelRequired: 9, symbol: '/o' },
  { id: 'terrarium', name: 'Terrarium', kind: 'decor', price: 390, description: 'A world inside the nook', levelRequired: 15, symbol: '[Y]' },
  // Direct level, achievement, evolution, and adventure rewards (never sold).
  ...[
    ['starter_scarf', 'First scarf', 'accessory', '~'], ['brightling_pin', 'Brightling pin', 'accessory', '*'],
    ['sun_charm', 'Sun charm', 'accessory', '☼'], ['gear_charm', 'Gear charm', 'accessory', '⚙'], ['cloud_charm', 'Cloud charm', 'accessory', '☁'],
    ['care_rosette', 'Care rosette', 'accessory', '✿'], ['token_halo', 'Token halo', 'accessory', '°'], ['tool_belt', 'Tool belt', 'accessory', '='],
    ['leaf_clasp', 'Leaf clasp', 'accessory', '<'], ['rain_hat', 'Rain hat', 'accessory', 'n'], ['prism_goggles', 'Prism goggles', 'accessory', '∞'],
    ['display_shelf', 'Display shelf', 'decor', 'E'], ['postcard_wall', 'Postcard wall', 'decor', 'P'], ['guest_cushion', 'Guest cushion', 'decor', 'u'],
    ['moon_pot', 'Moon pot', 'decor', 'U'], ['book_nook', 'Book nook', 'decor', 'B'], ['comet_mobile', 'Comet mobile', 'decor', 'x'],
  ].map(([id, name, kind, symbol]) => ({ id, name, kind: kind as ItemKind, price: 0, description: 'A treasured reward', shop: false, symbol })),
];

interface AchievementDef {
  id: string;
  name: string;
  description: string;
  rewardItem?: string;
  rewardTitle?: string;
  earned(state: PetState): boolean;
}

interface AdventureDestination {
  id: string;
  name: string;
  level: number;
  durationMs: number;
  rewards: Array<{ kind: 'postcard' | 'item' | 'visitor'; id: string; label: string }>;
}

const ADVENTURES: AdventureDestination[] = [
  { id: 'mosslight', name: 'Mosslight Path', level: 5, durationMs: 30 * 60_000, rewards: [
    { kind: 'postcard', id: 'mosslight', label: 'Mosslight postcard' }, { kind: 'item', id: 'leaf_clasp', label: 'Leaf clasp' }, { kind: 'visitor', id: 'moth', label: 'Moth visitor' },
  ] },
  { id: 'moon_garden', name: 'Moon Garden', level: 6, durationMs: 2 * 3_600_000, rewards: [
    { kind: 'postcard', id: 'moon_garden', label: 'Moon Garden postcard' }, { kind: 'item', id: 'moon_pot', label: 'Moon pot' }, { kind: 'visitor', id: 'snail', label: 'Snail visitor' },
  ] },
  { id: 'rooftops', name: 'Rainy Rooftops', level: 8, durationMs: 4 * 3_600_000, rewards: [
    { kind: 'postcard', id: 'rooftops', label: 'Rooftops postcard' }, { kind: 'item', id: 'rain_hat', label: 'Rain hat' }, { kind: 'visitor', id: 'sparrow', label: 'Sparrow visitor' },
  ] },
  { id: 'underroot', name: 'Archive Underroot', level: 9, durationMs: 6 * 3_600_000, rewards: [
    { kind: 'postcard', id: 'underroot', label: 'Underroot postcard' }, { kind: 'item', id: 'book_nook', label: 'Book nook' }, { kind: 'visitor', id: 'bookworm', label: 'Bookworm visitor' },
  ] },
  { id: 'aurora', name: 'Aurora Workshop', level: 12, durationMs: 8 * 3_600_000, rewards: [
    { kind: 'postcard', id: 'aurora', label: 'Aurora postcard' }, { kind: 'item', id: 'prism_goggles', label: 'Prism goggles' }, { kind: 'visitor', id: 'clockwork_beetle', label: 'Clockwork beetle visitor' },
  ] },
  { id: 'observatory', name: 'Comet Observatory', level: 14, durationMs: 12 * 3_600_000, rewards: [
    { kind: 'postcard', id: 'observatory', label: 'Observatory postcard' }, { kind: 'item', id: 'comet_mobile', label: 'Comet mobile' }, { kind: 'visitor', id: 'starling', label: 'Starling visitor' },
  ] },
];

const now = (): number => Date.now();
const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const itemById = (id: string): CatalogItem | undefined => CATALOG.find((item) => item.id === id);
const sanitizeName = (input: string): string => Array.from(
  input.normalize('NFKC')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(),
).slice(0, 20).join('');
const sanitizeText = (input: string, max = 300): string => Array.from(
  input.normalize('NFKC')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(),
).slice(0, max).join('');
const levelForXp = (xp: number): number => Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 60)) + 1);
const levelFloor = (level: number): number => 60 * (level - 1) ** 2;
const nextLevelAt = (level: number): number => 60 * level ** 2;
const fmt = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);
const emptyCareCounts = (): Record<CareKind, number> => ({ feed: 0, play: 0, rest: 0, groom: 0 });
const emptyToolCounts = (): Record<ToolKind, number> => ({ read: 0, search: 0, edit: 0, write: 0, test: 0, shell: 0, vcs: 0 });
const journalEntry = (type: JournalEntry['type'], text: string): JournalEntry => ({ id: randomUUID(), at: now(), type, text });
const growthStage = (state: PetState): GrowthStage => state.evolution.path ? 'evolved' : levelForXp(state.xp) >= 5 ? 'brightling' : 'hatchling';
const dominantPersonality = (state: PetState): PersonalityAxis => {
  const entries = Object.entries(state.personality) as Array<[PersonalityAxis, number]>;
  return entries.sort((a, b) => b[1] - a[1] || ['kind', 'curious', 'calm'].indexOf(a[0]) - ['kind', 'curious', 'calm'].indexOf(b[0]))[0]![0];
};
const projectedEvolution = (state: PetState): EvolutionPath => ({ kind: 'luminary', curious: 'tinkerer', calm: 'dreamer' })[dominantPersonality(state)] as EvolutionPath;
const decorationSlots = (state: PetState): number => levelForXp(state.xp) >= 11 ? 5 : levelForXp(state.xp) >= 7 ? 4 : 3;
const totalAdventures = (state: PetState): number => Object.values(state.adventure.completions).reduce((sum, count) => sum + (Number(count) || 0), 0);
const addJournal = (state: PetState, type: JournalEntry['type'], text: string): void => {
  state.journal.push(journalEntry(type, text));
  while (state.journal.length > 200) {
    const routine = state.journal.findIndex((entry) => entry.type === 'care');
    state.journal.splice(routine >= 0 ? routine : 0, 1); // preserve milestones before routine care
  }
};
const grantItem = (state: PetState, id: string): void => {
  if (itemById(id)) state.inventory[id] = Math.max(1, state.inventory[id] ?? 0);
};
const grantTitle = (state: PetState, title: string): void => {
  if (!state.titles.includes(title)) state.titles.push(title);
};

const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_care', name: 'Hello, Friend', description: 'Care for your pet once', earned: (s) => s.care.total >= 1 },
  { id: 'well_rounded', name: 'Well Rounded', description: 'Feed, play, and rest 10 times each', rewardItem: 'care_rosette', earned: (s) => s.care.counts.feed >= 10 && s.care.counts.play >= 10 && s.care.counts.rest >= 10 },
  { id: 'gentle_soul', name: 'Gentle Soul', description: 'Reach 50 kindness', rewardTitle: 'Gentle Soul', earned: (s) => s.personality.kind >= 50 },
  { id: 'bright_mind', name: 'Bright Mind', description: 'Reach 50 curiosity', rewardTitle: 'Bright Mind', earned: (s) => s.personality.curious >= 50 },
  { id: 'peaceful_pal', name: 'Peaceful Pal', description: 'Reach 50 calm', rewardTitle: 'Peaceful Pal', earned: (s) => s.personality.calm >= 50 },
  { id: 'word_shower', name: 'Word Shower', description: 'Generate 100k output tokens', earned: (s) => s.lifetimeOutput >= 100_000 },
  { id: 'million_words', name: 'Million Words', description: 'Generate one million output tokens', rewardItem: 'token_halo', earned: (s) => s.lifetimeOutput >= 1_000_000 },
  { id: 'grown_together', name: 'Grown Together', description: 'Reach level 10', earned: (s) => levelForXp(s.xp) >= 10 },
  { id: 'collector', name: 'Collector', description: 'Own 10 permanent items', rewardItem: 'display_shelf', earned: (s) => CATALOG.filter((item) => item.kind !== 'food' && (s.inventory[item.id] ?? 0) > 0).length >= 10 },
  { id: 'toolbelt', name: 'Toolbelt', description: 'Work with reading, searching, editing, writing, and tests', rewardItem: 'tool_belt', earned: (s) => (['read', 'search', 'edit', 'write', 'test'] as ToolKind[]).every((kind) => s.tools.counts[kind] >= 1) },
  { id: 'workshop_friend', name: 'Workshop Friend', description: 'Complete 100 tool activities', earned: (s) => s.tools.activitiesCompleted >= 100 },
  { id: 'traveler', name: 'Little Voyager', description: 'Complete six adventures', rewardTitle: 'Little Voyager', earned: (s) => totalAdventures(s) >= 6 },
  { id: 'correspondent', name: 'Correspondent', description: 'Collect six postcards', rewardItem: 'postcard_wall', earned: (s) => s.adventure.postcards.length >= 6 },
  { id: 'open_door', name: 'Open Door', description: 'Meet three visitors', rewardItem: 'guest_cushion', earned: (s) => s.adventure.visitors.length >= 3 },
];

function reconcileProgress(state: PetState): void {
  const level = levelForXp(state.xp);
  const levelRewards: Array<{ level: number; item?: string; title?: string }> = [
    { level: 2, item: 'starter_scarf' }, { level: 5, item: 'brightling_pin' },
    { level: 8, title: 'Trail Friend' }, { level: 12, title: 'Far Wanderer' },
  ];
  for (const reward of levelRewards) {
    if (level < reward.level || state.claimedLevelRewards.includes(reward.level)) continue;
    if (reward.item) grantItem(state, reward.item);
    if (reward.title) grantTitle(state, reward.title);
    state.claimedLevelRewards.push(reward.level);
    addJournal(state, 'level', `Level ${reward.level} brought a new ${reward.item ? itemById(reward.item)?.name : reward.title}.`);
  }
  if (state.adventure.visitors.length && !state.adventure.encounter.pendingVisitor && state.adventure.encounter.nextAt <= now()) {
    state.adventure.encounter.pendingVisitor = state.adventure.visitors[state.adventure.encounter.completed % state.adventure.visitors.length];
  }
  const stage = growthStage(state);
  if (stage !== state.recordedStage) {
    state.recordedStage = stage;
    addJournal(state, 'growth', stage === 'brightling' ? `${state.name} grew into a brightling.` : `${state.name} completed their evolution.`);
  }
  for (const achievement of ACHIEVEMENTS) {
    if (state.achievements[achievement.id] || !achievement.earned(state)) continue;
    state.achievements[achievement.id] = now();
    if (achievement.rewardItem) grantItem(state, achievement.rewardItem);
    if (achievement.rewardTitle) grantTitle(state, achievement.rewardTitle);
    addJournal(state, 'achievement', `Achievement: ${achievement.name}.`);
  }
}

function recordCare(state: PetState, kind: CareKind): void {
  state.care.total += 1;
  state.care.counts[kind] += 1;
  if (kind === 'feed') state.personality.kind += 2;
  else if (kind === 'play') state.personality.curious += 2;
  else if (kind === 'rest') state.personality.calm += 2;
  else { state.personality.kind += 1; state.personality.calm += 1; }
  addJournal(state, 'care', `${state.name} enjoyed some ${kind === 'feed' ? 'food' : kind}.`);
}

function defaultState(): PetState {
  const timestamp = now();
  return {
    version: STATE_VERSION,
    name: 'Piwi',
    named: false,
    species: 'pip',
    xp: 0,
    sparks: 0,
    outputRemainder: 0,
    outputXpRemainder: 0,
    lifetimeOutput: 0,
    stats: { fullness: 82, joy: 84, energy: 78 },
    inventory: { berry: 2 },
    equipped: { decor: [] },
    settings: { visible: true, animation: 'calm' },
    evolution: {},
    care: { total: 0, counts: emptyCareCounts() },
    personality: { kind: 0, curious: 0, calm: 0 },
    achievements: {},
    claimedLevelRewards: [],
    journal: [journalEntry('adoption', 'A new companion arrived in a brand-new nook.')],
    tools: { counts: emptyToolCounts(), activitiesCompleted: 0 },
    adventure: { completions: {}, postcards: [], visitors: [], encounter: { nextAt: timestamp + 24 * 3_600_000, completed: 0 } },
    recordedStage: 'hatchling',
    titles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    rewarded: [],
  };
}

function normalizeState(raw: unknown): PetState {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<PetState>;
  const stats = value.stats && typeof value.stats === 'object' ? value.stats : base.stats;
  const inventory = value.inventory && typeof value.inventory === 'object' ? value.inventory : base.inventory;
  const equipped = value.equipped && typeof value.equipped === 'object' ? value.equipped : base.equipped;
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : base.settings;
  const care = value.care && typeof value.care === 'object' ? value.care : base.care;
  const careCounts = care.counts && typeof care.counts === 'object' ? care.counts : base.care.counts;
  const personality = value.personality && typeof value.personality === 'object' ? value.personality : base.personality;
  const tools = value.tools && typeof value.tools === 'object' ? value.tools : base.tools;
  const toolCounts = tools.counts && typeof tools.counts === 'object' ? tools.counts : base.tools.counts;
  const adventure = value.adventure && typeof value.adventure === 'object' ? value.adventure : base.adventure;
  const cleanInventory: Record<string, number> = {};
  for (const [id, count] of Object.entries(inventory)) {
    if (itemById(id) && Number.isFinite(count) && count > 0) cleanInventory[id] = Math.floor(count);
  }
  const knownTitles = new Set(['Gentle Soul', 'Bright Mind', 'Peaceful Pal', 'Little Voyager', 'Trail Friend', 'Far Wanderer']);
  const cleanTitles = Array.isArray(value.titles) ? [...new Set(value.titles.filter((title): title is string => typeof title === 'string' && knownTitles.has(title)))] : [];
  const count = (input: unknown): number => Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : 0;
  const timestamp = (input: unknown, fallback: number): number => Number.isFinite(Number(input)) ? Number(input) : fallback;
  const path = value.evolution?.path;
  const validPath = path === 'luminary' || path === 'tinkerer' || path === 'dreamer' ? path : undefined;
  const destinationIds = new Set(ADVENTURES.map((destination) => destination.id));
  const postcardIds = new Set(ADVENTURES.flatMap((destination) => destination.rewards.filter((reward) => reward.kind === 'postcard').map((reward) => reward.id)));
  const visitorIds = new Set(ADVENTURES.flatMap((destination) => destination.rewards.filter((reward) => reward.kind === 'visitor').map((reward) => reward.id)));
  const cleanPostcards = Array.isArray(adventure.postcards) ? [...new Set(adventure.postcards.filter((id): id is string => typeof id === 'string' && postcardIds.has(id)))] : [];
  const cleanVisitors = Array.isArray(adventure.visitors) ? [...new Set(adventure.visitors.filter((id): id is string => typeof id === 'string' && visitorIds.has(id)))] : [];
  const cleanCompletions = Object.fromEntries(Object.entries(adventure.completions && typeof adventure.completions === 'object' ? adventure.completions : {})
    .filter(([id, count]) => destinationIds.has(id) && Number.isFinite(Number(count)) && Number(count) >= 0)
    .map(([id, count]) => [id, Math.floor(Number(count))]));
  const activeAdventure = adventure.active && typeof adventure.active === 'object' && destinationIds.has(String(adventure.active.destinationId))
    ? { destinationId: String(adventure.active.destinationId), startedAt: timestamp(adventure.active.startedAt, now()), readyAt: timestamp(adventure.active.readyAt, now()), rewardIndex: count(adventure.active.rewardIndex) }
    : undefined;
  return {
    version: STATE_VERSION,
    name: typeof value.name === 'string' && sanitizeName(value.name) ? sanitizeName(value.name) : base.name,
    named: typeof value.named === 'boolean' ? value.named : typeof value.name === 'string' && !['Pip', 'Piwi', 'Companion'].includes(sanitizeName(value.name)),
    species: 'pip',
    xp: Number.isFinite(value.xp) ? Math.max(0, Math.floor(value.xp!)) : base.xp,
    sparks: Number.isFinite(value.sparks) ? Math.max(0, Math.floor(value.sparks!)) : base.sparks,
    outputRemainder: Number.isFinite(value.outputRemainder) ? clamp(Math.floor(value.outputRemainder!), 0, OUTPUT_PER_SPARK - 1) : 0,
    outputXpRemainder: Number.isFinite(value.outputXpRemainder) ? clamp(Math.floor(value.outputXpRemainder!), 0, OUTPUT_PER_XP - 1) : 0,
    lifetimeOutput: Number.isFinite(value.lifetimeOutput) ? Math.max(0, Math.floor(value.lifetimeOutput!)) : 0,
    stats: {
      fullness: clamp(Number(stats.fullness) || 0),
      joy: clamp(Number(stats.joy) || 0),
      energy: clamp(Number(stats.energy) || 0),
    },
    inventory: cleanInventory,
    equipped: {
      accessory: typeof equipped.accessory === 'string' && cleanInventory[equipped.accessory] && itemById(equipped.accessory)?.kind === 'accessory' ? equipped.accessory : undefined,
      decor: Array.isArray(equipped.decor)
        ? [...new Set(equipped.decor.filter((id): id is string => typeof id === 'string' && !!cleanInventory[id] && itemById(id)?.kind === 'decor'))].slice(0, 5)
        : [],
      title: typeof equipped.title === 'string' && cleanTitles.includes(equipped.title) ? equipped.title : undefined,
    },
    settings: {
      visible: typeof settings.visible === 'boolean' ? settings.visible : true,
      animation: settings.animation === 'full' || settings.animation === 'off' ? settings.animation : 'calm',
    },
    evolution: { path: validPath, evolvedAt: validPath && Number.isFinite(value.evolution?.evolvedAt) ? value.evolution!.evolvedAt : undefined },
    care: {
      total: Number.isFinite(care.total) ? Math.max(0, Math.floor(care.total)) : 0,
      counts: {
        feed: Number.isFinite(careCounts.feed) ? Math.max(0, Math.floor(careCounts.feed)) : 0,
        play: Number.isFinite(careCounts.play) ? Math.max(0, Math.floor(careCounts.play)) : 0,
        rest: Number.isFinite(careCounts.rest) ? Math.max(0, Math.floor(careCounts.rest)) : 0,
        groom: Number.isFinite(careCounts.groom) ? Math.max(0, Math.floor(careCounts.groom)) : 0,
      },
    },
    personality: {
      kind: Number.isFinite(personality.kind) ? Math.max(0, Math.floor(personality.kind)) : 0,
      curious: Number.isFinite(personality.curious) ? Math.max(0, Math.floor(personality.curious)) : 0,
      calm: Number.isFinite(personality.calm) ? Math.max(0, Math.floor(personality.calm)) : 0,
    },
    achievements: value.achievements && typeof value.achievements === 'object'
      ? Object.fromEntries(Object.entries(value.achievements).filter(([id, at]) => ACHIEVEMENTS.some((achievement) => achievement.id === id) && Number.isFinite(at)).map(([id, at]) => [id, Number(at)]))
      : {},
    claimedLevelRewards: Array.isArray(value.claimedLevelRewards)
      ? [...new Set(value.claimedLevelRewards.filter((level): level is number => Number.isInteger(level) && level > 0))]
      : [],
    journal: Array.isArray(value.journal)
      ? value.journal
          .filter((entry): entry is JournalEntry => !!entry && typeof entry === 'object' && typeof entry.text === 'string' && Number.isFinite(entry.at))
          .map((entry) => ({ ...entry, id: typeof entry.id === 'string' ? sanitizeText(entry.id, 80) : randomUUID(), text: sanitizeText(entry.text), at: Number(entry.at) }))
          .filter((entry) => entry.text)
          .slice(-200)
      : base.journal,
    tools: {
      counts: {
        read: count(toolCounts.read), search: count(toolCounts.search),
        edit: count(toolCounts.edit), write: count(toolCounts.write),
        test: count(toolCounts.test), shell: count(toolCounts.shell), vcs: count(toolCounts.vcs),
      },
      activitiesCompleted: count(tools.activitiesCompleted),
    },
    adventure: {
      active: activeAdventure,
      completions: cleanCompletions,
      postcards: cleanPostcards,
      visitors: cleanVisitors,
      currentVisitor: typeof adventure.currentVisitor === 'string' && cleanVisitors.includes(adventure.currentVisitor) ? adventure.currentVisitor : undefined,
      encounter: {
        pendingVisitor: typeof adventure.encounter?.pendingVisitor === 'string' && cleanVisitors.includes(adventure.encounter.pendingVisitor) ? adventure.encounter.pendingVisitor : undefined,
        nextAt: timestamp(adventure.encounter?.nextAt, now() + 24 * 3_600_000),
        completed: count(adventure.encounter?.completed),
      },
    },
    recordedStage: value.recordedStage === 'brightling' || value.recordedStage === 'evolved' ? value.recordedStage : 'hatchling',
    titles: cleanTitles,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt! : base.createdAt,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt! : base.updatedAt,
    rewarded: Array.isArray(value.rewarded) ? value.rewarded.filter((key): key is string => typeof key === 'string').slice(-MAX_REWARD_KEYS) : [],
  };
}

function applyDecay(state: PetState, timestamp = now()): void {
  const elapsedHours = clamp((timestamp - state.updatedAt) / 3_600_000, 0, MAX_DECAY_HOURS);
  if (elapsedHours <= 0) return;
  state.stats.fullness = clamp(state.stats.fullness - elapsedHours * 0.34);
  state.stats.joy = clamp(state.stats.joy - elapsedHours * 0.2);
  state.stats.energy = clamp(state.stats.energy - elapsedHours * 0.16);
  state.updatedAt = timestamp;
}

function readState(): PetState {
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Preserve malformed data for hand recovery rather than overwriting it.
    const corrupt = `${STATE_FILE}.corrupt-${Date.now()}`;
    try { renameSync(STATE_FILE, corrupt); } catch { /* another process may have moved it */ }
    return defaultState();
  }
  const incomingVersion = typeof parsed === 'object' && parsed ? Number((parsed as { version?: unknown }).version ?? 1) : 1;
  if (incomingVersion > STATE_VERSION) throw new Error(`Pet state v${incomingVersion} is newer than this extension supports (v${STATE_VERSION}).`);
  const state = normalizeState(parsed); // v1 fields are preserved; missing v2 systems receive defaults.
  applyDecay(state);
  return state;
}

function writeState(state: PetState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, STATE_FILE);
}

async function withGlobalState<T>(mutate: (state: PetState) => T): Promise<{ state: PetState; result: T }> {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const owner = `${process.pid}:${randomUUID()}`;
  const ownerFile = join(LOCK_DIR, 'owner');
  const candidate = `${LOCK_DIR}.candidate-${randomUUID()}`;
  mkdirSync(candidate);
  writeFileSync(join(candidate, 'owner'), owner, { encoding: 'utf8', mode: 0o600 });
  let locked = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      renameSync(candidate, LOCK_DIR); // owner identity exists before atomic acquisition
      locked = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      // Never auto-break a stale global lock: unsafe recovery could corrupt progression.
      await sleep(25 + Math.floor(Math.random() * 20));
    }
  }
  if (!locked) {
    rmSync(candidate, { recursive: true, force: true });
    throw new Error('Another Pi session is saving your pet. Try again in a moment; if it persists after a crash, run /locks.');
  }
  try {
    const state = readState();
    const result = mutate(state);
    reconcileProgress(state);
    if (readFileSync(ownerFile, 'utf8') !== owner) throw new Error('Lost the global pet state lock; update was not saved.');
    state.updatedAt = now();
    writeState(state);
    return { state, result };
  } finally {
    try {
      if (readFileSync(ownerFile, 'utf8') === owner) rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch { /* lock was recovered or already released */ }
  }
}

function moodFor(state: PetState): 'happy' | 'sleepy' | 'hungry' | 'lonely' | 'content' {
  if (state.stats.fullness < 25) return 'hungry';
  if (state.stats.energy < 25) return 'sleepy';
  if (state.stats.joy < 25) return 'lonely';
  if ((state.stats.fullness + state.stats.joy + state.stats.energy) / 3 > 78) return 'happy';
  return 'content';
}

function faceFor(state: PetState, frame: number, working: boolean, waking: 'sleepy' | 'one-eye' | 'awake' | undefined = undefined): string[] {
  const mood = moodFor(state);
  const stage = growthStage(state);
  const blink = frame % 7 === 6;
  let eyes = 'o.o';
  if (waking === 'sleepy') eyes = '-.-';
  else if (waking === 'one-eye') eyes = 'o.-';
  else if (waking === 'awake') eyes = 'o.o';
  else if (blink) eyes = '-.-';
  else if (working) eyes = frame % 2 ? 'o.O' : 'O.o';
  else if (mood === 'happy') eyes = '^.^';
  else if (mood === 'sleepy') eyes = '-.-';
  else if (mood === 'hungry') eyes = '._.';
  else if (mood === 'lonely') eyes = 'u.u';

  const accessory = state.equipped.accessory;
  let top = stage === 'hatchling' ? '   /\\_/\\' : '  /\\___/\\';
  if (state.evolution.path === 'luminary') top = '  \\*___*/';
  else if (state.evolution.path === 'tinkerer') top = '  /\\_+_/\\';
  else if (state.evolution.path === 'dreamer') top = '  ~\\___/~';
  if (accessory === 'crown') top = '  /\\_^_/\\';
  else if (accessory === 'bow') top = ' ~/\\___/\\';
  const middle = accessory === 'glasses' || accessory === 'prism_goggles' ? `  (${eyes[0]}-.-${eyes[2]})` : `   (${eyes})`;
  const foot = stage === 'hatchling' ? (working && frame % 2 ? '   < ^ >' : '    > ^ <') : (working && frame % 2 ? '   /| |\\' : '   / > <\\');
  return [top, middle, foot];
}

function statBar(value: number, cells = 8): string {
  const filled = Math.round((clamp(value) / 100) * cells);
  return `${'='.repeat(filled)}${'.'.repeat(cells - filled)}`;
}

function statusText(state: PetState): string {
  const title = state.equipped.title ? ` · ${state.equipped.title}` : '';
  return `${state.name} · Lv ${levelForXp(state.xp)} ${growthStage(state)}${title} · ${moodFor(state)} · F${Math.round(state.stats.fullness)} J${Math.round(state.stats.joy)} E${Math.round(state.stats.energy)} · *${state.sparks}`;
}

const idleActivities = ['cozy in the nook', 'rearranging the tiny cushions', 'watching dust motes sparkle'];
const nightActivities = ['watching the stars', 'counting moonbeams on the rug', 'tucking the nook in for the night'];
const mcpActivities = ['tuning a mysterious signal', 'consulting a faraway gadget', 'sending tiny packets through the stars'];
const greetings = ['stretching awake and ready to help', 'popping up from the nook, bright-eyed and ready', 'doing a tiny ready-to-work wiggle'];
const dailyActivity = (items: string[], state: PetState): string => items[(Math.floor(now() / 86_400_000) + state.name.length) % items.length]!;

function classifyTool(name: string, args: unknown): { kind: ToolKind; activity: string } {
  const raw = name.toLowerCase();
  const lower = raw.split(/[.:/]/).at(-1) ?? raw;
  if (lower === 'read') return { kind: 'read', activity: 'reading over your shoulder' };
  if (lower === 'grep') return { kind: 'search', activity: 'following a trail of tiny clues' };
  if (lower === 'find') return { kind: 'search', activity: 'looking behind the file cabinets' };
  if (lower === 'ls') return { kind: 'search', activity: 'counting the shelves' };
  if (lower === 'edit') return { kind: 'edit', activity: 'holding the patch cables' };
  if (lower === 'write') return { kind: 'write', activity: 'building something small' };
  if (lower === 'web_search') return { kind: 'search', activity: 'scanning the faraway library' };
  if (lower === 'web_fetch') return { kind: 'read', activity: 'unfolding a web postcard' };
  if (lower === 'now') return { kind: 'read', activity: 'checking the little clock' };
  if (lower === 'ask_user') return { kind: 'read', activity: 'waiting politely for a reply' };
  if (lower === 'plan' || lower === 'plan_step' || lower === 'plan_read') return { kind: 'write', activity: 'arranging tomorrow’s sticky notes' };
  if (lower.startsWith('task_') || lower.startsWith('board_')) return { kind: 'write', activity: 'sorting the project pinboard' };
  if (lower === 'todo') return { kind: 'write', activity: 'ticking a tiny checklist' };
  if (lower === 'sub_agent') return { kind: 'search', activity: 'sending helper pigeons' };
  if (lower === 'list_skills' || lower === 'create_skill') return { kind: 'read', activity: 'opening the skill scrapbook' };
  if (lower === 'remember' || lower === 'forget') return { kind: 'write', activity: 'filing a memory carefully away' };
  if (lower.startsWith('wiki_')) return { kind: lower === 'wiki_write' ? 'write' : 'read', activity: lower === 'wiki_write' ? 'pressing a page into the wiki' : 'exploring the wiki stacks' };
  if (lower === 'ingest_source') return { kind: 'read', activity: 'dusting off a new document' };
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') {
    const command = typeof args === 'object' && args ? String((args as { command?: unknown }).command ?? '') : '';
    if (/\b(pytest|vitest|jest|nextest|go\s+test|cargo\s+test|make\s+test|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test)\b/i.test(command)) return { kind: 'test', activity: 'checking the contraption' };
    if (/^\s*git\b/i.test(command)) return { kind: 'vcs', activity: 'sorting the commit garden' };
    return { kind: 'shell', activity: 'wearing a tiny hard hat' };
  }
  // MCP tool names are server-prefixed and intentionally treated as a friendly unknown family.
  if (raw.includes('_') || raw.includes(' ')) return { kind: 'shell', activity: mcpActivities[name.length % mcpActivities.length]! };
  return { kind: 'shell', activity: 'watching a tool sparkle' };
}

class PetWidget {
  private frame = 0;
  private ticks = 0;
  private working = false;
  private activity?: string;
  private greeting?: string;
  private greetingWakeAt = 0;
  private greetingSecondEyeTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingWakeTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingBlinkFirstTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingBlinkFirstEndTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingBlinkSecondTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingEndTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingBlinking = false;
  private state: PetState;
  private lastDiskCheck = 0;
  private lastMtime = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: { requestRender(): void },
    private readonly theme: PetTheme,
    initial: PetState,
  ) {
    this.state = initial;
    try { this.lastMtime = statSync(STATE_FILE).mtimeMs; } catch { this.lastMtime = 0; }
    this.timer = setInterval(() => {
      this.ticks += 1;
      if (this.state.settings.animation !== 'off') this.frame += 1;
      this.refreshFromDisk();
      // Off still checks global changes, but avoids continuous animation redraws.
      if (this.state.settings.animation !== 'off' || this.ticks % 4 === 0) this.tui.requestRender();
    }, initial.settings.animation === 'full' ? 650 : 1400);
    this.timer.unref?.();
  }

  setState(state: PetState): void {
    this.state = state;
    this.frame += 1;
    this.tui.requestRender();
  }

  setWorking(working: boolean): void {
    this.working = working;
    if (working) this.clearGreeting();
    if (!working) this.activity = undefined;
    this.frame += 1;
    this.tui.requestRender();
  }

  setActivity(activity?: string): void {
    this.activity = activity;
    this.frame += 1;
    this.tui.requestRender();
  }

  private clearGreeting(): void {
    for (const timer of [this.greetingWakeTimer, this.greetingSecondEyeTimer, this.greetingBlinkFirstTimer, this.greetingBlinkFirstEndTimer, this.greetingBlinkSecondTimer, this.greetingEndTimer, this.greetingIdleTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.greetingWakeTimer = undefined;
    this.greetingSecondEyeTimer = undefined;
    this.greetingBlinkFirstTimer = undefined;
    this.greetingBlinkFirstEndTimer = undefined;
    this.greetingBlinkSecondTimer = undefined;
    this.greetingEndTimer = undefined;
    this.greetingIdleTimer = undefined;
    this.greetingBlinking = false;
    this.greeting = undefined;
  }

  greet(activity: string): void {
    this.clearGreeting();
    this.greeting = activity;
    this.greetingWakeAt = now() + 2_000;
    this.greetingWakeTimer = setTimeout(() => { this.frame += 1; this.tui.requestRender(); }, 2_000);
    this.greetingSecondEyeTimer = setTimeout(() => { this.frame += 1; this.tui.requestRender(); }, 2_700);
    this.greetingBlinkFirstTimer = setTimeout(() => { this.greetingBlinking = true; this.tui.requestRender(); }, 3_100);
    this.greetingBlinkFirstEndTimer = setTimeout(() => { this.greetingBlinking = false; this.tui.requestRender(); }, 3_400);
    this.greetingBlinkSecondTimer = setTimeout(() => { this.greetingBlinking = true; this.tui.requestRender(); }, 3_800);
    this.greetingEndTimer = setTimeout(() => { this.greetingBlinking = false; this.tui.requestRender(); }, 4_100);
    this.greetingIdleTimer = setTimeout(() => { this.clearGreeting(); this.tui.requestRender(); }, 5_000);
    for (const timer of [this.greetingWakeTimer, this.greetingSecondEyeTimer, this.greetingBlinkFirstTimer, this.greetingBlinkFirstEndTimer, this.greetingBlinkSecondTimer, this.greetingEndTimer, this.greetingIdleTimer]) timer.unref?.();
    this.tui.requestRender();
  }

  private refreshFromDisk(): void {
    if (now() - this.lastDiskCheck < 4000) return;
    this.lastDiskCheck = now();
    applyDecay(this.state);
    try {
      const mtime = statSync(STATE_FILE).mtimeMs;
      if (mtime !== this.lastMtime) {
        this.lastMtime = mtime;
        this.state = readState();
      }
    } catch { /* state has not been created yet */ }
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    if (!this.state.settings.visible) return [];
    const level = levelForXp(this.state.xp);
    const mood = moodFor(this.state);
    if (w < 38) {
      const face = mood === 'happy' ? '(^.^)' : mood === 'sleepy' ? '(-.-)' : mood === 'hungry' ? '(._.)' : '(o.o)';
      return [truncateToWidth(this.theme.fg('accent', `${face} ${this.state.name} L${level}`) + this.theme.fg('muted', ` · *${this.state.sparks}`), w, '')];
    }

    const wakeState = this.greeting ? (this.greetingBlinking ? 'sleepy' : now() < this.greetingWakeAt ? 'sleepy' : now() < this.greetingWakeAt + 700 ? 'one-eye' : 'awake') : undefined;
    const art = faceFor(this.state, this.frame, this.working, wakeState);
    if (w < 68) {
      return [
        truncateToWidth(this.theme.fg('accent', art[0]) + `  ${this.theme.bold(this.state.name)} · Lv ${level} · ${mood}`, w, ''),
        truncateToWidth(this.theme.fg('accent', art[1]) + this.theme.fg('muted', `  F${Math.round(this.state.stats.fullness)} J${Math.round(this.state.stats.joy)} E${Math.round(this.state.stats.energy)} · *${this.state.sparks}`), w, ''),
        truncateToWidth(this.theme.fg('accent', art[2]), w, ''),
      ];
    }

    const night = new Date().getHours() < 7 || new Date().getHours() >= 19;
    const adventureActivity = this.state.adventure.active
      ? this.state.adventure.active.readyAt <= now() ? 'ready to return from an adventure' : `exploring ${this.state.adventure.active.destinationId.replace(/_/g, ' ')}`
      : this.state.adventure.encounter.pendingVisitor ? 'has a visitor at the door' : undefined;
    const equippedName = this.state.equipped.accessory ? itemById(this.state.equipped.accessory)?.name : undefined;
    const baseActivity = this.working ? 'watching Pi work' : mood === 'sleepy' ? 'needs a nap' : mood === 'hungry' ? 'thinking about snacks' : mood === 'lonely' ? 'wants to play' : night ? dailyActivity(nightActivities, this.state) : dailyActivity(idleActivities, this.state);
    const activity = this.activity ?? this.greeting ?? adventureActivity ?? `${baseActivity}${equippedName ? ` · wearing ${equippedName}` : ''}`;
    const decor = this.state.equipped.decor.map((id) => itemById(id)?.symbol).filter(Boolean).join(' ');
    const visitor = this.state.adventure.currentVisitor ? ` · visiting: ${this.state.adventure.currentVisitor.replace(/_/g, ' ')}` : '';
    return [
      truncateToWidth(this.theme.fg('borderMuted', '─ ') + this.theme.fg('accent', `${night ? 'moonlit ' : ''}${this.state.name}'s nook`) + this.theme.fg('borderMuted', ' ─────────────────────────────────'), w, ''),
      truncateToWidth(this.theme.fg('accent', art[0]) + `   ${this.theme.bold(this.state.name)} · Lv ${level}` + this.theme.fg('muted', ` · ${activity}`), w, ''),
      truncateToWidth(this.theme.fg('accent', art[1]) + this.theme.fg('muted', `   fullness ${Math.round(this.state.stats.fullness)}  joy ${Math.round(this.state.stats.joy)}  energy ${Math.round(this.state.stats.energy)}`), w, ''),
      truncateToWidth(this.theme.fg('accent', art[2]) + `   ${this.theme.fg('accent', `* ${this.state.sparks} Sparks`)}${decor ? this.theme.fg('dim', `   nook ${decor}${visitor}`) : this.theme.fg('dim', visitor)}`, w, ''),
    ];
  }

  invalidate(): void { this.frame += 1; }
  dispose(): void {
    clearInterval(this.timer);
    this.clearGreeting();
  }
}

type DashboardAction = 'care' | 'shop' | 'inventory' | 'adventure' | 'encounter' | 'achievements' | 'journal' | 'evolution' | 'rename' | 'settings' | 'close';
const DASHBOARD_ACTIONS: Array<{ id: DashboardAction; label: string; description: string }> = [
  { id: 'care', label: 'Care', description: 'feed, play, or rest' },
  { id: 'shop', label: 'Shop', description: 'spend Sparks' },
  { id: 'inventory', label: 'Collection', description: 'items, titles, visitors and decor' },
  { id: 'adventure', label: 'Adventures', description: 'travel and bring home discoveries' },
  { id: 'encounter', label: 'Encounters', description: 'spend time with visiting friends' },
  { id: 'achievements', label: 'Achievements', description: 'long-term milestones' },
  { id: 'journal', label: 'Journal', description: 'your history together' },
  { id: 'evolution', label: 'Evolution', description: 'growth, personality and paths' },
  { id: 'rename', label: 'Rename', description: 'choose a new name' },
  { id: 'settings', label: 'Settings', description: 'widget and animation' },
  { id: 'close', label: 'Back to work', description: 'close the nook' },
];

class PetDashboard {
  private selected = 0;
  constructor(
    private readonly state: PetState,
    private readonly theme: PetTheme,
    private readonly done: (action: DashboardAction) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) this.selected = (this.selected - 1 + DASHBOARD_ACTIONS.length) % DASHBOARD_ACTIONS.length;
    else if (matchesKey(data, 'down')) this.selected = (this.selected + 1) % DASHBOARD_ACTIONS.length;
    else if (matchesKey(data, 'enter')) this.done(DASHBOARD_ACTIONS[this.selected]!.id);
    else if (matchesKey(data, 'escape') || data === 'q' || data === 'Q') this.done('close');
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    if (w < 30) {
      return [
        truncateToWidth(this.theme.fg('accent', `${this.state.name} · Lv ${levelForXp(this.state.xp)}`), w, ''),
        truncateToWidth(this.theme.fg('muted', `F${Math.round(this.state.stats.fullness)} J${Math.round(this.state.stats.joy)} E${Math.round(this.state.stats.energy)} · *${this.state.sparks}`), w, ''),
        truncateToWidth(this.theme.fg('dim', `> ${DASHBOARD_ACTIONS[this.selected]!.label} · Enter · Esc`), w, ''),
      ];
    }
    const inner = Math.max(20, Math.min(72, w - 4));
    const line = (content = ''): string => {
      const clipped = truncateToWidth(content, inner, '');
      return truncateToWidth(`│ ${clipped}${' '.repeat(Math.max(0, inner - visibleWidth(clipped)))} │`, w, '');
    };
    const border = (left: string, fill: string, right: string): string => truncateToWidth(`${left}${fill.repeat(inner + 2)}${right}`, w, '');
    const level = levelForXp(this.state.xp);
    const floor = levelFloor(level);
    const target = nextLevelAt(level);
    const levelPct = target === floor ? 0 : ((this.state.xp - floor) / (target - floor)) * 100;
    const art = faceFor(this.state, 0, false);
    const ownedDecor = this.state.equipped.decor.map((id) => itemById(id)?.symbol).filter(Boolean).join('   ');
    const statColor = (value: number): PetColor => value < 25 ? 'error' : value < 45 ? 'warning' : value >= 75 ? 'success' : 'text';
    const statLine = (label: string, value: number): string => this.theme.fg(statColor(value), `${label.padEnd(8)} [${statBar(value, 12)}] ${Math.round(value)}`);
    const lines = [
      this.theme.fg('borderMuted', border('╭', '─', '╮')),
      line(this.theme.fg('accent', this.theme.bold(`${this.state.name.toUpperCase()}'S NOOK`)) + this.theme.fg('muted', '   ') + this.theme.fg('accent', `* ${this.state.sparks} Sparks`) + this.theme.fg('muted', ` · ${this.state.outputRemainder}/${OUTPUT_PER_SPARK} to next`)),
      line(),
      line(this.theme.fg('accent', art[0]) + (ownedDecor ? this.theme.fg('success', `   nook ${ownedDecor}`) : '')),
      line(this.theme.fg('accent', art[1]) + `     ${this.state.name} · ${growthStage(this.state)} · Level ${level} · ${moodFor(this.state)}`),
      line(this.theme.fg('accent', art[2]) + `     XP [${statBar(levelPct, 16)}] ${Math.floor(levelPct)}%`),
      line(this.theme.fg('muted', `Personality  kind ${this.state.personality.kind} · curious ${this.state.personality.curious} · calm ${this.state.personality.calm}`)),
      line(),
      line(statLine('Fullness', this.state.stats.fullness)),
      line(statLine('Joy', this.state.stats.joy)),
      line(statLine('Energy', this.state.stats.energy)),
      line(),
    ];
    for (let i = 0; i < DASHBOARD_ACTIONS.length; i += 1) {
      const action = DASHBOARD_ACTIONS[i]!;
      const prefix = i === this.selected ? '> ' : '  ';
      const text = `${prefix}${action.label.padEnd(14)} ${action.description}`;
      lines.push(line(i === this.selected ? this.theme.bg('selectedBg', this.theme.fg('text', this.theme.bold(text))) : this.theme.fg('muted', text)));
    }
    lines.push(line(), line(this.theme.fg('dim', '1 Spark / 500 output · 1 XP / 1k · Up/Down · Enter · Esc')));
    lines.push(this.theme.fg('borderMuted', border('╰', '─', '╯')));
    return lines;
  }

  invalidate(): void {}
}

export default function petExtension(pi: ExtensionAPI): void {
  let state = defaultState();
  let widget: PetWidget | undefined;
  let activeCtx: ExtensionContext | undefined;
  const activeToolActivities = new Map<string, { kind: ToolKind; activity: string }>();

  const syncWidget = (next?: PetState): void => {
    if (next) state = next;
    if (state.settings.visible && activeCtx?.mode === 'tui') {
      activeCtx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        widget?.dispose();
        widget = new PetWidget(tui, theme, state);
        return widget;
      });
    } else if (activeCtx) {
      widget?.dispose();
      widget = undefined;
      activeCtx.ui.setWidget(WIDGET_KEY, undefined);
    }
  };

  const update = async <T>(mutate: (draft: PetState) => T): Promise<T> => {
    const changed = await withGlobalState(mutate);
    state = changed.state;
    widget?.setState(state);
    return changed.result;
  };

  const refreshState = (): void => {
    state = readState();
    widget?.setState(state);
  };

  const careMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    const choice = await ctx.ui.select(`Care for ${state.name}`, [
      'Feed — use food from inventory',
      'Play — increase joy (costs energy)',
      'Rest — restore energy when tired',
      'Groom — a calm moment together',
      'Never mind',
    ]);
    if (!choice || choice === 'Never mind') return;
    if (choice.startsWith('Feed')) {
      const foods = CATALOG.filter((item) => item.kind === 'food' && (state.inventory[item.id] ?? 0) > 0);
      if (!foods.length) {
        ctx.ui.notify('No food in the pantry — visit the shop.', 'warning');
        return;
      }
      const labels = foods.map((item) => `${item.name} x${state.inventory[item.id]} — ${item.description}`);
      const selected = await ctx.ui.select('Choose food', labels);
      const food = foods[labels.indexOf(selected ?? '')];
      if (!food) return;
      const result = await update((draft) => {
        if ((draft.inventory[food.id] ?? 0) < 1) return { ok: false, reason: 'missing' };
        if (draft.stats.fullness > 90) return { ok: false, reason: 'full' };
        draft.inventory[food.id] -= 1;
        if (draft.inventory[food.id] <= 0) delete draft.inventory[food.id];
        draft.stats.fullness = clamp(draft.stats.fullness + (food.amount ?? 0));
        draft.stats.joy = clamp(draft.stats.joy + 2);
        recordCare(draft, 'feed');
        return { ok: true, reason: '' };
      });
      if (!result.ok) ctx.ui.notify(result.reason === 'full' ? `${state.name} is already comfortably full.` : 'That snack was already used in another pi session.', 'warning');
      else ctx.ui.notify(`${state.name} enjoyed the ${food.name}.`, 'info');
      return;
    }
    if (choice.startsWith('Play')) {
      const result = await update((draft) => {
        if (draft.stats.energy < 8) return { ok: false, reason: 'sleepy', leveled: false };
        if (draft.stats.joy >= 96) return { ok: false, reason: 'happy', leveled: false };
        const hasPuzzle = (draft.inventory.puzzle_cube ?? 0) > 0;
        const hasMusic = (draft.inventory.music_box ?? 0) > 0;
        const hasTea = (draft.inventory.tea_set ?? 0) > 0;
        const hasBook = (draft.inventory.book ?? 0) > 0;
        const hasBall = (draft.inventory.ball ?? 0) > 0;
        const gain = hasPuzzle || hasMusic ? 26 : hasTea || hasBook ? 24 : hasBall ? 20 : 14;
        const oldLevel = levelForXp(draft.xp);
        draft.stats.joy = clamp(draft.stats.joy + gain);
        draft.stats.energy = clamp(draft.stats.energy - 8);
        draft.stats.fullness = clamp(draft.stats.fullness - 3);
        recordCare(draft, 'play');
        if (hasTea) draft.personality.calm += 1;
        return { ok: true, reason: '', leveled: levelForXp(draft.xp) > oldLevel };
      });
      if (!result.ok) ctx.ui.notify(result.reason === 'sleepy' ? `${state.name} is too sleepy to play.` : `${state.name} is already delighted.`, 'warning');
      else ctx.ui.notify(`${state.name} had a wonderful time.${result.leveled ? ` Level ${levelForXp(state.xp)}!` : ''}`, 'info');
      return;
    }
    if (choice.startsWith('Rest')) {
      const rested = await update((draft) => {
        if (draft.stats.energy >= 90) return false;
        draft.stats.energy = clamp(draft.stats.energy + 35);
        draft.stats.fullness = clamp(draft.stats.fullness - 4);
        recordCare(draft, 'rest');
        return true;
      });
      ctx.ui.notify(rested ? `${state.name} curled up for a good nap.` : `${state.name} is already well rested.`, rested ? 'info' : 'warning');
      return;
    }
    const groomed = await update((draft) => {
      if (draft.stats.joy >= 96) return false;
      draft.stats.joy = clamp(draft.stats.joy + 10);
      recordCare(draft, 'groom');
      return true;
    });
    ctx.ui.notify(groomed ? `${state.name} looks wonderfully fluffy.` : `${state.name} is already perfectly groomed.`, groomed ? 'info' : 'warning');
  };

  const shopMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    const kinds: Array<{ label: string; kind: ItemKind }> = [
      { label: 'Food', kind: 'food' },
      { label: 'Toys', kind: 'toy' },
      { label: 'Accessories', kind: 'accessory' },
      { label: 'Nook decorations', kind: 'decor' },
    ];
    const category = await ctx.ui.select(`Spark shop · * ${state.sparks}`, [...kinds.map((entry) => entry.label), 'Leave shop']);
    const kind = kinds.find((entry) => entry.label === category)?.kind;
    if (!kind) return;
    const items = CATALOG.filter((item) => item.kind === kind && item.shop !== false);
    const labels = items.map((item) => {
      const owned = kind === 'food' ? `owned ${state.inventory[item.id] ?? 0}` : state.inventory[item.id] ? 'owned' : '';
      const locked = (item.levelRequired ?? 1) > levelForXp(state.xp) ? ` · unlocks Lv ${item.levelRequired}` : '';
      return `${item.name} — *${item.price} · ${item.description}${owned ? ` · ${owned}` : ''}${locked}`;
    });
    const selected = await ctx.ui.select(`${category} · * ${state.sparks}`, labels);
    const item = items[labels.indexOf(selected ?? '')];
    if (!item) return;
    if ((item.levelRequired ?? 1) > levelForXp(state.xp)) {
      ctx.ui.notify(`${item.name} unlocks at level ${item.levelRequired}.`, 'warning');
      return;
    }
    if (item.kind !== 'food' && state.inventory[item.id]) {
      ctx.ui.notify(`You already own the ${item.name}.`, 'info');
      return;
    }
    if (state.sparks < item.price) {
      ctx.ui.notify(`That needs ${item.price} Sparks; you have ${state.sparks}.`, 'warning');
      return;
    }
    const confirmed = await ctx.ui.confirm('Buy item?', `${item.name} for ${item.price} Sparks?`);
    if (!confirmed) return;
    const bought = await update((draft) => {
      if ((item.levelRequired ?? 1) > levelForXp(draft.xp)) return 'locked';
      if (item.kind !== 'food' && draft.inventory[item.id]) return 'owned';
      if (draft.sparks < item.price) return 'poor';
      draft.sparks -= item.price;
      draft.inventory[item.id] = (draft.inventory[item.id] ?? 0) + 1;
      draft.stats.joy = clamp(draft.stats.joy + 3);
      return 'ok';
    });
    if (bought === 'ok') ctx.ui.notify(`${item.name} added to ${state.name}'s inventory.`, 'info');
    else ctx.ui.notify('The pet changed in another pi session; reopen the shop.', 'warning');
  };

  const inventoryMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    const ownedToys = CATALOG.filter((item) => item.kind === 'toy' && (state.inventory[item.id] ?? 0) > 0);
    const category = await ctx.ui.select('Collection', [
      'Items and decorations', `Toys (${ownedToys.length})`, `Titles (${state.titles.length})`, `Visitors (${state.adventure.visitors.length})`,
      `Postcards (${state.adventure.postcards.length})`, 'Back',
    ]);
    if (!category || category === 'Back') return;
    if (category.startsWith('Toys')) {
      const text = ownedToys.length ? ownedToys.map((toy) => `${toy.name}: ${toy.description}`).join(' · ') : 'No toys yet.';
      return void ctx.ui.notify(text, 'info');
    }
    if (category.startsWith('Titles')) {
      if (!state.titles.length) return void ctx.ui.notify('No titles discovered yet.', 'info');
      const labels = ['[none]', ...state.titles.map((title) => `${state.equipped.title === title ? '[on] ' : '[  ] '}${title}`)];
      const selected = await ctx.ui.select('Choose title', labels);
      if (!selected) return;
      await update((draft) => { draft.equipped.title = selected === '[none]' ? undefined : selected.replace(/^\[(?:on|  )\] /, ''); });
      return void ctx.ui.notify('Title updated.', 'info');
    }
    if (category.startsWith('Visitors')) {
      if (!state.adventure.visitors.length) return void ctx.ui.notify('No visitors have found the nook yet.', 'info');
      const labels = ['[none]', ...state.adventure.visitors.map((visitor) => `${state.adventure.currentVisitor === visitor ? '[on] ' : '[  ] '}${visitor.replace(/_/g, ' ')}`)];
      const selected = await ctx.ui.select('Invite a visitor', labels);
      if (!selected) return;
      await update((draft) => {
        if (selected === '[none]') draft.adventure.currentVisitor = undefined;
        else {
          const visitor = draft.adventure.visitors.find((candidate) => candidate.replace(/_/g, ' ') === selected.replace(/^\[(?:on|  )\] /, ''));
          if (visitor && visitor !== draft.adventure.currentVisitor) {
            draft.adventure.currentVisitor = visitor;
            addJournal(draft, 'visitor', `${visitor.replace(/_/g, ' ')} stopped by the nook for a tiny visit.`);
          }
        }
      });
      return void ctx.ui.notify('Visitor scene updated.', 'info');
    }
    if (category.startsWith('Postcards')) {
      const text = state.adventure.postcards.length ? state.adventure.postcards.map((id) => id.replace(/_/g, ' ')).join(' · ') : 'No postcards yet.';
      return void ctx.ui.notify(text, 'info');
    }
    const owned = CATALOG.filter((item) => (state.inventory[item.id] ?? 0) > 0 && item.kind !== 'food' && item.kind !== 'toy');
    if (!owned.length) return void ctx.ui.notify('No equippable items yet — the Spark shop has some.', 'info');
    const labels = owned.map((item) => {
      const equipped = item.kind === 'accessory' ? state.equipped.accessory === item.id : state.equipped.decor.includes(item.id);
      return `${equipped ? '[on] ' : '[  ] '}${item.name} — ${item.description}`;
    });
    const selected = await ctx.ui.select(`Equip items · ${decorationSlots(state)} decor slots`, labels);
    const item = owned[labels.indexOf(selected ?? '')];
    if (!item) return;
    const changed = await update((draft) => {
      if (!draft.inventory[item.id]) return false;
      if (item.kind === 'accessory') draft.equipped.accessory = draft.equipped.accessory === item.id ? undefined : item.id;
      else {
        const has = draft.equipped.decor.includes(item.id);
        if (has) draft.equipped.decor = draft.equipped.decor.filter((id) => id !== item.id);
        else if (draft.equipped.decor.length < decorationSlots(draft)) draft.equipped.decor.push(item.id);
        else return false;
      }
      return true;
    });
    ctx.ui.notify(changed ? 'Nook updated.' : `The nook's ${decorationSlots(state)} decoration slots are full.`, changed ? 'info' : 'warning');
  };

  const renamePet = async (ctx: ExtensionCommandContext, supplied?: string): Promise<void> => {
    const answer = supplied?.trim() || await ctx.ui.input('Pet name', state.named ? state.name : 'Name');
    const name = answer ? sanitizeName(answer) : '';
    if (!name || name.toLowerCase() === 'name') return;
    await update((draft) => {
      const firstName = !draft.named;
      draft.name = name;
      draft.named = true;
      if (firstName) addJournal(draft, 'adoption', `You named your new companion ${name}.`);
    });
    ctx.ui.notify(`Your pet is now named ${name}.`, 'info');
  };

  const ensureNamed = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    refreshState();
    if (state.named) return true;
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Visit `/pet` in interactive mode to name your new companion first.', 'warning');
      return false;
    }
    const answer = await ctx.ui.input('Your new companion is Piwi — choose a name or press Enter to keep it', 'Piwi');
    if (answer === undefined) {
      ctx.ui.notify('Your companion will wait here until you choose a name.', 'info');
      return false;
    }
    const name = sanitizeName(answer) || state.name;
    if (name.toLowerCase() === 'name') {
      ctx.ui.notify('Please choose a real name, or press Enter to keep Piwi.', 'info');
      return false;
    }
    const adopted = await update((draft) => {
      if (draft.named) return { named: false, name: draft.name };
      draft.name = name;
      draft.named = true;
      addJournal(draft, 'adoption', `You named your new companion ${name}.`);
      return { named: true, name };
    });
    ctx.ui.notify(adopted.named ? `Your companion is now named ${adopted.name}.` : `Another session already named your companion ${adopted.name}.`, 'info');
    return true;
  };

  const encounterMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    await update(() => undefined); // reconcile any visitor whose timer became due
    refreshState();
    const visitor = state.adventure.encounter.pendingVisitor;
    if (!visitor) {
      const hours = Math.max(1, Math.ceil((state.adventure.encounter.nextAt - now()) / 3_600_000));
      ctx.ui.notify(state.adventure.visitors.length ? `The nook is quiet. Another friend may visit in about ${hours}h.` : 'Visitors can discover the nook through adventures.', 'info');
      return;
    }
    const label = visitor.replace(/_/g, ' ');
    const choice = await ctx.ui.select(`${label} is at the door`, ['Share tea', 'Look through postcards', 'Invite them to sit quietly', 'Maybe later']);
    if (!choice || choice === 'Maybe later') return;
    const completed = await update((draft) => {
      if (draft.adventure.encounter.pendingVisitor !== visitor) return false;
      draft.adventure.encounter.pendingVisitor = undefined;
      draft.adventure.encounter.completed += 1;
      draft.adventure.encounter.nextAt = now() + 24 * 3_600_000;
      draft.adventure.currentVisitor = visitor;
      draft.stats.joy = clamp(draft.stats.joy + 8);
      addJournal(draft, 'visitor', `${visitor.replace(/_/g, ' ')} visited: ${choice.toLowerCase()}.`);
      return true;
    });
    ctx.ui.notify(completed ? `${state.name} and ${label} had a lovely little visit.` : 'That visitor already left in another session.', completed ? 'info' : 'warning');
  };

  const achievementsMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    const labels = ACHIEVEMENTS.map((achievement) => {
      const earned = !!state.achievements[achievement.id];
      const reward = achievement.rewardItem ? ` · reward: ${itemById(achievement.rewardItem)?.name}` : achievement.rewardTitle ? ` · title: ${achievement.rewardTitle}` : '';
      return `${earned ? '[earned]' : '[locked]'} ${achievement.name} — ${achievement.description}${reward}`;
    });
    const selected = await ctx.ui.select(`Achievements ${Object.keys(state.achievements).length}/${ACHIEVEMENTS.length}`, labels);
    if (selected) ctx.ui.notify(selected, 'info');
  };

  const journalMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    const filter = await ctx.ui.select(`${state.name}'s journal`, ['Milestones', 'Recent activity', 'All entries', 'Back']);
    if (!filter || filter === 'Back') return;
    const milestoneTypes = new Set<JournalEntry['type']>(['adoption', 'growth', 'evolution', 'achievement', 'level', 'adventure', 'visitor']);
    const source = filter === 'Milestones' ? state.journal.filter((entry) => milestoneTypes.has(entry.type))
      : filter === 'Recent activity' ? state.journal.slice(-60) : state.journal;
    const entries = [...source].reverse();
    if (!entries.length) return void ctx.ui.notify('No journal entries in this section yet.', 'info');
    const pageSize = 40;
    for (let offset = 0; offset < entries.length; offset += pageSize) {
      const page = entries.slice(offset, offset + pageSize);
      const hasMore = offset + pageSize < entries.length;
      const labels = page.map((entry) => `${new Date(entry.at).toLocaleDateString()} · ${entry.text}`);
      if (hasMore) labels.push('More older entries…');
      const selected = await ctx.ui.select(`${filter} · ${offset + 1}-${offset + page.length} of ${entries.length}`, labels);
      if (selected === 'More older entries…') continue;
      if (selected) ctx.ui.notify(selected, 'info');
      return;
    }
  };

  const profileMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    const path = state.evolution.path ?? `unevolved · projected ${projectedEvolution(state)}`;
    const title = state.equipped.title ?? 'no title equipped';
    ctx.ui.notify(`${state.name} · Pip species · ${growthStage(state)} · ${path} · ${title} · personality: kind ${state.personality.kind}, curious ${state.personality.curious}, calm ${state.personality.calm} · together since ${new Date(state.createdAt).toLocaleDateString()}`, 'info');
  };

  const evolutionMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    if (state.evolution.path) {
      ctx.ui.notify(`${state.name} is a ${state.evolution.path} — a permanent reflection of your time together.`, 'info');
      return;
    }
    const level = levelForXp(state.xp);
    if (level < 10 || state.care.total < 12) {
      ctx.ui.notify(`Evolution needs level 10 and 12 care moments. Current: level ${level}, care ${state.care.total}/12. Projected path: ${projectedEvolution(state)}.`, 'info');
      return;
    }
    const options: Array<{ path: EvolutionPath; label: string; charm: string }> = [
      { path: 'luminary', label: 'Luminary — warm, kind, and glowing', charm: 'sun_charm' },
      { path: 'tinkerer', label: 'Tinkerer — curious, inventive, and bright', charm: 'gear_charm' },
      { path: 'dreamer', label: 'Dreamer — calm, thoughtful, and moonlit', charm: 'cloud_charm' },
    ];
    const selected = await ctx.ui.select(`Choose a permanent evolution · personality suggests ${projectedEvolution(state)}`, options.map((option) => option.label));
    const option = options.find((candidate) => candidate.label === selected);
    if (!option || !await ctx.ui.confirm('Evolve?', `${option.label}. This choice is permanent.`)) return;
    const evolved = await update((draft) => {
      if (draft.evolution.path || levelForXp(draft.xp) < 10 || draft.care.total < 12) return false;
      draft.evolution = { path: option.path, evolvedAt: now() };
      grantItem(draft, option.charm);
      addJournal(draft, 'evolution', `${draft.name} chose the ${option.path} path.`);
      return true;
    });
    ctx.ui.notify(evolved ? `${state.name} evolved into a ${option.path}!` : 'Evolution requirements changed in another session.', evolved ? 'info' : 'warning');
  };

  const adventureMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    refreshState();
    const active = state.adventure.active;
    if (active) {
      const destination = ADVENTURES.find((entry) => entry.id === active.destinationId);
      if (!destination) return void ctx.ui.notify('This adventure destination is no longer available.', 'warning');
      const remaining = active.readyAt - now();
      if (remaining > 0) {
        const minutes = Math.ceil(remaining / 60_000);
        ctx.ui.notify(`${state.name} is exploring ${destination.name} · ready in ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}.`, 'info');
        return;
      }
      const claim = await update((draft) => {
        const current = draft.adventure.active;
        if (!current || current.readyAt > now()) return undefined;
        const place = ADVENTURES.find((entry) => entry.id === current.destinationId);
        if (!place) return undefined;
        const reward = place.rewards[current.rewardIndex];
        if (reward?.kind === 'item') grantItem(draft, reward.id);
        else if (reward?.kind === 'postcard' && !draft.adventure.postcards.includes(reward.id)) draft.adventure.postcards.push(reward.id);
        else if (reward?.kind === 'visitor' && !draft.adventure.visitors.includes(reward.id)) {
          draft.adventure.visitors.push(reward.id);
          draft.adventure.encounter.pendingVisitor = reward.id;
          addJournal(draft, 'visitor', `${reward.label} discovered the path to ${draft.name}'s nook.`);
        }
        draft.adventure.completions[place.id] = (draft.adventure.completions[place.id] ?? 0) + 1;
        draft.adventure.active = undefined;
        addJournal(draft, 'adventure', `${draft.name} returned from ${place.name}${reward ? ` with ${reward.label}` : ' with another good story'}.`);
        return reward?.label ?? 'a new travel memory';
      });
      ctx.ui.notify(claim ? `${state.name} returned with ${claim}!` : 'That adventure is not ready yet.', claim ? 'info' : 'warning');
      return;
    }
    const unlocked = ADVENTURES.filter((destination) => levelForXp(state.xp) >= destination.level);
    if (!unlocked.length) return void ctx.ui.notify('Adventures unlock when your pet becomes a brightling at level 5.', 'info');
    const labels = unlocked.map((destination) => {
      const count = state.adventure.completions[destination.id] ?? 0;
      const reward = destination.rewards[count];
      const minutes = Math.round(destination.durationMs / 60_000);
      return `${destination.name} · ${minutes < 60 ? `${minutes}m` : `${minutes / 60}h`} · ${reward ? `next: ${reward.label}` : 'a new story'}`;
    });
    const selected = await ctx.ui.select('Choose an adventure', labels);
    const destination = unlocked[labels.indexOf(selected ?? '')];
    if (!destination || !await ctx.ui.confirm('Set out?', `${destination.name} — care remains available while your pet explores.`)) return;
    const started = await update((draft) => {
      if (draft.adventure.active || levelForXp(draft.xp) < destination.level) return false;
      draft.adventure.active = {
        destinationId: destination.id,
        startedAt: now(),
        readyAt: now() + destination.durationMs,
        rewardIndex: draft.adventure.completions[destination.id] ?? 0,
      };
      addJournal(draft, 'adventure', `${draft.name} set out for ${destination.name}.`);
      return true;
    });
    ctx.ui.notify(started ? `${state.name} set out for ${destination.name}.` : 'Another adventure is already active.', started ? 'info' : 'warning');
  };

  const settingsMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const choice = await ctx.ui.select('Pet settings', [
      `Widget: ${state.settings.visible ? 'shown' : 'hidden'}`,
      `Animation: ${state.settings.animation}`,
      'Cancel',
    ]);
    if (!choice || choice === 'Cancel') return;
    if (choice.startsWith('Widget')) {
      await update((draft) => { draft.settings.visible = !draft.settings.visible; });
      syncWidget();
      return;
    }
    const animation = await ctx.ui.select('Animation speed', ['full', 'calm', 'off']);
    if (!animation) return;
    await update((draft) => { draft.settings.animation = animation as PetState['settings']['animation']; });
    syncWidget();
  };

  const visit = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!await ensureNamed(ctx)) return;
    if (ctx.mode !== 'tui') {
      ctx.ui.notify(statusText(state), 'info');
      return;
    }
    while (true) {
      refreshState();
      const action = await ctx.ui.custom<DashboardAction>((tui, theme, _keys, done) => {
        const dashboard = new PetDashboard(state, theme, done);
        return {
          render: (width) => dashboard.render(width),
          invalidate: () => dashboard.invalidate(),
          handleInput: (data) => { dashboard.handleInput(data); tui.requestRender(); },
        };
      });
      if (!action || action === 'close') return;
      if (action === 'care') await careMenu(ctx);
      else if (action === 'shop') await shopMenu(ctx);
      else if (action === 'inventory') await inventoryMenu(ctx);
      else if (action === 'adventure') await adventureMenu(ctx);
      else if (action === 'encounter') await encounterMenu(ctx);
      else if (action === 'achievements') await achievementsMenu(ctx);
      else if (action === 'journal') await journalMenu(ctx);
      else if (action === 'evolution') await evolutionMenu(ctx);
      else if (action === 'rename') await renamePet(ctx);
      else if (action === 'settings') await settingsMenu(ctx);
    }
  };

  pi.on('session_start', async (event, ctx) => {
    activeCtx = ctx;
    const fresh = event.reason === 'new' || event.reason === 'startup';
    const loaded = await withGlobalState((draft) => draft.name);
    state = loaded.state;
    syncWidget();
    if (fresh && state.named) widget?.greet(greetings[Math.floor(Math.random() * greetings.length)]!);
  });

  pi.on('agent_start', () => widget?.setWorking(true));
  pi.on('tool_execution_start', (event) => {
    const activity = classifyTool(event.toolName, event.args);
    activeToolActivities.set(event.toolCallId, activity);
    widget?.setActivity(activity.activity);
  });
  pi.on('tool_execution_end', (event) => {
    const activity = activeToolActivities.get(event.toolCallId);
    activeToolActivities.delete(event.toolCallId);
    // Aggregate tool flavor is best-effort metadata; never delay normal tool completion on the global pet lock.
    if (activity && !event.isError) void withGlobalState((draft) => {
      draft.tools.counts[activity.kind] += 1;
      draft.tools.activitiesCompleted += 1;
    }).then((changed) => {
      state = changed.state;
      widget?.setState(state);
    }).catch(() => { /* token rewards remain exact; cosmetic tool counters may skip one event */ });
    widget?.setActivity([...activeToolActivities.values()].at(-1)?.activity);
  });
  pi.on('agent_settled', () => {
    activeToolActivities.clear();
    widget?.setWorking(false);
  });

  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    const message = event.message as AssistantMessage;
    const output = Math.max(0, Math.floor(message.usage?.output ?? 0));
    if (!output) return;
    const rewardKey = createHash('sha256')
      .update(`${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId() ?? 'root'}:${message.timestamp}:${message.provider}:${message.model}:${output}`)
      .digest('base64url');
    const before = state.sparks;
    const result = await withGlobalState((draft) => {
      if (draft.rewarded.includes(rewardKey)) return 0;
      draft.rewarded.push(rewardKey);
      draft.rewarded = draft.rewarded.slice(-MAX_REWARD_KEYS);
      draft.lifetimeOutput += output;
      const total = draft.outputRemainder + output;
      const earned = Math.floor(total / OUTPUT_PER_SPARK);
      draft.outputRemainder = total % OUTPUT_PER_SPARK;
      draft.sparks += earned;
      if (earned > 0) draft.stats.joy = clamp(draft.stats.joy + Math.min(4, earned / 8));
      const xpTotal = draft.outputXpRemainder + output;
      draft.xp += Math.floor(xpTotal / OUTPUT_PER_XP);
      draft.outputXpRemainder = xpTotal % OUTPUT_PER_XP;
      return earned;
    });
    state = result.state;
    widget?.setState(state);
    if (result.result > 0 && before !== state.sparks && result.result >= 10 && ctx.hasUI) {
      ctx.ui.notify(`${state.name} found ${result.result} Sparks!`, 'info');
    }
  });

  pi.on('session_shutdown', () => {
    activeToolActivities.clear();
    widget?.dispose();
    widget = undefined;
    activeCtx = undefined;
  });

  pi.registerCommand('pet', {
    description: 'Visit and care for your global token-powered pet (/pet help)',
    getArgumentCompletions: (prefix) => {
      const options = ['help', 'profile', 'care', 'shop', 'collection', 'achievements', 'journal', 'evolution', 'adventure', 'encounter', 'settings', 'status', 'name', 'show', 'hide'];
      const query = prefix.trim().toLowerCase();
      const matches = options.filter((value) => value.startsWith(query)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      activeCtx = ctx;
      state = readState();
      const trimmed = args.trim();
      const [command = '', ...rest] = trimmed.split(/\s+/);
      const action = command.toLowerCase();
      if (action === 'show' || action === 'hide' || action === 'toggle') {
        const visible = await update((draft) => {
          draft.settings.visible = action === 'show' ? true : action === 'hide' ? false : !draft.settings.visible;
          return draft.settings.visible;
        });
        syncWidget();
        ctx.ui.notify(`Pet widget ${visible ? 'shown' : 'hidden'}.`, 'info');
        return;
      }
      if (action === 'status') {
        ctx.ui.notify(`${statusText(state)} · ${state.outputRemainder}/${OUTPUT_PER_SPARK} to next Spark`, 'info');
        return;
      }
      if (action === 'help') {
        ctx.ui.notify('One global pet · 1 Spark/500 assistant output tokens · 1 XP/1,000 · profile, care, shop, collection, achievements, journal, evolution, adventures, encounters, name, show/hide, settings', 'info');
        return;
      }
      if (action === 'name' || action === 'rename') {
        await renamePet(ctx, rest.join(' '));
        return;
      }
      if (!['', 'visit'].includes(action) && !await ensureNamed(ctx)) return;
      if (action === 'care') {
        await careMenu(ctx);
        return;
      }
      if (action === 'shop') {
        await shopMenu(ctx);
        return;
      }
      if (action === 'inventory' || action === 'collection') {
        await inventoryMenu(ctx);
        return;
      }
      if (action === 'profile') {
        await profileMenu(ctx);
        return;
      }
      if (action === 'encounter' || action === 'encounters') {
        await encounterMenu(ctx);
        return;
      }
      if (action === 'achievements') {
        await achievementsMenu(ctx);
        return;
      }
      if (action === 'journal') {
        await journalMenu(ctx);
        return;
      }
      if (action === 'evolution' || action === 'evolve') {
        await evolutionMenu(ctx);
        return;
      }
      if (action === 'adventure' || action === 'adventures') {
        await adventureMenu(ctx);
        return;
      }
      if (action === 'settings') {
        await settingsMenu(ctx);
        return;
      }
      if (action && action !== 'visit') {
        ctx.ui.notify('Usage: /pet [show|hide|status|help|profile|name|care|shop|collection|achievements|journal|evolution|adventure|encounter|settings]', 'warning');
        return;
      }
      await visit(ctx);
    },
  });
}
