/**
 * dsh-token-usage -- host half.
 *
 * Two jobs, deliberately split from the client half:
 *
 *  1. Ledger. Fold every settled assistant message's provider-reported usage into
 *     a per-session record, persist it, and backfill sessions that predate the
 *     plugin by replaying their logs.
 *
 *  2. Transport. Publish the ledger over the official Remote seam
 *     (`ctx.tokenLedger`), so the browser can read it through a client resource
 *     instead of a self-built HTTP route.
 *
 * Why no HTTP: a third-party plugin's `apply()` runs before the web composition
 * mounts `webServer`, so an eager `ctx.get('webServer')` silently skips route
 * registration and every request then falls through to the SPA fallback, which
 * answers 405 for any non-GET method. The Remote seam sidesteps that entirely --
 * it is part of the base bundle, so it is always present.
 *
 * The live, per-session figures the UI shows are NOT read here: the client gets
 * them straight from the official `useProjection` hook, which is the same data
 * the host folds here. This file only owns what a projection cannot express --
 * the cross-session aggregate.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { zstdDecompressSync } from 'node:zlib';
import { Service } from '@deepseek-ai/cordis';
import z from 'schemastery';

// --- WorkBuddy gateway state: automatic discovery -------------------------
//
// `workbuddyStatePath` remains the explicit override. When it is empty the Host
// looks for the workbuddy2api gateway's ledger itself, so the 积分 view works
// without hand-editing a machine-specific path. Every candidate is validated by
// parsing it and requiring `accounts[*].model_costs`, which keeps an unrelated
// `state.json` from being mistaken for the gateway's.
const WORKBUDDY_STATE_ENV = ['WORKBUDDY_STATE_PATH', 'WORKBUDDY2API_STATE', 'WB_STATE_PATH'];
const WORKBUDDY_STATE_TAILS = [
  ['wb-deploy', 'workbuddy2api', 'data', 'state.json'],
  ['workbuddy2api', 'data', 'state.json'],
  ['docker', 'wb-deploy', 'workbuddy2api', 'data', 'state.json'],
];
const WORKBUDDY_SCAN_SKIP = new Set([
  'node_modules', '$recycle.bin', 'system volume information', 'windows',
  'program files', 'program files (x86)', 'programdata', 'appdata',
  'application data', 'recovery', 'perflogs', 'msocache', 'temp', 'tmp',
  'cache', 'caches', '.git', '.svn', 'venv', '.venv', '__pycache__',
  '$windows.~bt', '$windows.~ws', 'config.msi',
]);
const WORKBUDDY_SCAN_DIRS = 500;
const WORKBUDDY_SCAN_DEPTH = 4;
/** Memoized hit: re-validated on every call, so a moved ledger is re-discovered. */
let workbuddyStateMemo = '';

/** Whether one file is a WorkBuddy gateway ledger that carries credit prices. */
function workbuddyStateLooksUsable(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    if (!existsSync(path)) return false;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const accounts = doc?.accounts;
    if (accounts === null || typeof accounts !== 'object') return false;
    for (const account of Object.values(accounts)) {
      const costs = account?.model_costs;
      if (costs !== null && typeof costs === 'object' && Object.keys(costs).length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Mounted drive roots, in the order the gateway is most likely to live on. */
function workbuddyDriveRoots() {
  const roots = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) roots.push(root);
    } catch {
      /* an unreadable drive is simply not a candidate */
    }
  }
  return roots;
}

/**
 * Bounded breadth-first search for a `workbuddy2api` directory under one root.
 * The budget is per root so a large system drive cannot starve the others.
 * @param root - drive root, with its trailing separator.
 * @returns the validated ledger path, or '' when this root has none.
 */
function scanRootForWorkbuddyState(root) {
  const queue = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < WORKBUDDY_SCAN_DIRS) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    visited += 1;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      if (name.startsWith('.') || WORKBUDDY_SCAN_SKIP.has(name)) continue;
      const full = join(current.path, entry.name);
      if (name === 'workbuddy2api') {
        const candidate = join(full, 'data', 'state.json');
        if (workbuddyStateLooksUsable(candidate)) return candidate;
        continue;
      }
      if (current.depth < WORKBUDDY_SCAN_DEPTH) queue.push({ path: full, depth: current.depth + 1 });
    }
  }
  return '';
}

/**
 * Find the WorkBuddy gateway ledger without configuration.
 * @returns the first validated candidate path, or '' when nothing matches.
 */
function discoverWorkbuddyStatePath() {
  if (workbuddyStateMemo !== '' && workbuddyStateLooksUsable(workbuddyStateMemo)) {
    return workbuddyStateMemo;
  }
  workbuddyStateMemo = '';
  for (const name of WORKBUDDY_STATE_ENV) {
    const value = process.env[name];
    if (value && workbuddyStateLooksUsable(value)) {
      workbuddyStateMemo = value;
      return value;
    }
  }
  const roots = workbuddyDriveRoots();
  for (const root of roots) {
    for (const tail of WORKBUDDY_STATE_TAILS) {
      const candidate = join(root, ...tail);
      if (workbuddyStateLooksUsable(candidate)) {
        workbuddyStateMemo = candidate;
        return candidate;
      }
    }
  }
  for (const root of roots) {
    const found = scanRootForWorkbuddyState(root);
    if (found !== '') {
      workbuddyStateMemo = found;
      return found;
    }
  }
  return '';
}

