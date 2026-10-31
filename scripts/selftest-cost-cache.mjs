/**
 * Price-cache test: the gateway keeps `model_costs` for six hours only, so the
 * plugin must remember the prices it has seen. Otherwise every historical row
 * priced by a forgotten model renders as "--" and the credit total shrinks.
 *
 * Run: node scripts/selftest-cost-cache.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenUsage, mergeCostRateCache, normalizeCostRateCache } from '../lib/index.js';

let passed = 0;
function check(label, condition, extra) {
  assert.ok(condition, `${label}${extra === undefined ? '' : ` -> ${extra}`}`);
  passed += 1;
  console.log(`  ok  ${label}`);
}

const work = mkdtempSync(join(tmpdir(), 'dsh-tu-rates-'));
const root = join(work, 'plugin');
const statePath = join(work, 'gw', 'workbuddy2api', 'data', 'state.json');
const backupsDir = join(work, 'gw', 'workbuddy2api', 'backups');
mkdirSync(join(work, 'gw', 'workbuddy2api', 'data'), { recursive: true });
mkdirSync(backupsDir, { recursive: true });
mkdirSync(root, { recursive: true });

const writeState = (accounts) => writeFileSync(statePath, JSON.stringify({ accounts }), 'utf8');
const stateWith = (models) => ({ a1: { model_costs: models } });
const service = () => {
  const fake = Object.create(TokenUsage.prototype);
  fake.root = root;
  fake.costRateCachePath = join(root, 'cost-rates.json');
  fake.costRateRetentionDays = 180;
  fake.costRateCacheSavedAt = 0;
  fake.workbuddyStatePath = statePath;
  fake.costsLoaded = false;
  fake.costSource = 'none';
  fake.costSourcePath = '';
  fake.costSourceStamp = 0;
  fake.costsCheckedAt = 0;
  fake.costRates = {};
  fake.ctx = { logger: { warn() {} } };
  return fake;
};

// ---------------------------------------------------------------------------
console.log('1. merge keeps an old model when a new one shows up');
{
  const cached = {};
  const first = mergeCostRateCache(cached, { 'deepseek-v4.1-flash': { per1k: 0.15, samples: 4 } }, 1_000);
  check('first observation enters the cache', first.rates['deepseek-v4.1-flash'].per1k === 0.15 && first.changed);
  const second = mergeCostRateCache(first.cache, { 'glm-5.3-flash': { per1k: 0.0097, samples: 3 } }, 2_000);
  check('the older price survives', second.rates['deepseek-v4.1-flash'].per1k === 0.15);
  check('the newer price is added', second.rates['glm-5.3-flash'].per1k === 0.0097);
}

console.log('2. retention drops only entries older than the window');
{
  const old = 1_000;
  const now = old + 200 * 24 * 60 * 60 * 1000;
  const merged = mergeCostRateCache(
    { stale: { per1k: 1, samples: 1, firstSeen: old, lastSeen: old } },
    { fresh: { per1k: 2, samples: 1 } },
    now,
    180,
  );
  check('stale entry pruned', merged.rates.stale === undefined);
  check('fresh entry kept', merged.rates.fresh !== undefined);
}

console.log('3. a zero price is a real price, not a missing one');
{
  const merged = mergeCostRateCache({}, { free: { per1k: 0, samples: 2 } }, 1_000);
  check('0 credits/1k is kept', merged.rates.free?.per1k === 0);
}

// ---------------------------------------------------------------------------
console.log('4. loadCostRates remembers prices after the gateway forgets them');
{
  const fake = service();
  writeState(stateWith({ 'deepseek-v4-flash': { cost_per_1k: 0.149254, samples: 9 } }));
  await TokenUsage.prototype.loadCostRates.call(fake);
  check('observed price loaded', fake.costRates['deepseek-v4-flash']?.per1k === 0.149254);
  check('cache file written', existsSync(join(root, 'cost-rates.json')));
  const onDisk = JSON.parse(readFileSync(join(root, 'cost-rates.json'), 'utf8'));
  check('cache file carries the model', onDisk.models['deepseek-v4-flash']?.per1k === 0.149254);

  // The gateway's 6h TTL forgets that model; only glm is in the snapshot now.
  writeState(stateWith({ 'glm-5.3-flash': { cost_per_1k: 0.009735, samples: 3 } }));
  await TokenUsage.prototype.loadCostRates.call(fake);
  check('forgotten model still priced from cache', fake.costRates['deepseek-v4-flash']?.per1k === 0.149254);
  check('newly observed model priced too', fake.costRates['glm-5.3-flash']?.per1k === 0.009735);

  // Gateway down / state file gone: the cache alone must still price history.
  rmSync(statePath, { force: true });
  await TokenUsage.prototype.loadCostRates.call(fake);
  check('cache alone keeps pricing', fake.costRates['deepseek-v4-flash']?.per1k === 0.149254
    && fake.costRates['glm-5.3-flash']?.per1k === 0.009735);
  check('a configured path stays reported as config', fake.costSource === 'config');
}

console.log('5. a broken cache file degrades to the live snapshot');
{
  const fake = service();
  writeFileSync(join(root, 'cost-rates.json'), '{not json', 'utf8');
  writeState(stateWith({ 'deepseek-v4.1-flash-sg': { cost_per_1k: 0.2, samples: 1 } }));
  await TokenUsage.prototype.loadCostRates.call(fake);
  check('live snapshot still priced', fake.costRates['deepseek-v4.1-flash-sg']?.per1k === 0.2);
  check('broken cache replaced with a valid one', JSON.parse(readFileSync(join(root, 'cost-rates.json'), 'utf8')).version === 1);
  rmSync(join(root, 'cost-rates.json'), { force: true });
}

console.log('6. older gateway backups seed prices the 6h window already dropped');
{
  const fake = service();
  writeState(stateWith({ 'glm-5.3-flash': { cost_per_1k: 0.009735, samples: 3 } }));
  writeFileSync(
    join(backupsDir, 'state.json.bak-20261021-123217'),
    JSON.stringify({ accounts: { old: { model_costs: { 'deepseek-v4-pro': { cost_per_1k: 0.42, samples: 5 } } } } }),
    'utf8',
  );
  await TokenUsage.prototype.loadCostRates.call(fake);
  check('backup price seeded', fake.costRates['deepseek-v4-pro']?.per1k === 0.42);
  check('live price still applied', fake.costRates['glm-5.3-flash']?.per1k === 0.009735);
}

console.log('7. the cache survives a hostile payload');
{
  const normalized = normalizeCostRateCache({
    good: { per1k: 0.1, lastSeen: 1 },
    negative: { per1k: -1, lastSeen: 1 },
    nan: { per1k: 'x', lastSeen: 1 },
    timeless: { per1k: 0.3 },
  });
  check('only the valid entry survives', Object.keys(normalized).length === 1 && normalized.good !== undefined);
  check('empty input is tolerated', Object.keys(normalizeCostRateCache(null)).length === 0);
}

rmSync(work, { recursive: true, force: true });
console.log(`\nall ${passed} checks passed`);