/** The modification stamp used to notice that the gateway rewrote its ledger. */
function workbuddyStateStamp(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
// --- end WorkBuddy discovery ---------------------------------------------


// The Remote decorator is what publishes a method on the client's
// `ctx.remote.tokenUsage`. It ships in @deepseek-ai/dsh-typert-protocol, which is
// a peer of the base bundle -- present in every real composition. It is
// imported leniently so the ledger below still loads (and can be unit tested)
// in an environment that does not resolve it; in that case the service mounts
// without an RPC surface rather than failing to load at all.
let Remote = null;
let TypertRemoteService = null;
try {
  ({ Remote, TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol'));
} catch {
  Remote = null;
  TypertRemoteService = null;
}

/**
 * `TypertRemoteService` registers the service key as a Remote namespace in the
 * Gateway's source-mode discovery. Without it the method markers alone are not
 * enough for the browser to see `ctx.remote.tokenUsage`. Fall back to plain
 * `Service` when the protocol package is unavailable, so the ledger still runs.
 */
const RemoteServiceBase = TypertRemoteService ?? Service;

export const name = 'dsh-token-usage';
export const inject = ['sessionProjections'];

// ---------------------------------------------------------------- constants

/** The four disjoint usage buckets DSH reports. */
export function zeroBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * DeepSeek official list prices in USD per 1M tokens (peak tier, fetched from
 * https://api-docs.deepseek.com/quick_start/pricing on 2026-10-24). Only models
 * with an official entry are included; other routes stay outside the coverage.
 */
const OFFICIAL_DEEPSEEK_RATES = {
  'deepseek-v4.1-flash': { cacheRead: 0.006, input: 0.30, output: 1.20 },
  'deepseek-flash': { cacheRead: 0.006, input: 0.30, output: 1.20 },
  'deepseek-v4-pro': { cacheRead: 0.044, input: 1.32, output: 3.96 },
};

/**
 * Zhipu BigModel official list prices in CNY per 1M tokens, fetched from
 * https://docs.bigmodel.cn/cn/guide/start/pricing on 2026-10-24. Zhipu has no
 * peak/off-peak split for these models; the Host converts them with the live
 * USD/CNY rate before pricing.
 */
const OFFICIAL_CNY_RATES = {
  'glm-5.3-flash': { cacheRead: 0.23, input: 0.80, output: 2.80 },
  'glm-5.3': { cacheRead: 2.00, input: 8.00, output: 28.00 },
};


/** DeepSeek peak windows in Beijing wall-clock hours: Mon-Fri 09:00-12:00 and 14:00-18:00. */
const PEAK_WINDOWS = [[9, 12], [14, 18]];

/**
 * Which price tier one instant belongs to.
 *
 * DeepSeek halves every list price outside its peak windows; weekends and
 * Chinese statutory holidays are off-peak all day. The windows are fixed in
 * Beijing time, independent of the Host process timezone.
 * @param epochMs - event time in epoch milliseconds.
 * @param holidays - set of `YYYY-MM-DD` Beijing dates that are off-peak all day.
 * @returns 'peak' or 'offpeak'.
 */
export function pricingTierOf(epochMs, holidays) {
  const shifted = new Date((Number(epochMs) || Date.now()) + 8 * 60 * 60 * 1000);
  const weekday = shifted.getUTCDay();
  if (weekday === 0 || weekday === 6) return 'offpeak';
  if (holidays instanceof Set && holidays.has(shifted.toISOString().slice(0, 10))) return 'offpeak';
  const hour = shifted.getUTCHours();
  for (const [from, to] of PEAK_WINDOWS) if (hour >= from && hour < to) return 'peak';
  return 'offpeak';
}

/** Off-peak unit prices are exactly half the peak list price. */
function halfRates(rate) {
  return { cacheRead: rate.cacheRead / 2, input: rate.input / 2, output: rate.output / 2 };
}

/** Resolve a model's official rate to USD and whether it has peak/off-peak tiers. */
function officialRateOf(model, usdToCny, catalog) {
  const usd = (catalog?.usd ?? OFFICIAL_DEEPSEEK_RATES)[model];
  if (usd !== undefined) return { ...usd, tiered: true, currency: 'USD' };
  const cny = (catalog?.cny ?? OFFICIAL_CNY_RATES)[model];
  if (cny !== undefined) {
    const fx = Number(usdToCny) > 0 ? Number(usdToCny) : 7.2;
    return {
      cacheRead: cny.cacheRead / fx,
      input: cny.input / fx,
      output: cny.output / fx,
      tiered: false,
      currency: 'CNY',
    };
  }
  return undefined;
}

/** Official pricing pages used by the refresh button. */
const OFFICIAL_PRICE_SOURCES = {
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  glm: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
};

function stripCell(value) {
  return String(value).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parse the peak prices from the DeepSeek docs table. */
function parseDeepSeekRates(html) {
  const peakOf = (marker) => {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const match = html.slice(at, at + 1400).match(/>PEAK<\/td><td>\$([0-9.]+)<\/td><td>\$([0-9.]+)<\/td>/i);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const cache = peakOf('CACHE HIT)');
  const miss = peakOf('CACHE MISS)');
  const output = peakOf('1M OUTPUT TOKENS');
  if (!cache || !miss || !output) return {};
  const first = { cacheRead: cache[0], input: miss[0], output: output[0] };
  const second = { cacheRead: cache[1], input: miss[1], output: output[1] };
  return {
    'deepseek-v4.1-flash': first,
    'deepseek-flash': first,
    'deepseek-v4-pro': second,
  };
}

/** Parse Zhipu's CNY per-1M-token table rows. */
function parseGlmRates(html) {
  const rates = {};
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => stripCell(cell[1]));
    if (cells.length < 6) continue;
    const key = cells[0] === 'GLM-5.3-Flash' ? 'glm-5.3-flash'
      : cells[0] === 'GLM-5.3' ? 'glm-5.3'
        : null;
    if (key === null) continue;
    const input = Number(cells[2]);
    const output = Number(cells[3]);
    const cacheRead = Number(cells[5]);
    if ([input, output, cacheRead].every((value) => Number.isFinite(value) && value >= 0)) {
      rates[key] = { cacheRead, input, output };
    }
  }
  return rates;
}

/** Price one bucket record against one rate row (USD). */
function priceBuckets(buckets, rate) {
  const cacheRead = Number(buckets?.cacheReadTokens) || 0;
  const input = (Number(buckets?.uncachedInputTokens) || 0) + (Number(buckets?.cacheWriteTokens) || 0);
  const output = Number(buckets?.outputTokens) || 0;
  return (cacheRead / 1e6) * rate.cacheRead + (input / 1e6) * rate.input + (output / 1e6) * rate.output;
}

/** Total tokens of one bucket record. */
function totalsOfBuckets(buckets) {
  return (Number(buckets?.cacheReadTokens) || 0)
    + (Number(buckets?.uncachedInputTokens) || 0)
    + (Number(buckets?.cacheWriteTokens) || 0)
    + (Number(buckets?.outputTokens) || 0);
}

/** Readable update failure: decode the CLIXML and hint at a private repo. */
function describeUpdateError(error) {
  const message = cleanPowerShellError(String(error?.message ?? error));
  if (/401|403|未经授权|unauthorized/i.test(message)) {
    return `${message}（仓库是私有的：在配置里填 updateToken，或把仓库设为公开）`;
  }
  if (/404|not found/i.test(message)) {
    return `${message}（仓库不存在或为私有：私有仓库需在配置里填 updateToken，或把仓库设为公开）`;
  }
  return message;
}

/** Turn PowerShell's CLIXML stderr into one readable line. */
function cleanPowerShellError(text) {
  const raw = String(text ?? '');
  if (!raw.includes('<S S="Error">')) return raw.replace(/\s+/g, ' ').trim();
  const parts = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => match[1].replace(/_x000D__x000A_/g, '\n').replace(/\s+/g, ' ').trim());
  return parts.join(' | ') || raw;
}

/** Compare two dotted versions; >0 means `a` is newer than `b`. */
function compareVersions(a, b) {
  const left = String(a ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Normalize one `{ peak, offpeak }` tier pair. */
function normalizeTierPair(value) {
  return {
    peak: { ...zeroBuckets(), ...(value?.peak ?? {}) },
    offpeak: { ...zeroBuckets(), ...(value?.offpeak ?? {}) },
  };
}

/** Normalize a stored per-day, per-route tier map; malformed entries are dropped. */
function normalizeDayRoutes(value) {
  const out = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [day, routes] of Object.entries(value)) {
    if (routes === null || typeof routes !== 'object') continue;
    const dayOut = {};
    for (const [route, tiers] of Object.entries(routes)) {
      if (tiers === null || typeof tiers !== 'object') continue;
      dayOut[route] = normalizeTierPair(tiers);
    }
    out[day] = dayOut;
  }
  return out;
}

/** Normalize a stored per-route tier split; malformed entries are dropped. */
function normalizeRouteTiers(value) {
  const out = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [route, tiers] of Object.entries(value)) {
    if (tiers === null || typeof tiers !== 'object') continue;
    out[route] = {
      peak: { ...zeroBuckets(), ...(tiers.peak ?? {}) },
      offpeak: { ...zeroBuckets(), ...(tiers.offpeak ?? {}) },
    };
  }
  return out;
}

/** Sum a `route -> buckets` map into one bucket record. */
function sumRoutes(routes) {
  const total = zeroBuckets();
  for (const buckets of Object.values(routes ?? {})) {
    if (buckets === null || typeof buckets !== 'object') continue;
    for (const key of Object.keys(total)) total[key] += Number(buckets[key]) || 0;
  }
  return total;
}

/** Normalize a stored/absent per-route map; absent maps fall back to the old single route. */
function normalizeRoutes(routes, fallbackRoute, totals) {
  const out = {};
  if (routes !== null && typeof routes === 'object') {
    for (const [route, buckets] of Object.entries(routes)) {
      if (buckets !== null && typeof buckets === 'object') out[route] = { ...zeroBuckets(), ...buckets };
    }
  }
  if (Object.keys(out).length === 0) {
    const route = typeof fallbackRoute === 'string' && fallbackRoute !== '' ? fallbackRoute : 'unknown';
    out[route] = { ...zeroBuckets(), ...(totals ?? {}) };
  }
  return out;
}

/** A record whose breakdown has only the legacy single fallback bucket. */
function isCoarseRecord(record) {
  const routes = record.routes;
  if (routes === null || typeof routes !== 'object') return true;
  const keys = Object.keys(routes);
  if (keys.length !== 1) return false;
  return keys[0] === (record.route || 'unknown') || keys[0] === 'unknown';
}

/** Make the per-day sum cover the record total; excess goes to the fallback day. */
function reconcileDays(record, fallbackTime, tzOffsetMinutes) {
  if (record.days === undefined) record.days = {};
  const day = fallbackTime > 0 ? dayKey(fallbackTime, tzOffsetMinutes) : 'unknown';
  if (record.days[day] === undefined) record.days[day] = zeroBuckets();
  const summed = sumRoutes(record.days);
  for (const key of Object.keys(zeroBuckets())) {
    const delta = Number(record.totals[key]) - summed[key];
    if (delta > 0) record.days[day][key] += delta;
  }
}

/** Make the per-day request sum cover the record total; excess goes to the fallback day. */
function reconcileDayRequests(record, fallbackTime, tzOffsetMinutes) {
  if (record.dayRequests === undefined) record.dayRequests = {};
  const day = fallbackTime > 0 ? dayKey(fallbackTime, tzOffsetMinutes) : 'unknown';
  let summed = 0;
  for (const count of Object.values(record.dayRequests)) summed += Number(count) || 0;
  // Backup-only records often carry day counts from parsed logs but no request
  // total. The parsed day counts are the better source; never let the daily
  // chart exceed the global request count.
  const target = Math.max(Number(record.requests) || 0, summed);
  if (target !== (Number(record.requests) || 0)) record.requests = target;
  if (target > 0 && summed > target) {
    // Backup logs can contain more samples than the ledger's request total
    // (e.g. truncated/changed live logs). Keep the total real and preserve the
    // daily shape by scaling the counts down to the recorded request count.
    const keys = Object.keys(record.dayRequests);
    let allocated = 0;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const next = index === keys.length - 1
        ? target - allocated
        : Math.max(0, Math.round((Number(record.dayRequests[key]) || 0) * target / summed));
      record.dayRequests[key] = next;
      allocated += next;
    }
    return;
  }
  const delta = target - summed;
  if (delta > 0) record.dayRequests[day] = (Number(record.dayRequests[day]) || 0) + delta;
}

/** A record whose per-day map is only the legacy single-day fallback. */
function isDaysCoarse(record, tzOffsetMinutes) {
  const keys = Object.keys(record.days ?? {});
  if (keys.length !== 1) return false;
  const time = record.lastActivity || record.createdAt || 0;
  return keys[0] === (time > 0 ? dayKey(time, tzOffsetMinutes) : 'unknown');
}

/** Normalize stored/absent per-day buckets, keeping the sum equal to `totals`. */
function normalizeDays(days, fallbackTime, totals, tzOffsetMinutes) {
  const out = {};
  if (days !== null && typeof days === 'object') {
    for (const [day, buckets] of Object.entries(days)) {
      if (buckets !== null && typeof buckets === 'object') out[day] = { ...zeroBuckets(), ...buckets };
    }
  }
  const fallbackDay = fallbackTime > 0 ? dayKey(fallbackTime, tzOffsetMinutes) : 'unknown';
  if (Object.keys(out).length === 0) {
    out[fallbackDay] = { ...zeroBuckets(), ...(totals ?? {}) };
    return out;
  }
  if (out[fallbackDay] === undefined) out[fallbackDay] = zeroBuckets();
  const summed = sumRoutes(out);
  for (const key of Object.keys(zeroBuckets())) {
    const delta = Number(totals?.[key]) - summed[key];
    if (delta > 0) out[fallbackDay][key] += delta;
  }
  return out;
}

/**
 * One durable key per session. Logs, projection caches and backup directories
 * disagree about the `session-` prefix; without normalization the same session
 * can become two ledger rows (and its route breakdown stays empty/unknown).
 */
function canonicalSessionId(id) {
  if (typeof id !== 'string' || id === '') return id;
  return id.startsWith('session-') ? id : `session-${id}`;
}

/** Merge two representations of the same session without double counting. */
function mergeRecords(target, source) {
  const targetCoarse = isCoarseRecord(target);
  const sourceCoarse = isCoarseRecord(source);
  const maxTotals = zeroBuckets();
  for (const key of Object.keys(maxTotals)) {
    maxTotals[key] = Math.max(Number(target.totals[key]) || 0, Number(source.totals[key]) || 0);
  }
  if (targetCoarse && !sourceCoarse) {
    target.routes = { ...source.routes };
  } else if (targetCoarse && sourceCoarse) {
    target.routes = { [target.route || source.route || 'unknown']: maxTotals };
  } else {
    const fallback = target.route || source.route || 'unknown';
    if (target.routes[fallback] === undefined) target.routes[fallback] = zeroBuckets();
    const routed = sumRoutes(target.routes);
    for (const key of Object.keys(maxTotals)) {
      const delta = maxTotals[key] - routed[key];
      if (delta > 0) target.routes[fallback][key] += delta;
    }
  }
  target.totals = sumRoutes(target.routes);
  if (target.days === undefined) target.days = {};
  for (const [day, buckets] of Object.entries(source.days ?? {})) {
    const current = target.days[day] ?? zeroBuckets();
    const merged = zeroBuckets();
    for (const key of Object.keys(merged)) {
      merged[key] = Math.max(Number(current[key]) || 0, Number(buckets[key]) || 0);
    }
    target.days[day] = merged;
  }
  target.dayRequests = target.dayRequests ?? {};
  for (const [day, count] of Object.entries(source.dayRequests ?? {})) {
    target.dayRequests[day] = Math.max(Number(target.dayRequests[day]) || 0, Number(count) || 0);
  }
  target.dayRequestsFallback = target.dayRequestsFallback === true && source.dayRequestsFallback === true;
  target.requests = Math.max(target.requests, source.requests);
  target.cwd = target.cwd || source.cwd;
  target.title = target.title || source.title;
  target.route = target.route || source.route;
  target.createdAt = target.createdAt || source.createdAt;
  target.lastActivity = Math.max(target.lastActivity, source.lastActivity);
  target.upToSeq = Math.max(target.upToSeq, source.upToSeq);
  return target;
}

/** Plugin config. */
export const Config = z.object({
  root: z.string().default(''),
  flushIntervalMs: z.natural().min(200).max(600_000).default(2000),
  decodeCapBytes: z.natural().min(1_048_576).max(536_870_912).default(32 * 1024 * 1024),
  backfillLimit: z.natural().min(0).max(100_000).default(2000),
  // Beijing time (+480) is the one day-boundary used by the ledger, regardless
  // of the Host process timezone.
  timeZoneOffsetMinutes: z.number().default(480),
  // Optional WorkBuddy gateway state file. Its model_costs[].cost_per_1k is the
  // observed credit price per 1000 tokens; empty means "cost unavailable".
  workbuddyStatePath: z.string().default(''),
  // Reference USD -> CNY rate used by the RMB cost view. The Host refreshes it
  // from exchangeRateUrl when online and falls back to this value otherwise.
  usdToCny: z.number().default(7.2),
  exchangeRateUrl: z.string().default('https://open.er-api.com/v6/latest/USD'),
  exchangeRateRefreshMs: z.natural().min(60_000).max(86_400_000).default(900_000),
  // Extra session-backup roots (each may contain `sessions/` and `projcache/`).
  // Backups are the only source for sessions deleted before this plugin first
  // ran and already removed from the live session directory.
  backupRoots: z.array(z.string()).default([]),
  // Official cost tier: 'auto' splits every sample by the Beijing-time peak
  // windows (off-peak is half price), 'peak'/'offpeak' force one tier.
  pricingTier: z.string().default('auto'),
  // Extra Beijing dates (YYYY-MM-DD) billed as off-peak regardless of weekday.
  // These are a manual override / offline fallback on top of the API schedule.
  holidayDates: z.array(z.string()).default([]),
  // China statutory-holiday schedule API; `{year}` is replaced per request.
  // Empty disables the API and leaves only `holidayDates` in effect.
  holidayApiUrl: z.string().default('https://timor.tech/api/holiday/year/{year}'),
  // GitHub repository (`owner/repo`) the "检查更新" button reads releases from.
  // Empty disables the button.
  updateRepo: z.string().default('migao666/dsh-token-usage'),
  // Token for a private repository; empty for a public one. A read-only
  // (contents) fine-grained token is enough.
  updateToken: z.string().default(''),
});

/** `<DSH_HOME>` root, honouring the env override. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** Local-timezone day key, `YYYY-MM-DD`. `tzOffsetMinutes` is the local offset from UTC (China = +480). */
export function dayKey(epochMs, tzOffsetMinutes) {
  // Shift the absolute epoch into local wall-clock time, then read UTC fields.
  // Subtracting the offset here shifts every evening into the previous day and
  // makes "today" empty in the UI.
  const d = new Date(epochMs + tzOffsetMinutes * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- usage fold

const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Validate one provider usage record.
 *
 * input/output must be safe non-negative integers; the cache buckets are
 * optional but must be valid when present. Anything else is discarded -- a
 * miscount is worse than a missing sample.
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined;
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined;
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined;
  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
  };
}

function bucketsEqual(a, b) {
  return a.uncachedInputTokens === b.uncachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens;
}

function addBuckets(a, b) {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function subBuckets(a, b) {
  return {
    uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
  };
}

/** Total for one request: input + cache read + cache write + output. */
export function totalOf(b) {
  return b.uncachedInputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.outputTokens;
}

/** Prompt-side tokens only -- what the next request has to carry. */
export function promptOf(b) {
  return b.uncachedInputTokens + b.cacheReadTokens + b.cacheWriteTokens;
}

/**
 * Cache hit rate.
 *
 * The denominator is "how many prompt tokens this route has been asked to
 * carry"; the numerator is the part served from cache. Output tokens never
 * participate (they are not a prompt), and neither does cache-write (that is the
 * cost of storing, not the size of this read).
 *
 * `null` when there is no prompt traffic at all -- the UI must show "--", not
 * "0%", because 0% is a claim and "--" is an admission.
 */
export function cacheHitOf(b) {
  const denominator = b.cacheReadTokens + b.uncachedInputTokens;
  return {
    cacheHitRate: denominator > 0 ? b.cacheReadTokens / denominator : null,
    promptTokens: promptOf(b),
  };
}

/**
 * Pull the usage sample out of an assistant event.
 *
 * A settled `assistant/message` carries `data.usage`; otherwise the last
 * `usage` chunk of its embedded stream is the sample (the v2 settlement path).
 * `assistant/attempt` only ever has the stream.
 */
export function usageOf(event) {
  const data = event?.data;
  if (data === null || typeof data !== 'object') return undefined;
  if (event.type === 'assistant/message' && data.usage !== undefined) return normalizeUsage(data.usage);
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i];
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'chunk'
      && chunk.chunk !== null && typeof chunk.chunk === 'object' && chunk.chunk.type === 'usage') {
      return normalizeUsage(chunk.chunk.usage);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- log replay

const ZSTD_MAGIC = 0xfd2fb528;

function zstdFrameStarts(buffer) {
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) === ZSTD_MAGIC) starts.push(i);
  }
  return starts;
}

/**
 * Decode a concatenated multi-frame zstd JSONL log.
 *
 * `zstdDecompressSync` only decodes the first frame of a concatenation, so the
 * frames must be split on the magic and decoded one at a time.
 */
export function decodeZstdLog(buffer, capBytes) {
  const starts = zstdFrameStarts(buffer);
  const parts = [];
  let out = 0;
  for (let i = 0; i < starts.length && out < capBytes; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length;
    try {
      const decoded = zstdDecompressSync(buffer.subarray(starts[i], end), { maxOutputLength: capBytes - out });
      parts.push(decoded.toString('utf8'));
      out += decoded.length;
    } catch {
      /* a damaged frame is skipped: history is best-effort */
    }
  }
  return parts.join('');
}

function readLogText(file, capBytes) {
  if (file.endsWith('.jsonl')) return readFileSync(file).subarray(0, capBytes).toString('utf8');
  return decodeZstdLog(readFileSync(file), capBytes);
}

/**
 * Replay one session log into its metadata plus every usage sample.
 *
 * Depends only on the log's own shape, never on a live Host service, so cold
 * sessions aggregate exactly like the live ones.
 */
export function parseSessionLog(logFile, capBytes) {
  let text;
  try {
    text = readLogText(logFile, capBytes);
  } catch {
    return null;
  }
  let sessionId = '';
  let cwd = '';
  let createdAt = 0;
  let title = '';
  let route = '';
  let maxSeq = -1;
  const samples = [];
  const sampleRoutes = [];
  const sampleTimes = [];
  const lastSlot = new Map();

  for (const line of text.split('\n')) {
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object') continue;
    if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq;

    switch (event.type) {
      case 'session':
        if (typeof event.id === 'string') sessionId = event.id;
        if (typeof event.cwd === 'string') cwd = event.cwd;
        if (typeof event.createdAt === 'number') createdAt = event.createdAt;
        continue;
      case 'session/title':
        if (typeof event.data?.title === 'string' && event.data.title !== '') title = event.data.title;
        continue;
      case 'request/header': {
        const c = event.data?.header?.config;
        if (c !== null && typeof c === 'object' && typeof c.provider === 'string' && typeof c.model === 'string') {
          route = `${c.provider}:${c.model}`;
        }
        continue;
      }
      case 'llm/retry-started':
        // Clear this step's slot so the retried attempt adds on its own.
        //
        // This mirrors the official `tokenUsage` projection exactly: a retry
        // "closes the replacement slot so the retried attempt adds to the
        // total". Note what that means for accounting -- a retried attempt that
        // already reported usage is NOT subtracted, because the provider bills
        // both attempts. The `previous` branch below only fires when the same
        // turn/step settles twice WITHOUT a retry in between, which is how a
        // rewritten message replaces its own earlier reading.
        lastSlot.delete(`${event.data?.turn}:${event.data?.step}`);
        continue;
      default:
        break;
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const usage = usageOf(event);
    if (usage === undefined) continue;
    // The settled message names the model that actually answered this request;
    // that is the per-request route. `request/header` is the fallback for events
    // that do not carry a provider/model source.
    const eventRoute = event.data?.message?.source;
    const usageRoute = typeof eventRoute?.provider === 'string' && typeof eventRoute?.model === 'string'
      ? `${eventRoute.provider}:${eventRoute.model}`
      : (route || 'unknown');
    const key = `${event.data?.turn}:${event.data?.step}`;
    const previous = lastSlot.get(key);
    if (previous === undefined) {
      samples.push(usage);
      sampleRoutes.push(usageRoute);
      sampleTimes.push(Number(event.time) || Date.now());
    } else if (bucketsEqual(previous, usage)) {
      // Identical re-settlement: nothing changed, so add nothing.
      continue;
    } else {
      // A replacement contributes only the DELTA (new - old), so folding every
      // sample sums to the latest reading. Pushing the delta *and* the full
      // reading would over-count; pushing a correction of the wrong sign would
      // leave the total at 2 * old.
      samples.push({
        uncachedInputTokens: usage.uncachedInputTokens - previous.uncachedInputTokens,
        outputTokens: usage.outputTokens - previous.outputTokens,
        cacheReadTokens: usage.cacheReadTokens - previous.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens - previous.cacheWriteTokens,
      });
      sampleRoutes.push(usageRoute);
      sampleTimes.push(Number(event.time) || Date.now());
    }
    lastSlot.set(key, usage);
  }

  if (sessionId === '' && samples.length === 0) return null;
  return { sessionId, cwd, createdAt, title, route, samples, sampleRoutes, sampleTimes, maxSeq };
}

/** Fold one parsed log's samples into route -> buckets. */
function routeTotalsOf(parsed) {
  const totals = {};
  for (let index = 0; index < parsed.samples.length; index += 1) {
    const route = (parsed.sampleRoutes !== undefined && typeof parsed.sampleRoutes[index] === 'string'
      && parsed.sampleRoutes[index] !== '')
      ? parsed.sampleRoutes[index]
      : (parsed.route || 'unknown');
    totals[route] = addBuckets(totals[route] ?? zeroBuckets(), parsed.samples[index]);
  }
  return totals;
}

/** Fold one parsed log's samples into local-day -> buckets. */
function dayTotalsOf(parsed, tzOffsetMinutes) {
  const totals = {};
  for (let index = 0; index < parsed.samples.length; index += 1) {
    const time = (parsed.sampleTimes !== undefined && Number(parsed.sampleTimes[index]) > 0)
      ? Number(parsed.sampleTimes[index])
      : Number(parsed.createdAt) || 0;
    const day = time > 0 ? dayKey(time, tzOffsetMinutes) : 'unknown';
    totals[day] = addBuckets(totals[day] ?? zeroBuckets(), parsed.samples[index]);
  }
  return totals;
}

/** Fold one parsed log's samples into local-day -> API request count. */
function dayRequestsOf(parsed, tzOffsetMinutes) {
  const totals = {};
  for (let index = 0; index < parsed.samples.length; index += 1) {
    const time = (parsed.sampleTimes !== undefined && Number(parsed.sampleTimes[index]) > 0)
      ? Number(parsed.sampleTimes[index])
      : Number(parsed.createdAt) || 0;
    const day = time > 0 ? dayKey(time, tzOffsetMinutes) : 'unknown';
    totals[day] = (totals[day] ?? 0) + 1;
  }
  return totals;
}

// ---------------------------------------------------------------- the ledger

function emptyRecord(sessionId) {
  return {
    sessionId,
    cwd: '',
    title: '',
    route: '',
    createdAt: 0,
    lastActivity: 0,
    requests: 0,
    totals: zeroBuckets(),
    /** Per-request model breakdown: route -> four buckets. */
    routes: {},
    /** Per-local-day breakdown: YYYY-MM-DD -> four buckets. */
    days: {},
    /** Per-local-day API request count, parallel to `days`. */
    dayRequests: {},
    /** True when dayRequests is only the legacy last-activity fallback. */
    dayRequestsFallback: false,
    /** Highest event seq already folded; live events at or below it are skipped. */
    upToSeq: -1,
  };
}

/**
 * The cross-session ledger.
 *
 * One JSON file, one writer, atomic replace. SQLite would be the reflex answer,
 * but the access pattern is only "read my own file" plus "append my own rows",
 * and a manifest avoids a native dependency and its migration story entirely.
 */
export class TokenLedger {
  constructor(ctx, root, { flushIntervalMs = 2000, decodeCapBytes = 32 * 1024 * 1024, onSaved, tzOffsetMinutes = 0, resolveTier } = {}) {
    this.ctx = ctx;
    this.root = root;
    this.manifestPath = join(root, 'manifest.json');
    this.decodeCap = decodeCapBytes;
    this.flushIntervalMs = flushIntervalMs;
    this.onSaved = onSaved;
    this.tzOffsetMinutes = tzOffsetMinutes;
    this.records = new Map();
    this.loaded = false;
    this.dirty = false;
    this.chain = Promise.resolve();
    this.timer = undefined;
    this.backfilled = false;
    // Which price tier one sample belongs to; the service owns the policy.
    this.resolveTier = typeof resolveTier === 'function' ? resolveTier : () => 'peak';
  }

  withLock(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string') continue;
          const key = canonicalSessionId(item.sessionId);
          const rawTotals = { ...zeroBuckets(), ...(item.totals ?? {}) };
          const fallback = typeof item.route === 'string' && item.route !== '' ? item.route : 'unknown';
          const routes = normalizeRoutes(item.routes, item.route, rawTotals);
          if (routes[fallback] === undefined) routes[fallback] = zeroBuckets();
          // Old manifests only had a single total + last route. If a cache/backup
          // merge already grew the total beyond the routed breakdown, attribute
          // the un-routed delta to the last known route instead of losing it.
          const routed = sumRoutes(routes);
          for (const bucket of Object.keys(zeroBuckets())) {
            const delta = Number(rawTotals[bucket]) - routed[bucket];
            if (delta > 0) routes[fallback][bucket] += delta;
          }
          const record = {
            ...emptyRecord(key),
            sessionId: key,
            cwd: typeof item.cwd === 'string' ? item.cwd : '',
            title: typeof item.title === 'string' ? item.title : '',
            route: typeof item.route === 'string' ? item.route : '',
            createdAt: Number(item.createdAt) || 0,
            lastActivity: Number(item.lastActivity) || 0,
            requests: Number(item.requests) || 0,
            upToSeq: Number.isSafeInteger(item.upToSeq) ? item.upToSeq : -1,
            totals: sumRoutes(routes),
            routes,
            routeTiers: normalizeRouteTiers(item.routeTiers),
            dayRoutes: normalizeDayRoutes(item.dayRoutes),
          };
          record.days = normalizeDays(
            item.days,
            record.lastActivity || record.createdAt,
            record.totals,
            this.tzOffsetMinutes,
          );
          record.dayRequests = {};
          if (item.dayRequests !== null && typeof item.dayRequests === 'object') {
            for (const [day, count] of Object.entries(item.dayRequests)) {
              const n = Number(count);
              if (Number.isFinite(n) && n > 0) record.dayRequests[day] = n;
            }
          }
          record.dayRequestsFallback = item.dayRequestsFallback === true;
          if (Object.keys(record.dayRequests).length === 0 && record.requests > 0) {
            const fallbackTime = record.lastActivity || record.createdAt;
            const fallbackDay = fallbackTime > 0
              ? dayKey(fallbackTime, this.tzOffsetMinutes)
              : 'unknown';
            record.dayRequests[fallbackDay] = record.requests;
            record.dayRequestsFallback = true;
          }
          const existing = this.records.get(key);
          if (existing === undefined) this.records.set(key, record);
          else {
            mergeRecords(existing, record);
            existing.days = normalizeDays(
              existing.days,
              existing.lastActivity || existing.createdAt,
              existing.totals,
              this.tzOffsetMinutes,
            );
            this.dirty = true;
          }
          if (key !== item.sessionId) this.dirty = true;
        }
      }
    } catch {
      /* no manifest on first run is the normal case */
    }
  }

  async save() {
    await mkdir(this.root, { recursive: true });
    const rows = [...this.records.values()].sort((a, b) => a.lastActivity - b.lastActivity);
    const tmp = `${this.manifestPath}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(rows), 'utf8');
    await rename(tmp, this.manifestPath);
    if (typeof this.onSaved === 'function') {
      try {
        await this.onSaved(rows);
      } catch (error) {
        this.ctx.logger?.warn?.(`[dsh-token-usage] mirror write failed: ${String(error)}`);
      }
    }
  }

  /**
   * Fold a sample set into a session record.
   *
   * Samples may be negative (a retry replacing an earlier one), so this is plain
   * addition. `upToSeq` is the idempotence guard: a cold-start backfill records
   * the log's highest seq, and live events at or below it are then skipped -- the
   * failure mode this replaces was counting the same events twice.
   */
  apply(sessionId, meta, samples, at, { upToSeq, countRequest = true, sampleRoutes, sampleTimes } = {}) {
    const id = canonicalSessionId(sessionId);
    const record = this.records.get(id) ?? emptyRecord(id);
    record.sessionId = id;
    if (record.routes === undefined) record.routes = {};
    if (record.days === undefined) record.days = {};
    if (record.dayRequests === undefined) record.dayRequests = {};
    if (record.routeTiers === undefined) record.routeTiers = {};
    if (record.dayRoutes === undefined) record.dayRoutes = {};
    if (upToSeq !== undefined) record.upToSeq = Math.max(record.upToSeq, upToSeq);
    if (meta.cwd) record.cwd = meta.cwd;
    if (meta.title) record.title = meta.title;
    if (meta.route) record.route = meta.route;
    if (meta.createdAt) record.createdAt = meta.createdAt;
    const fallback = (meta.route || record.route || 'unknown');
    for (let index = 0; index < samples.length; index += 1) {
      const buckets = samples[index];
      const route = (sampleRoutes !== undefined && typeof sampleRoutes[index] === 'string' && sampleRoutes[index] !== '')
        ? sampleRoutes[index]
        : fallback;
      record.routes[route] = addBuckets(record.routes[route] ?? zeroBuckets(), buckets);
      const time = (sampleTimes !== undefined && Number(sampleTimes[index]) > 0)
        ? Number(sampleTimes[index])
        : (at || Date.now());
      const day = dayKey(time, this.tzOffsetMinutes);
      record.days[day] = addBuckets(record.days[day] ?? zeroBuckets(), buckets);
      // Peak/off-peak accounting: keep one bucket pair per route so the cost
      // view can price each tier at its own list price.
      const tier = this.resolveTier(time);
      const tierSlot = record.routeTiers[route]
        ?? (record.routeTiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      tierSlot[tier] = addBuckets(tierSlot[tier], buckets);
      // Same split per day, so the history table can price one row per day.
      const dayRoutes = record.dayRoutes[day] ?? (record.dayRoutes[day] = {});
      const dayTier = dayRoutes[route]
        ?? (dayRoutes[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      dayTier[tier] = addBuckets(dayTier[tier], buckets);
      if (countRequest) record.dayRequests[day] = (Number(record.dayRequests[day]) || 0) + 1;
      if (countRequest) record.requests += 1;
      record.dayRequestsFallback = false;
    }
    record.totals = sumRoutes(record.routes);
    record.lastActivity = Math.max(record.lastActivity || 0, at);
    this.records.set(id, record);
    this.dirty = true;
  }

  /**
   * Fold one live event, but only if it is past the session's watermark.
   * @returns {boolean} whether it counted
   */
  applyLive(sessionId, meta, buckets, at, seq) {
    const id = canonicalSessionId(sessionId);
    const record = this.records.get(id);
    if (record !== undefined && Number.isSafeInteger(seq) && seq <= record.upToSeq) return false;
    this.apply(id, meta, [buckets], at, { upToSeq: seq });
    return true;
  }

  /**
   * Merge a cached `tokenUsage` projection into the ledger.
   *
   * The projection cache is the second historical source: it can still hold a
   * session after its log directory was deleted from the session list. Merge by
   * taking the larger reading per bucket (never add, or a session present in both
   * sources would be counted twice), and keep the higher watermark.
   * @returns {boolean} whether anything changed
   */
  mergeCache(sessionId, meta, totals, seq) {
    const id = canonicalSessionId(sessionId);
    if (typeof id !== 'string' || id === '') return false;
    if (totals === null || typeof totals !== 'object') return false;
    const record = this.records.get(id) ?? emptyRecord(id);
    record.sessionId = id;
    if (record.routes === undefined) record.routes = {};
    if (record.days === undefined) record.days = {};
    const fallback = (meta.route || record.route || 'unknown');
    if (record.routes[fallback] === undefined) record.routes[fallback] = zeroBuckets();
    let changed = false;
    let dayDelta = zeroBuckets();
    const routed = sumRoutes(record.routes);
    for (const key of Object.keys(zeroBuckets())) {
      const value = Number(totals[key]);
      if (Number.isSafeInteger(value) && value > routed[key]) {
        // Cache-only totals have no per-request model. Attribute the delta to the
        // session's last known route rather than dropping it from the breakdown.
        const delta = value - routed[key];
        record.routes[fallback][key] += delta;
        dayDelta[key] += delta;
        changed = true;
      }
    }
    record.totals = sumRoutes(record.routes);
    const at = meta.lastActivity || meta.createdAt || 0;
    if (changed) {
      const day = at > 0 ? dayKey(at, this.tzOffsetMinutes) : 'unknown';
      record.days[day] = addBuckets(record.days[day] ?? zeroBuckets(), dayDelta);
    }
    if (meta.cwd && !record.cwd) { record.cwd = meta.cwd; changed = true; }
    if (meta.title && !record.title) { record.title = meta.title; changed = true; }
    if (meta.route && !record.route) { record.route = meta.route; changed = true; }
    if (meta.createdAt && !record.createdAt) { record.createdAt = meta.createdAt; changed = true; }
    if (at > record.lastActivity) { record.lastActivity = at; changed = true; }
    if (Number.isSafeInteger(seq) && seq > record.upToSeq) { record.upToSeq = seq; changed = true; }
    if (changed) {
      this.records.set(id, record);
      this.dirty = true;
    }
    return changed;
  }

  /**
   * Merge a parsed log's per-route totals.
   *
   * A coarse record (one fallback bucket, e.g. built from the projection cache)
   * is upgraded to the log's per-route breakdown; any total that the log does not
   * cover (compacted/truncated logs, cache-only excess) stays on the fallback
   * route as an explicit unattributed remainder. A record that already has a
   * per-route breakdown is merged by taking the larger value per route.
   * @returns {boolean} whether anything changed
   */
  mergeParsed(sessionId, meta, routeTotals, seq, dayTotals, dayRequestTotals) {
    const id = canonicalSessionId(sessionId);
    if (typeof id !== 'string' || id === '') return false;
    if (routeTotals === null || typeof routeTotals !== 'object') return false;
    const record = this.records.get(id) ?? emptyRecord(id);
    record.sessionId = id;
    if (record.routes === undefined) record.routes = {};
    if (record.days === undefined) record.days = {};
    if (record.dayRequests === undefined) record.dayRequests = {};
    const at = meta.lastActivity || meta.createdAt || 0;
    const daysCoarse = isDaysCoarse(record, this.tzOffsetMinutes);
    const parsedTotals = sumRoutes(routeTotals);
    if (parsedTotals.uncachedInputTokens + parsedTotals.outputTokens
      + parsedTotals.cacheReadTokens + parsedTotals.cacheWriteTokens === 0) return false;
    const routes = Object.keys(record.routes);
    const coarse = routes.length === 0
      || (routes.length === 1 && routes[0] === (record.route || 'unknown'));
    const replaceDays = coarse || daysCoarse || record.dayRequestsFallback === true;
    let changed = false;
    if (coarse) {
      // Keep the log's per-request routes, then put any excess total that the log
      // does not contain on the fallback route -- never drop those tokens.
      const nextRoutes = {};
      for (const [route, buckets] of Object.entries(routeTotals)) nextRoutes[route] = { ...buckets };
      const fallback = record.route || 'unknown';
      if (nextRoutes[fallback] === undefined) nextRoutes[fallback] = zeroBuckets();
      const routed = sumRoutes(nextRoutes);
      for (const key of Object.keys(zeroBuckets())) {
        const delta = Number(record.totals[key]) - routed[key];
        if (delta > 0) nextRoutes[fallback][key] += delta;
      }
      record.routes = nextRoutes;
      record.totals = sumRoutes(nextRoutes);
      changed = true;
    } else {
      for (const [route, buckets] of Object.entries(routeTotals)) {
        const current = record.routes[route] ?? zeroBuckets();
        const merged = zeroBuckets();
        let routeChanged = record.routes[route] === undefined;
        for (const key of Object.keys(merged)) {
          merged[key] = Math.max(Number(current[key]) || 0, Number(buckets[key]) || 0);
          if (merged[key] !== (Number(current[key]) || 0)) routeChanged = true;
        }
        if (routeChanged) changed = true;
        record.routes[route] = merged;
      }
      record.totals = sumRoutes(record.routes);
    }
    if (dayTotals !== null && typeof dayTotals === 'object' && Object.keys(dayTotals).length > 0) {
      if (replaceDays) {
        record.days = {};
        for (const [day, buckets] of Object.entries(dayTotals)) {
          record.days[day] = { ...zeroBuckets(), ...buckets };
        }
      } else {
        for (const [day, buckets] of Object.entries(dayTotals)) {
          const current = record.days[day] ?? zeroBuckets();
          const merged = zeroBuckets();
          for (const key of Object.keys(merged)) {
            merged[key] = Math.max(Number(current[key]) || 0, Number(buckets[key]) || 0);
          }
          record.days[day] = merged;
        }
      }
      changed = true;
    }
    if (dayRequestTotals !== null && typeof dayRequestTotals === 'object'
      && Object.keys(dayRequestTotals).length > 0) {
      if (replaceDays) {
        record.dayRequests = {};
        for (const [day, count] of Object.entries(dayRequestTotals)) {
          record.dayRequests[day] = Number(count) || 0;
        }
      } else {
        for (const [day, count] of Object.entries(dayRequestTotals)) {
          record.dayRequests[day] = Math.max(Number(record.dayRequests[day]) || 0, Number(count) || 0);
        }
      }
      record.dayRequestsFallback = false;
      changed = true;
    }
    if (meta.cwd && !record.cwd) { record.cwd = meta.cwd; changed = true; }
    if (meta.title && !record.title) { record.title = meta.title; changed = true; }
    if (meta.route) record.route = meta.route;
    if (meta.createdAt && !record.createdAt) { record.createdAt = meta.createdAt; changed = true; }
    if (at > record.lastActivity) { record.lastActivity = at; changed = true; }
    if (Number.isSafeInteger(seq) && seq > record.upToSeq) { record.upToSeq = seq; changed = true; }
    if (changed) {
      reconcileDays(record, at, this.tzOffsetMinutes);
      reconcileDayRequests(record, at, this.tzOffsetMinutes);
      this.records.set(id, record);
      this.dirty = true;
    }
    return changed;
  }

  async flush({ force = false } = {}) {
    if (!this.dirty && !force) return;
    this.dirty = false;
    await this.withLock(() => this.save());
  }

  start() {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.flush().catch((e) => this.ctx.logger?.warn?.(`[${name}] ledger write failed: ${String(e)}`));
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  all() {
    return [...this.records.values()];
  }
}

/**
 * Fold sessions that predate the plugin into the ledger.
 *
 * Only unknown sessions are read, so the steady-state cost is proportional to
 * new sessions rather than to history.
 * @returns {Promise<{added:number,scanned:number}>}
 */
export async function backfill(ledger, limit = 2000) {
  const sessionsRoot = join(dshHome(), 'sessions');
  const result = { added: 0, scanned: 0 };
  if (!existsSync(sessionsRoot)) return result;

  const projects = await readdir(sessionsRoot, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(sessionsRoot, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.scanned >= limit) return result;
      if (!entry.isDirectory()) continue;
      result.scanned += 1;
      const existing = ledger.records.get(canonicalSessionId(entry.name));
      const hasDayRequests = existing !== undefined
        && existing.dayRequests !== null && typeof existing.dayRequests === 'object'
        && Object.keys(existing.dayRequests).length > 0
        && existing.dayRequestsFallback !== true;
      if (existing !== undefined && !isCoarseRecord(existing)
        && !isDaysCoarse(existing, ledger.tzOffsetMinutes) && hasDayRequests) continue;
      const dir = join(projectPath, entry.name);
      let files;
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      const logFile = files
        .map((f) => join(dir, f))
        .find((f) => /session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f));
      if (logFile === undefined) continue;
      const parsed = parseSessionLog(logFile, ledger.decodeCap);
      if (parsed === null) continue;
      const sessionId = parsed.sessionId !== '' ? parsed.sessionId : entry.name;
      const current = ledger.records.get(canonicalSessionId(sessionId))
        ?? ledger.records.get(canonicalSessionId(entry.name));
      if (current === undefined) {
        ledger.apply(sessionId, parsed, parsed.samples, parsed.createdAt, {
          upToSeq: parsed.maxSeq,
          sampleRoutes: parsed.sampleRoutes,
          sampleTimes: parsed.sampleTimes,
        });
        result.added += 1;
      } else if (isCoarseRecord(current) || isDaysCoarse(current, ledger.tzOffsetMinutes) || !hasDayRequests) {
        // Upgrade old single-route / single-day records with per-request detail.
        const changed = ledger.mergeParsed(sessionId, {
          cwd: parsed.cwd,
          title: parsed.title,
          route: parsed.route,
          createdAt: parsed.createdAt,
          lastActivity: parsed.createdAt,
        }, routeTotalsOf(parsed), parsed.maxSeq, dayTotalsOf(parsed, ledger.tzOffsetMinutes),
        dayRequestsOf(parsed, ledger.tzOffsetMinutes));
        if (changed) result.added += 1;
      }
    }
  }
  return result;
}

/**
 * Fold cached `tokenUsage` projections into the ledger.
 *
 * This is what keeps deleted sessions in the cumulative total. Deleting a session
 * removes its log directory, so `backfill()` can no longer see it; the projection
 * cache under `~/.dsh/storages/session_projcache/sessions` may still carry the
 * session's `tokenUsage` totals. Records already in the ledger are merged by
 * maximum, so a session seen by both sources is never counted twice.
 * @returns {Promise<{added:number,scanned:number}>}
 */
/**
 * One-time tier migration for records written before the peak/off-peak split.
 *
 * The session logs carry the time of every usage sample, so replaying them gives
 * the exact split for a record that predates the split. A record whose log is
 * gone keeps no split and stays `legacy` (priced at the peak rate); a replay
 * that disagrees with the record's stored totals is ignored rather than trusted.
 * @returns how many records gained a tier split.
 */
export async function retierFromLogs(ledger) {
  const pending = new Map();
  for (const record of ledger.records.values()) {
    let stored = 0;
    let seen = 0;
    for (const buckets of Object.values(record.routes ?? {})) stored += totalsOfBuckets(buckets);
    for (const split of Object.values(record.routeTiers ?? {})) {
      seen += totalsOfBuckets(split.peak) + totalsOfBuckets(split.offpeak);
    }
    // Complete enough already: the tier split covers the stored accounting and
    // so does the per-day map (the history table prices one row per day).
    let dayTokens = 0;
    for (const routes of Object.values(record.dayRoutes ?? {})) {
      for (const tiers of Object.values(routes ?? {})) {
        dayTokens += totalsOfBuckets(tiers?.peak) + totalsOfBuckets(tiers?.offpeak);
      }
    }
    if (stored === 0 || (seen >= stored * 0.999 && dayTokens >= stored * 0.999)) continue;
    pending.set(canonicalSessionId(record.sessionId), record);
  }
  if (pending.size === 0) return 0;

  const sessionsRoot = join(dshHome(), 'sessions');
  if (!existsSync(sessionsRoot)) return 0;
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let changed = 0;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(sessionsRoot, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = pending.get(canonicalSessionId(entry.name));
      if (record === undefined) continue;
      const dir = join(projectPath, entry.name);
      let files;
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      const logFile = files
        .map((file) => join(dir, file))
        .find((file) => /session(\.v\d+)?\.jsonl(\.zstd)?$/.test(file));
      if (logFile === undefined) continue;
      const parsed = parseSessionLog(logFile, ledger.decodeCap);
      if (parsed === null) continue;
      const fallbackAt = record.lastActivity || record.createdAt || Date.now();
      const tiers = {};
      const dayRoutes = {};
      for (let index = 0; index < parsed.samples.length; index += 1) {
        const route = (typeof parsed.sampleRoutes?.[index] === 'string' && parsed.sampleRoutes[index] !== '')
          ? parsed.sampleRoutes[index]
          : (parsed.route || 'unknown');
        const at = Number(parsed.sampleTimes?.[index]) > 0 ? Number(parsed.sampleTimes[index]) : fallbackAt;
        const tier = ledger.resolveTier(at);
        const slot = tiers[route] ?? (tiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
        slot[tier] = addBuckets(slot[tier], parsed.samples[index]);
        const day = dayKey(at, ledger.tzOffsetMinutes);
        const daySlot = dayRoutes[day] ?? (dayRoutes[day] = {});
        const dayTier = daySlot[route]
          ?? (daySlot[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
        dayTier[tier] = addBuckets(dayTier[tier], parsed.samples[index]);
      }
      let agrees = Object.keys(tiers).length > 0;
      for (const [route, split] of Object.entries(tiers)) {
        const stored = record.routes?.[route] ?? zeroBuckets();
        const replayed = totalsOfBuckets(split.peak) + totalsOfBuckets(split.offpeak);
        if (replayed > totalsOfBuckets(stored) * 1.001 + 2) {
          agrees = false;
          break;
        }
      }
      if (!agrees) continue;
      record.routeTiers = tiers;
      record.dayRoutes = dayRoutes;
      ledger.dirty = true;
      changed += 1;
    }
  }
  return changed;
}

export async function backfillCaches(ledger, limit = 2000) {
  const cacheRoot = join(dshHome(), 'storages', 'session_projcache', 'sessions');
  const result = { added: 0, scanned: 0 };
  if (!existsSync(cacheRoot)) return result;
  let entries;
  try {
    entries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (result.scanned >= limit) break;
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    result.scanned += 1;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(cacheRoot, entry.name), 'utf8'));
    } catch {
      continue;
    }
    const record = parsed?.record;
    const usage = record?.rows?.tokenUsage;
    const totals = usage?.val?.totals;
    if (totals === null || typeof totals !== 'object') continue;
    const identity = record?.identity ?? {};
    const title = typeof record?.rows?.title?.val === 'string' ? record.rows.title.val : '';
    const sessionId = entry.name.replace(/\.json$/, '');
    const changed = ledger.mergeCache(sessionId, {
      cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
      title,
      createdAt: Number(identity.createdAt) || 0,
      lastActivity: Number(identity.createdAt) || 0,
    }, totals, Number(usage.seq));
    if (changed) result.added += 1;
  }
  return result;
}

/**
 * Fold external session backups into the ledger.
 *
 * A backup root is expected to look like a copy of `~/.dsh`: `sessions/` with
 * `session.v4.jsonl.zstd` logs and/or `projcache/` with projection-cache JSON.
 * This is the only source for sessions deleted before the plugin first ran and
 * already gone from the live session directory. Everything is merged by
 * `mergeCache` (max per bucket), so a session present in several backups and in
 * the live ledger is never counted twice.
 * @returns {Promise<{added:number,scanned:number}>}
 */
export async function backfillBackups(ledger, roots = [], limit = 2000) {
  const result = { added: 0, scanned: 0 };
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || !existsSync(root)) continue;

    const sessionsRoot = join(root, 'sessions');
    if (existsSync(sessionsRoot)) {
      const scanLogDir = async (dir, fallbackName) => {
        if (result.scanned >= limit) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        const logEntry = entries.find((entry) => entry.isFile()
          && /session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry.name));
        if (logEntry === undefined) return;
        result.scanned += 1;
        const parsed = parseSessionLog(join(dir, logEntry.name), ledger.decodeCap);
        if (parsed === null) return;
        const sessionId = parsed.sessionId !== '' ? parsed.sessionId : fallbackName;
        const routeTotals = routeTotalsOf(parsed);
        const changed = ledger.mergeParsed(sessionId, {
          cwd: parsed.cwd,
          title: parsed.title,
          route: parsed.route,
          createdAt: parsed.createdAt,
          lastActivity: parsed.createdAt,
        }, routeTotals, parsed.maxSeq, dayTotalsOf(parsed, ledger.tzOffsetMinutes),
        dayRequestsOf(parsed, ledger.tzOffsetMinutes));
        if (changed) result.added += 1;
      };

      let children;
      try {
        children = await readdir(sessionsRoot, { withFileTypes: true });
      } catch {
        children = [];
      }
      for (const child of children) {
        if (result.scanned >= limit) return result;
        if (!child.isDirectory()) continue;
        const childPath = join(sessionsRoot, child.name);
        let grandChildren;
        try {
          grandChildren = await readdir(childPath, { withFileTypes: true });
        } catch {
          continue;
        }
        // Backups come in two layouts: `sessions/<session>/log` (copy of the
        // session directory) and `sessions/<project>/<session>/log`.
        if (grandChildren.some((entry) => entry.isFile()
          && /session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry.name))) {
          await scanLogDir(childPath, child.name);
          continue;
        }
        for (const grandChild of grandChildren) {
          if (result.scanned >= limit) return result;
          if (!grandChild.isDirectory()) continue;
          await scanLogDir(join(childPath, grandChild.name), grandChild.name);
        }
      }
    }

    const cacheRoot = join(root, 'projcache');
    if (existsSync(cacheRoot)) {
      let entries;
      try {
        entries = await readdir(cacheRoot, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (result.scanned >= limit) return result;
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        result.scanned += 1;
        let parsed;
        try {
          parsed = JSON.parse(await readFile(join(cacheRoot, entry.name), 'utf8'));
        } catch {
          continue;
        }
        const record = parsed?.record;
        const usage = record?.rows?.tokenUsage;
        const totals = usage?.val?.totals;
        if (totals === null || typeof totals !== 'object') continue;
        const identity = record?.identity ?? {};
        const title = typeof record?.rows?.title?.val === 'string' ? record.rows.title.val : '';
        const sessionId = entry.name.replace(/\.json$/, '');
        const changed = ledger.mergeCache(sessionId, {
          cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
          title,
          createdAt: Number(identity.createdAt) || 0,
          lastActivity: Number(identity.createdAt) || 0,
        }, totals, Number(usage.seq));
        if (changed) result.added += 1;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- aggregation

function emptyTotals() {
  return { ...zeroBuckets(), requests: 0, sessions: 0 };
}

/**
 * The whole ledger, shaped for the wire: one global row, per-day rows,
 * per-model rows, and per-session rows.
 */
export function aggregate(ledger, tzOffsetMinutes) {
  const global = emptyTotals();
  const byDay = new Map();
  const byRoute = new Map();
  const routeTiers = {};
  const sessions = [];

  for (const record of ledger.all()) {
    const routes = record.routes !== null && typeof record.routes === 'object' && Object.keys(record.routes).length > 0
      ? record.routes
      : { [record.route || 'unknown']: record.totals };
    const totals = sumRoutes(routes);
    for (const [tierRoute, split] of Object.entries(record.routeTiers ?? {})) {
      const slot = routeTiers[tierRoute] ?? (routeTiers[tierRoute] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      slot.peak = addBuckets(slot.peak, split.peak ?? zeroBuckets());
      slot.offpeak = addBuckets(slot.offpeak, split.offpeak ?? zeroBuckets());
    }
    global.uncachedInputTokens += totals.uncachedInputTokens;
    global.outputTokens += totals.outputTokens;
    global.cacheReadTokens += totals.cacheReadTokens;
    global.cacheWriteTokens += totals.cacheWriteTokens;
    global.requests += record.requests;
    global.sessions += 1;

    const days = record.days !== null && typeof record.days === 'object' && Object.keys(record.days).length > 0
      ? record.days
      : null;
    if (days !== null) {
      for (const [day, buckets] of Object.entries(days)) {
        if (!byDay.has(day)) byDay.set(day, emptyTotals());
        const row = byDay.get(day);
        row.uncachedInputTokens += buckets.uncachedInputTokens;
        row.outputTokens += buckets.outputTokens;
        row.cacheReadTokens += buckets.cacheReadTokens;
        row.cacheWriteTokens += buckets.cacheWriteTokens;
        row.requests += Number(record.dayRequests?.[day]) || 0;
        row.sessions += 1;
      }
    } else {
      const when = record.lastActivity || record.createdAt;
      const day = when > 0 ? dayKey(when, tzOffsetMinutes) : 'unknown';
      if (!byDay.has(day)) byDay.set(day, emptyTotals());
      const row = byDay.get(day);
      row.uncachedInputTokens += totals.uncachedInputTokens;
      row.outputTokens += totals.outputTokens;
      row.cacheReadTokens += totals.cacheReadTokens;
      row.cacheWriteTokens += totals.cacheWriteTokens;
      row.requests += record.requests;
      row.sessions += 1;
    }

    for (const [route, buckets] of Object.entries(routes)) {
      if (!byRoute.has(route)) byRoute.set(route, emptyTotals());
      const row = byRoute.get(route);
      row.uncachedInputTokens += buckets.uncachedInputTokens;
      row.outputTokens += buckets.outputTokens;
      row.cacheReadTokens += buckets.cacheReadTokens;
      row.cacheWriteTokens += buckets.cacheWriteTokens;
      row.sessions += 1;
    }
    sessions.push({
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd,
      route: record.route,
      createdAt: record.createdAt,
      lastActivity: record.lastActivity,
      requests: record.requests,
      ...totals,
      ...cacheHitOf(totals),
      totalTokens: totalOf(totals),
    });
  }

  const decorate = (row) => ({ ...row, ...cacheHitOf(row), totalTokens: totalOf(row) });
  sessions.sort((a, b) => (b.lastActivity || b.createdAt) - (a.lastActivity || a.createdAt));

  return {
    global: decorate(global),
    days: [...byDay.entries()].map(([day, row]) => ({ day, ...decorate(row) })).sort((a, b) => (a.day < b.day ? 1 : -1)),
    routes: [...byRoute.entries()].map(([route, row]) => ({ route, ...decorate(row) })).sort((a, b) => b.totalTokens - a.totalTokens),
    routeTiers,
    sessions,
  };
}

// ---------------------------------------------------------------- the service

/**
 * The Remote surface the browser reads.
 *
 * Methods marked `@Remote` become RPCs on `ctx.remote.tokenLedger`; the
 * `stream` mode one pushes a frame per change, which is how the UI updates
 * without polling.
 */
export class TokenUsage extends RemoteServiceBase {
  static Config = Config;

  /**
   * @param ctx - Host context
   * @param config - resolved plugin config
   */
  constructor(ctx, config = {}) {
    super(ctx, 'tokenUsage');
    this.root = config.root || join(dshHome(), 'token-usage');
    this.tzOffsetMinutes = Number.isFinite(config.timeZoneOffsetMinutes)
      ? config.timeZoneOffsetMinutes
      : 480; // Beijing time, independent of the Host process timezone
    this.pricingTier = ['auto', 'peak', 'offpeak'].includes(config.pricingTier)
      ? config.pricingTier
      : 'auto';
    this.holidaySet = new Set(Array.isArray(config.holidayDates) ? config.holidayDates : []);
    // Statutory holidays pulled from the schedule API, cached on disk so an
    // offline start still prices holidays correctly.
    this.holidayApiUrl = typeof config.holidayApiUrl === 'string' ? config.holidayApiUrl : '';
    this.holidayCachePath = join(this.root, 'holidays.json');
    this.holidayYears = new Set();
    this.holidaysFetchedAt = 0;
    this.updateRepo = typeof config.updateRepo === 'string' ? config.updateRepo : '';
    this.updateToken = typeof config.updateToken === 'string' ? config.updateToken : '';
    this.ledger = new TokenLedger(ctx, this.root, {
      flushIntervalMs: config.flushIntervalMs,
      decodeCapBytes: config.decodeCapBytes,
      tzOffsetMinutes: this.tzOffsetMinutes,
      onSaved: () => this.writeMirrors(),
      resolveTier: (epochMs) => (this.pricingTier === 'auto'
        ? pricingTierOf(epochMs, this.holidaySet)
        : this.pricingTier),
    });
    this.backfillLimit = config.backfillLimit ?? 2000;
    this.backupRoots = Array.isArray(config.backupRoots) ? config.backupRoots : [];
    this.workbuddyStatePath = typeof config.workbuddyStatePath === 'string' ? config.workbuddyStatePath : '';
    // 'config' when the path came from config, 'auto' when it was discovered,
    // 'none' when neither produced a usable ledger.
    this.costSource = this.workbuddyStatePath === '' ? 'none' : 'config';
    this.costSourcePath = this.workbuddyStatePath;
    this.costSourceStamp = 0;
    this.costsCheckedAt = 0;
    this.usdToCnyFallback = Number.isFinite(config.usdToCny) ? config.usdToCny : 7.2;
    this.usdToCny = this.usdToCnyFallback;
    this.usdToCnyLive = false;
    this.usdToCnySource = 'fallback';
    this.usdToCnyUpdatedAt = 0;
    this.exchangeRateUrl = typeof config.exchangeRateUrl === 'string' ? config.exchangeRateUrl : '';
    this.exchangeRateRefreshMs = Number.isFinite(config.exchangeRateRefreshMs)
      ? config.exchangeRateRefreshMs
      : 900_000;
    this.exchangeRateTimer = undefined;
    this.officialRates = {
      usd: { ...OFFICIAL_DEEPSEEK_RATES },
      cny: { ...OFFICIAL_CNY_RATES },
      sources: { ...OFFICIAL_PRICE_SOURCES },
      refreshedAt: 0,
      errors: [],
    };
    this.costRates = {};
    this.costSourcePath = '';
    this.costsLoaded = false;
    /** Change listeners for the streaming RPC. */
    this.listeners = new Set();

    ctx.on('session/event', (session, event) => this.record(session, event));

    // Optional HTTP read model. The browser may not have the official
    // `workspaceFiles` namespace in every composition; this same-origin route is
    // a fallback the client can fetch without a third-party Remote namespace.
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefixes',
        path: '/dsh-token-usage/api',
        handler: async (req, res) => {
          const send = (status, value) => {
            res.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify(value));
          };
          try {
            const url = new URL(req.url ?? '/', 'http://local');
            if (url.pathname === '/dsh-token-usage/api/snapshot' && req.method === 'GET') {
              send(200, await this.snapshot());
              return;
            }
            if (url.pathname === '/dsh-token-usage/api/refresh-prices' && req.method === 'POST') {
              send(200, await this.refreshPrices());
              return;
            }
            if (url.pathname === '/dsh-token-usage/api/update' && req.method === 'GET') {
              send(200, await this.checkForUpdate());
              return;
            }
            if (url.pathname === '/dsh-token-usage/api/update' && req.method === 'POST') {
              send(200, await this.applyUpdate());
              return;
            }
            send(404, { error: 'not-found' });
          } catch (error) {
            send(500, { error: String(error) });
          }
        },
      }), 'dsh-token-usage: http snapshot');
    });

    void this.start();
  }

  /**
   * Write the aggregate into each known workspace as a small hidden mirror.
   *
   * The browser cannot mount a third-party Remote namespace, so the client reads
   * this mirror through the official `workspaceFiles` namespace instead. The
   * canonical ledger still lives under `~/.dsh/token-usage`; the mirror is only a
   * read model for the UI and is rewritten after every durable flush.
   * @returns {Promise<void>}
   */
  async writeMirrors() {
    const cwds = new Set();
    for (const record of this.ledger.all()) {
      if (typeof record.cwd === 'string' && record.cwd !== '') cwds.add(record.cwd);
    }
    if (cwds.size === 0) return;
    const text = JSON.stringify(this.dashboard());
    for (const cwd of cwds) {
      try {
        const target = join(cwd, '.dsh-token-usage.json');
        const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, target);
      } catch {
        /* a read-only or vanished workspace must not break the ledger */
      }
    }
  }

  /** Fold one committed session event, skipping anything already in the log replay. */
  record(session, event) {
    if (event === null || event === undefined) return;
    const usage = usageOf(event);
    if (usage === undefined) return;
    const header = session.header ?? {};
    const eventRoute = event.data?.message?.source;
    const route = typeof eventRoute?.provider === 'string' && typeof eventRoute?.model === 'string'
      // The settled message names the route that actually answered; this is the
      // only place a mid-session model switch is visible, and it is what makes
      // non-DeepSeek routes (a local proxy fronting GLM/Kimi/MiniMax) correct.
      ? `${eventRoute.provider}:${eventRoute.model}`
      : (typeof header.config?.provider === 'string' && typeof header.config?.model === 'string'
        ? `${header.config.provider}:${header.config.model}`
        : undefined);
    const counted = this.ledger.applyLive(
      session.id,
      {
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: Number(header.createdAt) || 0,
        ...(route === undefined ? {} : { route }),
      },
      usage,
      Number(event.time) || Date.now(),
      Number.isSafeInteger(event.seq) ? event.seq : undefined,
    );
    if (counted) this.publish();
  }

  /** Push the current aggregate to every streaming subscriber. */
  publish() {
    if (this.listeners.size === 0) return;
    const frame = this.dashboard();
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch {
        /* a broken subscriber must not stop the others */
      }
    }
  }

  /**
   * Fetch one text resource. Node's fetch is preferred, but on this Windows
   * host outbound Node TLS is occasionally reset while PowerShell works; the
   * PowerShell fallback keeps the refresh button useful instead of silently
   * falling back to the static FX rate.
   */
  async fetchText(url, timeoutMs = 7000) {
    let nativeError;
    if (typeof fetch === 'function') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        nativeError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (process.platform === 'win32') {
      const safe = String(url).replace(/'/g, "''");
      const script = [
        "$ProgressPreference='SilentlyContinue';",
        `$r=Invoke-WebRequest -UseBasicParsing -Uri '${safe}' -TimeoutSec 15;`,
        '$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$r.Content));',
        'ConvertTo-Json -Compress $b',
      ].join(' ');
      const encoded = await this.runPowershell(script);
      if (typeof encoded === 'string' && encoded !== '') {
        return Buffer.from(encoded, 'base64').toString('utf8');
      }
    }
    throw nativeError ?? new Error('fetch unavailable');
  }

  async refreshExchangeRate() {
    const url = this.exchangeRateUrl;
    if (!url) {
      return { ok: false, rate: this.usdToCny, live: false, error: 'exchange rate source unavailable' };
    }
    try {
      const doc = JSON.parse(await this.fetchText(url));
      const rate = Number(doc?.rates?.CNY ?? doc?.conversion_rates?.CNY);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('CNY rate missing');
      this.usdToCny = rate;
      this.usdToCnyLive = true;
      this.usdToCnySource = url;
      this.usdToCnyUpdatedAt = Date.now();
      this.ctx.logger?.info?.(`[${name}] USD/CNY updated: ${rate}`);
      this.publish();
      void this.writeMirrors();
      return { ok: true, rate, live: true, source: url, updatedAt: this.usdToCnyUpdatedAt };
    } catch (error) {
      // Keep the last good live rate (or the configured fallback) and surface
      // the degraded source in the UI instead of failing the plugin.
      this.usdToCnyLive = false;
      this.usdToCnySource = this.usdToCnyUpdatedAt > 0 ? 'last' : 'fallback';
      if (this.usdToCnyUpdatedAt === 0) this.usdToCnyUpdatedAt = Date.now();
      this.ctx.logger?.warn?.(`[${name}] USD/CNY refresh failed, keeping ${this.usdToCny}: ${String(error)}`);
      this.publish();
      return { ok: false, rate: this.usdToCny, live: false, source: this.usdToCnySource, error: String(error) };
    }
  }

  /**
   * Re-fetch the official price tables we can parse (DeepSeek USD, Zhipu CNY).
   * A failed provider keeps its previous catalog; the client gets the error list
   * so it does not pretend a partial refresh succeeded.
   */
  async refreshOfficialRates() {
    const errors = [];
    let updated = 0;
    const jobs = [
      { key: 'deepseek', url: this.officialRates.sources.deepseek, target: 'usd', parse: parseDeepSeekRates },
      { key: 'glm', url: this.officialRates.sources.glm, target: 'cny', parse: parseGlmRates },
    ];
    await Promise.all(jobs.map(async (job) => {
      try {
        const rates = job.parse(await this.fetchText(job.url, 8000));
        const models = Object.keys(rates);
        if (models.length === 0) throw new Error('no model prices parsed');
        Object.assign(this.officialRates[job.target], rates);
        updated += models.length;
      } catch (error) {
        errors.push(`${job.key}: ${String(error)}`);
      }
    }));
    this.officialRates.refreshedAt = Date.now();
    this.officialRates.errors = errors;
    return {
      ok: updated > 0,
      updated,
      errors,
      refreshedAt: this.officialRates.refreshedAt,
      sources: { ...this.officialRates.sources },
    };
  }

  /** Refresh FX, official model prices, and WorkBuddy credit rates together. */
  async refreshPrices() {
    const fx = await this.refreshExchangeRate();
    const official = await this.refreshOfficialRates();
    await this.loadCostRates().catch((error) => {
      this.ctx.logger?.warn?.(`[${name}] WorkBuddy rate refresh failed: ${String(error)}`);
    });
    const workbuddyModels = Object.keys(this.costRates ?? {}).length;
    let mirrorError = '';
    try {
      await this.writeMirrors();
    } catch (error) {
      mirrorError = String(error);
      this.ctx.logger?.warn?.(`[${name}] mirror rewrite after price refresh failed: ${mirrorError}`);
    }
    this.publish();
    const warnings = [];
    if (!fx.ok) warnings.push('汇率未更新，保留旧值');
    if (!official.ok) warnings.push('模型官方价未更新，保留旧值');
    else if (official.errors.length > 0) warnings.push('部分模型价来源不可用');
    if (workbuddyModels === 0) warnings.push('WorkBuddy 积分源无数据');
    if (mirrorError !== '') warnings.push('镜像暂未刷新');
    const ok = Boolean(fx.ok || official.ok || workbuddyModels > 0);
    return {
      ok,
      partial: ok && warnings.length > 0,
      warnings,
      refreshedAt: Date.now(),
      fx,
      official,
      workbuddy: {
        source: this.costSource,
        sourcePath: this.costSourcePath,
        models: workbuddyModels,
      },
    };
  }

  startExchangeRateRefresh() {
    if (!this.exchangeRateUrl || this.exchangeRateTimer !== undefined) return;
    void this.refreshExchangeRate();
    this.exchangeRateTimer = setInterval(() => {
      void this.refreshExchangeRate();
    }, this.exchangeRateRefreshMs);
    this.exchangeRateTimer.unref?.();
  }

  async start() {
    await this.loadCostRates();
    this.startExchangeRateRefresh();
    // Tiering reads the holiday set, so it must be ready before any replay.
    await this.loadHolidays();
    await this.ledger.load();
    this.ledger.start();
    if (this.backfilled) return;
    this.backfilled = true;
    const logResult = await backfill(this.ledger, this.backfillLimit).catch((error) => {
      this.ctx.logger?.warn?.(`[${name}] history backfill failed: ${String(error)}`);
      return { added: 0 };
    });
    // Second source: cached projections. This is the only way to keep sessions
    // whose log directory was already deleted before this plugin first ran.
    const cacheResult = await backfillCaches(this.ledger, this.backfillLimit).catch((error) => {
      this.ctx.logger?.warn?.(`[${name}] projection-cache backfill failed: ${String(error)}`);
      return { added: 0 };
    });
    // Third source: explicit session backups under E:\ (or wherever configured).
    const backupResult = await backfillBackups(this.ledger, this.backupRoots, this.backfillLimit).catch((error) => {
      this.ctx.logger?.warn?.(`[${name}] session-backup backfill failed: ${String(error)}`);
      return { added: 0 };
    });
    // Fourth source: the tier split for records written before it existed.
    const retiered = await retierFromLogs(this.ledger).catch((error) => {
      this.ctx.logger?.warn?.(`[${name}] tier migration failed: ${String(error)}`);
      return 0;
    });
    if (retiered > 0) {
      this.ctx.logger?.info?.(`[${name}] tiered ${retiered} historical session(s) from their logs`);
      await this.ledger.flush();
    }
    const added = logResult.added + cacheResult.added + backupResult.added;
    if (added > 0) {
      this.ctx.logger?.info?.(`[${name}] backfilled ${added} historical session(s) (logs + projection cache + backups)`);
      await this.ledger.flush();
      this.publish();
    } else if (this.ledger.dirty) {
      // The load-time duplicate migration changed the ledger even when no new
      // session was found; persist the cleaned form immediately.
      await this.ledger.flush();
    }
    await this.writeMirrors();
  }

  async stop() {
    if (this.exchangeRateTimer !== undefined) {
      clearInterval(this.exchangeRateTimer);
      this.exchangeRateTimer = undefined;
    }
    await this.ledger.stop?.();
  }

  /** Current aggregate plus the small amount of metadata the dashboard shows. */
  dashboard() {
    const agg = aggregate(this.ledger, this.tzOffsetMinutes);
    this.attachRowCosts(agg);
    return {
      ...agg,
      meta: {
        generatedAt: Date.now(),
        version: this.ownVersion(),
        tzOffsetMinutes: this.tzOffsetMinutes,
        manifestPath: this.ledger.manifestPath,
        root: this.root,
        costs: this.costSummary(agg),
      },
    };
  }

  /**
   * Read the optional WorkBuddy state ledger. `cost_per_1k` is the observed
   * credit price per 1000 tokens (not a currency amount); average it per model
   * weighted by observation count so one stale account cannot dominate.
   */
  async loadCostRates() {
    this.costsLoaded = true;
    const configured = this.workbuddyStatePath;
    const path = configured === '' ? discoverWorkbuddyStatePath() : configured;
    this.costSource = configured === '' ? (path === '' ? 'none' : 'auto') : 'config';
    if (!path || !existsSync(path)) {
      this.costRates = {};
      this.costSourcePath = '';
      this.costSourceStamp = 0;
      this.costsCheckedAt = Date.now();
      return;
    }
    try {
      const doc = JSON.parse(await readFile(path, 'utf8'));
      const sums = new Map();
      for (const account of Object.values(doc.accounts ?? {})) {
        const modelCosts = account?.model_costs;
        if (modelCosts === null || typeof modelCosts !== 'object') continue;
        for (const [model, value] of Object.entries(modelCosts)) {
          const rate = Number(value?.cost_per_1k);
          if (!Number.isFinite(rate) || rate < 0) continue;
          const samples = Math.max(1, Number(value?.samples) || 1);
          const current = sums.get(model) ?? { weighted: 0, weight: 0, samples: 0 };
          current.weighted += rate * samples;
          current.weight += samples;
          current.samples += samples;
          sums.set(model, current);
        }
      }
      const rates = {};
      for (const [model, value] of sums) {
        rates[model] = {
          per1k: value.weight > 0 ? value.weighted / value.weight : null,
          samples: value.samples,
        };
      }
      this.costRates = rates;
      this.costSourcePath = path;
      this.costSourceStamp = workbuddyStateStamp(path);
      this.costsCheckedAt = Date.now();
    } catch (error) {
      this.ctx.logger?.warn?.(`[${name}] cost source read failed: ${String(error)}`);
      this.costRates = {};
      this.costSourcePath = '';
    }
  }

  /**
   * Keep the credit rates usable while the plugin runs, without polling on every
   * read: an auto-discovered source is looked up again when it disappears (the
   * gateway may start after the Host does), and a rewritten ledger is re-read.
   * Both checks are throttled to once per 30 s.
   */
  async refreshCostRates() {
    const now = Date.now();
    if (now - this.costsCheckedAt < 30_000) return;
    this.costsCheckedAt = now;
    const configured = this.workbuddyStatePath;
    const path = configured === '' ? this.costSourcePath : configured;
    if (!path || !existsSync(path)) {
      await this.loadCostRates();
      return;
    }
    const stamp = workbuddyStateStamp(path);
    if (stamp === 0 || stamp !== this.costSourceStamp) await this.loadCostRates();
  }

  /** DeepSeek official list-price cost for the routes that have a public rate. */
  /** Version of the installed package (`lib/index.js` -> `../package.json`). */
  ownVersion() {
    try {
      const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
      return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /** Directory this package is installed in, with a trailing separator. */
  packageRoot() {
    return fileURLToPath(new URL('../', import.meta.url));
  }

  /**
   * Run one PowerShell snippet; its stdout is parsed as JSON when present.
   * The script travels as `-EncodedCommand` so quotes inside it survive Windows
   * command-line quoting, and the child's stderr is surfaced on failure.
   */
  async runPowershell(script, token = '') {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: 300_000, env: { ...process.env, DSH_UPDATE_TOKEN: token } },
      ));
    } catch (error) {
      const detail = String(error?.stderr ?? '').trim() || String(error?.message ?? error);
      throw new Error(detail);
    }
    const text = String(stdout ?? '').trim();
    return text === '' ? {} : JSON.parse(text);
  }

  /**
   * Newest release of `updateRepo`.
   * @returns {Promise<{tag: string, publishedAt: string|null, body: string, assets: object[]}>}
   */
  async latestRelease() {
    if (this.updateRepo === '') throw new Error('未配置更新仓库（updateRepo）');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$headers = @{ 'User-Agent' = 'dsh-token-usage'; 'Accept' = 'application/vnd.github+json' }",
      'if ($env:DSH_UPDATE_TOKEN) { $headers.Authorization = "Bearer $env:DSH_UPDATE_TOKEN" }',
      `$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/${this.updateRepo}/releases/latest' -Headers $headers -TimeoutSec 30`,
      '$assets = @($release.assets | ForEach-Object { [pscustomobject]@{ name = $_.name; size = $_.size; url = $_.url } })',
      '[pscustomobject]@{ tag = $release.tag_name; publishedAt = $release.published_at; body = $release.body; assets = $assets } | ConvertTo-Json -Depth 5 -Compress',
    ].join('; ');
    const doc = await this.runPowershell(script, this.updateToken);
    return {
      tag: String(doc.tag ?? ''),
      publishedAt: typeof doc.publishedAt === 'string' ? doc.publishedAt : null,
      body: typeof doc.body === 'string' ? doc.body : '',
      assets: Array.isArray(doc.assets) ? doc.assets : [],
    };
  }

  /**
   * Compare the installed version with the newest release.
   * @returns {Promise<object>} current/latest/newer plus release notes, or an error.
   */
  async checkForUpdate() {
    const current = this.ownVersion();
    let release;
    try {
      release = await this.latestRelease();
    } catch (error) {
      return { ok: false, current, error: describeUpdateError(error) };
    }
    const latest = String(release.tag ?? '').replace(/^v/i, '');
    const asset = release.assets.find((item) => /\.zip$/i.test(String(item.name ?? '')));
    return {
      ok: true,
      current,
      latest,
      newer: compareVersions(latest, current) > 0,
      publishedAt: release.publishedAt,
      notes: String(release.body ?? '').replace(/\r/g, '').slice(0, 600),
      assetName: asset?.name ?? null,
      assetSize: asset?.size ?? null,
      repo: this.updateRepo,
    };
  }

  /**
   * Download the newest release and install it over this package.
   *
   * Keeps `node_modules` (the vendored peer dependency) and backs the previous
   * files up next to the plugin directory; the new code takes effect after a DSH
   * restart. A release whose package name does not match is refused.
   * @returns {Promise<object>} from/to versions and whether anything was applied.
   */
  async applyUpdate() {
    const current = this.ownVersion();
    let release;
    try {
      release = await this.latestRelease();
    } catch (error) {
      return { ok: false, current, error: describeUpdateError(error) };
    }
    const latest = String(release.tag ?? '').replace(/^v/i, '');
    if (compareVersions(latest, current) <= 0) {
      return { ok: true, from: current, to: current, applied: false };
    }
    const asset = release.assets.find((item) => /\.zip$/i.test(String(item.name ?? '')));
    if (asset === undefined) return { ok: false, current, error: '最新 Release 没有 zip 资产' };

    const workspace = await mkdtemp(join(tmpdir(), 'dsh-token-usage-update-'));
    const zipPath = join(workspace, 'release.zip');
    const stage = join(workspace, 'stage');
    try {
      await mkdir(stage, { recursive: true });
      const escapedZip = zipPath.replace(/'/g, "''");
      const downloadScript = [
        "$ErrorActionPreference = 'Stop'",
        "$headers = @{ 'User-Agent' = 'dsh-token-usage'; 'Accept' = 'application/octet-stream' }",
        'if ($env:DSH_UPDATE_TOKEN) { $headers.Authorization = "Bearer $env:DSH_UPDATE_TOKEN" }',
        `Invoke-WebRequest -Uri '${String(asset.url).replace(/'/g, "''")}' -Headers $headers -OutFile '${escapedZip}' -TimeoutSec 300`,
      ].join('; ');
      await this.runPowershell(downloadScript, this.updateToken);
      if (!existsSync(zipPath)) throw new Error('下载失败：没有得到 zip 文件');
      await this.runPowershell(
        `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${stage.replace(/'/g, "''")}' -Force`,
      );

      const candidates = [stage, ...(await readdir(stage, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(stage, entry.name))];
      let packageDir;
      for (const candidate of candidates) {
        const manifestPath = join(candidate, 'package.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (manifest.name === 'dsh-token-usage') {
          packageDir = candidate;
          break;
        }
      }
      if (packageDir === undefined) return { ok: false, current, error: '下载包内没有 dsh-token-usage/package.json' };

      const target = this.packageRoot();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(dirname(target), `.update-backup-${current}-${stamp}`);
      const keep = (item) => !String(item).includes('node_modules') && !String(item).includes('.update-backup-');
      await cp(target, backup, { recursive: true, force: true, filter: keep });
      await cp(packageDir, target, { recursive: true, force: true, filter: keep });
      this.ctx.logger?.info?.(`[${name}] updated ${current} -> ${latest}; backup ${backup}`);
      return { ok: true, from: current, to: latest, applied: true, backup, restart: true };
    } catch (error) {
      return { ok: false, current, error: describeUpdateError(error) };
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Load the China statutory-holiday schedule into the tier rule.
   *
   * The cached file (written by a previous run) is authoritative for the years
   * it holds; a missing or week-old snapshot is refreshed from `holidayApiUrl`.
   * Failures are non-fatal: the configured `holidayDates` and any cached years
   * stay in effect, and tiering simply keeps treating those days as weekdays.
   * @returns {Promise<void>}
   */
  async loadHolidays() {
    let cache = null;
    try {
      cache = JSON.parse(await readFile(this.holidayCachePath, 'utf8'));
    } catch {
      cache = null;
    }
    const years = cache !== null && typeof cache.years === 'object' ? cache.years : {};
    for (const [year, dates] of Object.entries(years)) {
      if (!Array.isArray(dates)) continue;
      this.holidayYears.add(String(year));
      for (const date of dates) if (typeof date === 'string' && date !== '') this.holidaySet.add(date);
    }
    this.holidaysFetchedAt = Number(cache?.fetchedAt) || 0;

    if (this.holidayApiUrl === '') return;
    const now = Date.now();
    const local = new Date(now + 8 * 60 * 60 * 1000);
    const wanted = [local.getUTCFullYear()];
    // The next year's schedule is normally published in November.
    if (local.getUTCMonth() + 1 >= 11) wanted.push(local.getUTCFullYear() + 1);
    const stale = now - this.holidaysFetchedAt > 7 * 24 * 60 * 60 * 1000;
    const missing = wanted.filter((year) => stale || !this.holidayYears.has(String(year)));
    if (missing.length === 0) return;

    let changed = false;
    for (const year of missing) {
      const dates = await this.fetchHolidayYear(year);
      if (dates.length === 0) continue;
      years[String(year)] = dates;
      this.holidayYears.add(String(year));
      for (const date of dates) this.holidaySet.add(date);
      changed = true;
    }
    if (!changed) return;
    this.holidaysFetchedAt = now;
    try {
      await mkdir(this.root, { recursive: true });
      const tmp = `${this.holidayCachePath}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify({ fetchedAt: now, years }, null, 2), 'utf8');
      await rename(tmp, this.holidayCachePath);
    } catch (error) {
      this.ctx.logger?.warn?.(`[${name}] holiday cache write failed: ${String(error)}`);
    }
  }

  /**
   * Fetch one year's statutory days off from the schedule API.
   * @param year - calendar year in Beijing time.
   * @returns `YYYY-MM-DD` dates, or an empty array when the API is unavailable.
   */
  async fetchHolidayYear(year) {
    const url = this.holidayApiUrl.replace('{year}', String(year));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return [];
      const doc = await response.json();
      const table = doc?.holiday;
      if (table === null || typeof table !== 'object') return [];
      const dates = [];
      for (const entry of Object.values(table)) {
        // `holiday: true` is a statutory day off; `holiday: false` is a 调休
        // make-up workday, which DeepSeek still bills on the weekday rule.
        if (entry?.holiday === true && typeof entry.date === 'string') dates.push(entry.date);
      }
      return [...new Set(dates)].sort();
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Attach a cost to every day, model, and session row.
   *
   * Money uses the official list price split by tier (off-peak is half, the
   * untiered leftover is priced at peak). Credits use the WorkBuddy gateway's
   * observed `cost_per_1k`. A row is priced only where a rate covers it: rows
   * whose tokens are only partly representable are scaled by the priced share,
   * never invented.
   * @param agg - the aggregate returned by {@link aggregate}; rows gain `cost`.
   */
  attachRowCosts(agg) {
    const residual = (all, tiers) => {
      const priced = addBuckets(tiers?.peak ?? zeroBuckets(), tiers?.offpeak ?? zeroBuckets());
      return {
        uncachedInputTokens: Math.max(0, (Number(all?.uncachedInputTokens) || 0) - (Number(priced.uncachedInputTokens) || 0)),
        outputTokens: Math.max(0, (Number(all?.outputTokens) || 0) - (Number(priced.outputTokens) || 0)),
        cacheReadTokens: Math.max(0, (Number(all?.cacheReadTokens) || 0) - (Number(priced.cacheReadTokens) || 0)),
        cacheWriteTokens: Math.max(0, (Number(all?.cacheWriteTokens) || 0) - (Number(priced.cacheWriteTokens) || 0)),
      };
    };
    const shape = (usd, credits) => ({
      usd: usd === undefined ? null : usd,
      cny: usd === undefined ? null : usd * this.usdToCny,
      credits: credits === undefined ? null : credits,
    });

    /** USD for one route's tier buckets plus its untiered leftover. */
    const moneyOf = (route, tiers, leftover) => {
      const model = typeof route === 'string' ? route.split(':').pop() : '';
      const rate = officialRateOf(model, this.usdToCny, this.officialRates);
      if (rate === undefined) return undefined;
      const peakBuckets = tiers?.peak ?? zeroBuckets();
      const offpeakBuckets = tiers?.offpeak ?? zeroBuckets();
      const leftoverBuckets = leftover ?? zeroBuckets();
      if (!rate.tiered) {
        return priceBuckets(addBuckets(addBuckets(peakBuckets, offpeakBuckets), leftoverBuckets), rate);
      }
      if (this.pricingTier === 'peak') {
        return priceBuckets(addBuckets(addBuckets(peakBuckets, offpeakBuckets), leftoverBuckets), rate);
      }
      if (this.pricingTier === 'offpeak') {
        return priceBuckets(addBuckets(addBuckets(peakBuckets, offpeakBuckets), leftoverBuckets), halfRates(rate));
      }
      return priceBuckets(peakBuckets, rate)
        + priceBuckets(offpeakBuckets, halfRates(rate))
        + priceBuckets(leftoverBuckets, rate);
    };

    /** Credits for one route's buckets at the gateway's observed blended price. */
    const creditsOf = (route, buckets) => {
      const model = typeof route === 'string' ? route.split(':').pop() : '';
      const rate = this.costRates?.[model]?.per1k;
      if (rate === null || rate === undefined) return undefined;
      return (totalsOfBuckets(buckets) / 1000) * rate;
    };

    // Per-model rows: the aggregate already carries the per-route tier split.
    for (const row of agg.routes ?? []) {
      const tiers = agg.routeTiers?.[row.route];
      const usd = moneyOf(row.route, tiers, tiers === undefined ? row : residual(row, tiers));
      row.cost = shape(usd, creditsOf(row.route, row));
    }

    // Per-session rows: sum each record's own routes.
    const sessions = new Map();
    const days = new Map();
    for (const record of this.ledger.all()) {
      let usd;
      let credits;
      for (const [route, buckets] of Object.entries(record.routes ?? {})) {
        const tiers = record.routeTiers?.[route];
        const routeUsd = moneyOf(route, tiers, tiers === undefined ? buckets : residual(buckets, tiers));
        if (routeUsd !== undefined) usd = (usd ?? 0) + routeUsd;
        const routeCredits = creditsOf(route, buckets);
        if (routeCredits !== undefined) credits = (credits ?? 0) + routeCredits;
      }
      sessions.set(canonicalSessionId(record.sessionId), shape(usd, credits));

      for (const [day, routes] of Object.entries(record.dayRoutes ?? {})) {
        let dayUsd;
        let dayCredits;
        let dayTokens = 0;
        let creditTokens = 0;
        for (const [route, tiers] of Object.entries(routes)) {
          const routeUsd = moneyOf(route, tiers, undefined);
          if (routeUsd !== undefined) dayUsd = (dayUsd ?? 0) + routeUsd;
          const all = addBuckets(tiers.peak ?? zeroBuckets(), tiers.offpeak ?? zeroBuckets());
          const routeCredits = creditsOf(route, all);
          if (routeCredits !== undefined) dayCredits = (dayCredits ?? 0) + routeCredits;
          const tokens = totalsOfBuckets(all);
          dayTokens += tokens;
          if (routeCredits !== undefined) creditTokens += tokens;
        }
        const slot = days.get(day) ?? { usd: undefined, credits: undefined, tokens: 0, creditTokens: 0 };
        if (dayUsd !== undefined) slot.usd = (slot.usd ?? 0) + dayUsd;
        if (dayCredits !== undefined) slot.credits = (slot.credits ?? 0) + dayCredits;
        slot.tokens += dayTokens;
        slot.creditTokens += creditTokens;
        days.set(day, slot);
      }
    }
    for (const row of agg.sessions ?? []) {
      row.cost = sessions.get(canonicalSessionId(row.sessionId)) ?? shape(undefined, undefined);
    }
    for (const row of agg.days ?? []) {
      const slot = days.get(row.day);
      if (slot === undefined) {
        row.cost = shape(undefined, undefined);
        continue;
      }
      const total = Number(row.totalTokens) || 0;
      const priceUsd = slot.usd === undefined
        ? undefined
        : slot.tokens > 0 ? (slot.usd / slot.tokens) * Math.max(0, total) : 0;
      const priceCredits = slot.credits === undefined
        ? undefined
        : slot.creditTokens > 0 ? (slot.credits / slot.creditTokens) * Math.max(0, total) : 0;
      row.cost = shape(priceUsd, priceCredits);
    }
  }

  /**
   * DeepSeek official list-price cost, split by the tier each sample was recorded
   * in. Off-peak prices are exactly half the peak list price, so the mixed total
   * matches what DeepSeek would actually bill. Samples recorded before the tier
   * split existed carry no tier; that residual is priced at the peak rate (the
   * previous behaviour) and reported separately as `legacy`.
   */
  officialCostSummary(agg) {
    const totalTokens = Number(agg?.global?.totalTokens) || 0;
    const mode = this.pricingTier === 'peak' || this.pricingTier === 'offpeak' ? this.pricingTier : 'auto';
    const bucketsOf = (row) => ({
      uncachedInputTokens: Number(row?.uncachedInputTokens) || 0,
      outputTokens: Number(row?.outputTokens) || 0,
      cacheReadTokens: Number(row?.cacheReadTokens) || 0,
      cacheWriteTokens: Number(row?.cacheWriteTokens) || 0,
    });
    const parts = {
      peak: { usd: 0, tokens: 0 },
      offpeak: { usd: 0, tokens: 0 },
      legacy: { usd: 0, tokens: 0 },
    };
    let usd = 0;
    let coveredTokens = 0;
    const models = {};
    for (const route of agg?.routes ?? []) {
      const model = typeof route.route === 'string' ? route.route.split(':').pop() : '';
      const rate = officialRateOf(model, this.usdToCny, this.officialRates);
      if (rate === undefined) continue;
      const all = bucketsOf(route);
      const routeTokens = Number(route.totalTokens) || totalsOfBuckets(all);
      let peakUsd = 0;
      let offpeakUsd = 0;
      let legacyUsd = 0;
      if (!rate.tiered) {
        // Zhipu rates have no peak/off-peak split; keep them in the legacy
        // bucket so the total remains exact and explicit.
        legacyUsd = priceBuckets(all, rate);
        parts.legacy.tokens += routeTokens;
      } else if (mode === 'peak') {
        peakUsd = priceBuckets(all, rate);
        parts.peak.tokens += routeTokens;
      } else if (mode === 'offpeak') {
        offpeakUsd = priceBuckets(all, halfRates(rate));
        parts.offpeak.tokens += routeTokens;
      } else {
        const split = agg?.routeTiers?.[route.route];
        const peakBuckets = bucketsOf(split?.peak);
        const offpeakBuckets = bucketsOf(split?.offpeak);
        const residue = {
          uncachedInputTokens: Math.max(0, all.uncachedInputTokens - peakBuckets.uncachedInputTokens - offpeakBuckets.uncachedInputTokens),
          outputTokens: Math.max(0, all.outputTokens - peakBuckets.outputTokens - offpeakBuckets.outputTokens),
          cacheReadTokens: Math.max(0, all.cacheReadTokens - peakBuckets.cacheReadTokens - offpeakBuckets.cacheReadTokens),
          cacheWriteTokens: Math.max(0, all.cacheWriteTokens - peakBuckets.cacheWriteTokens - offpeakBuckets.cacheWriteTokens),
        };
        peakUsd = priceBuckets(peakBuckets, rate);
        offpeakUsd = priceBuckets(offpeakBuckets, halfRates(rate));
        legacyUsd = priceBuckets(residue, rate);
        parts.peak.tokens += totalsOfBuckets(peakBuckets);
        parts.offpeak.tokens += totalsOfBuckets(offpeakBuckets);
        parts.legacy.tokens += totalsOfBuckets(residue);
      }
      parts.peak.usd += peakUsd;
      parts.offpeak.usd += offpeakUsd;
      parts.legacy.usd += legacyUsd;
      const routeUsd = peakUsd + offpeakUsd + legacyUsd;
      usd += routeUsd;
      coveredTokens += routeTokens;
      const current = models[model] ?? {
        cacheReadPerMillion: rate.cacheRead,
        inputPerMillion: rate.input,
        outputPerMillion: rate.output,
        currency: rate.currency,
        tiered: rate.tiered,
        tokens: 0,
        usd: 0,
      };
      current.tokens += routeTokens;
      current.usd += routeUsd;
      models[model] = current;
    }
    const cny = (value) => value * this.usdToCny;
    return {
      configured: Object.keys(models).length > 0,
      currency: 'USD',
      tier: mode,
      peakWindows: 'Asia/Shanghai Mon-Fri 09:00-12:00, 14:00-18:00',
      usd,
      cny: cny(usd),
      peak: { usd: parts.peak.usd, cny: cny(parts.peak.usd), tokens: parts.peak.tokens },
      offpeak: { usd: parts.offpeak.usd, cny: cny(parts.offpeak.usd), tokens: parts.offpeak.tokens },
      legacy: { usd: parts.legacy.usd, cny: cny(parts.legacy.usd), tokens: parts.legacy.tokens },
      usdToCny: this.usdToCny,
      usdToCnyLive: this.usdToCnyLive,
      usdToCnySource: this.usdToCnySource,
      usdToCnyUpdatedAt: this.usdToCnyUpdatedAt,
      usdToCnyFallback: this.usdToCnyFallback,
      coveredTokens,
      totalTokens,
      coverage: totalTokens > 0 ? coveredTokens / totalTokens : null,
      models,
    };
  }

  /** Credit cost for every route that has an observed WorkBuddy price. */
  costSummary(agg) {
    const rates = this.costRates ?? {};
    const configured = Object.keys(rates).length > 0;
    const totalTokens = Number(agg?.global?.totalTokens) || 0;
    let coveredTokens = 0;
    let credits = 0;
    const models = {};
    for (const route of agg?.routes ?? []) {
      const model = typeof route.route === 'string' ? route.route.split(':').pop() : '';
      const rate = rates[model]?.per1k;
      if (rate === null || rate === undefined) continue;
      const tokens = Number(route.totalTokens) || 0;
      const routeCost = (tokens / 1000) * rate;
      coveredTokens += tokens;
      credits += routeCost;
      const current = models[model] ?? {
        per1k: rate,
        samples: rates[model].samples,
        tokens: 0,
        credits: 0,
      };
      current.tokens += tokens;
      current.credits += routeCost;
      models[model] = current;
    }
    const workbuddy = {
      configured,
      source: this.costSource ?? 'none',
      unit: 'credits',
      credits: configured ? credits : null,
      coveredTokens,
      totalTokens,
      coverage: totalTokens > 0 ? coveredTokens / totalTokens : null,
      sourcePath: this.costSourcePath,
      models,
    };
    const official = this.officialCostSummary(agg);
    return {
      ...workbuddy,
      configured: configured || official.configured,
      workbuddy,
      official,
    };
  }

  /**
   * One-shot read of the whole ledger.
   * @returns {Promise<object>} the aggregate
   */
  async snapshot() {
    await this.ledger.load();
    if (!this.costsLoaded) await this.loadCostRates();
    else await this.refreshCostRates();
    return this.dashboard();
  }

  /**
   * Follow the ledger: the current aggregate, then one frame per change.
   *
   * The browser resource provider turns this frame stream into live UI updates,
   * so there is no polling anywhere in the client.
   * @returns {AsyncIterable<object>}
   */
  async *follow() {
    yield await this.snapshot();
    const queue = [];
    let notify = null;
    const listener = (frame) => {
      queue.push(frame);
      notify?.();
    };
    this.listeners.add(listener);
    try {
      for (;;) {
        if (queue.length === 0) {
          await new Promise((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
        while (queue.length > 0) yield queue.shift();
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  /** Force a durable write. */
  async flush() {
    await this.ledger.flush({ force: true });
  }
}

/**
 * Mark one public instance method as a Remote endpoint.
 *
 * The installed typert-protocol exposes `Remote` as a stage-3 decorator: a
 * decorator callable receives a method and a decorator context, and registers an
 * initializer that stamps the method marker onto the class prototype. This file
 * is plain JavaScript, so we synthesize that context and run the initializer
 * against a throwaway instance whose prototype is the class prototype. The
 * result is the same marker the decorator would have produced at class-definition
 * time, before the Gateway scans the service.
 *
 * A missing protocol package is not fatal: the ledger still folds, persists and
 * aggregates, and the client simply shows no history. Better a degraded panel
 * than a plugin that refuses to load.
 *
 * @param Class - the Service class to mark
 * @param method - public instance method name
 * @param options - optional `{ mode: 'stream' }` marker options
 * @returns whether the marker was applied
 */
function markRemote(Class, method, options) {
  if (Remote === null) return false;
  const initializers = [];
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      initializers.push(initializer);
    },
  };
  const decorator = options === undefined ? Remote(method) : Remote(options);
  decorator(undefined, context);
  const receiver = Object.create(Class.prototype);
  for (const initializer of initializers) initializer.call(receiver);
  return true;
}

markRemote(TokenUsage, 'snapshot');
markRemote(TokenUsage, 'follow', { mode: 'stream' });
markRemote(TokenUsage, 'flush');

export function apply(ctx, config = {}) {
  // Cordis constructs the Service; passing an instance here would throw
  // "invalid plugin, expect function or object with an apply method".
  ctx.plugin(TokenUsage, config);
}

export default { name, inject, Config, apply, TokenUsage, TokenLedger };
