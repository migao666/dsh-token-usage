"""Patch dsh-token-usage: split the official cost view by DeepSeek's peak/off-peak tiers.

DeepSeek halves every list price outside its peak windows (Beijing time Mon–Fri
09:00–12:00 and 14:00–18:00; weekends and statutory holidays are off-peak all
day). The shipped build prices everything at the peak table.

This patch:
  * records, for every usage sample, the tier its event time falls in
    (`routeTiers[route] = { peak, offpeak }` on each ledger record) — the log
    parser already carries per-sample event times, so backfilled history is
    tiered correctly too;
  * prices `officialCostSummary` per tier (off-peak = half the peak rate),
    reporting `peak` / `offpeak` / `legacy` parts and keeping `usd` / `cny` as
    the mixed total the client already renders;
  * adds `pricingTier: auto|peak|offpeak` and `holidayDates: string[]` config.
"""
FILE = r"C:\Users\Administrator\.dsh\plugins\dsh-token-usage\lib\index.js"
source = open(FILE, encoding="utf-8").read()
original = source


def replace_once(old, new, label):
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"anchor {label!r} matched {count} times, expected 1")
    source = source.replace(old, new)


# ---------------------------------------------------------------- helpers
HELPERS = r'''
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

/** Price one bucket record against one rate row (USD). */
function priceBuckets(buckets, rate) {
  const cacheRead = Number(buckets?.cacheReadTokens) || 0;
  const input = (Number(buckets?.uncachedInputTokens) || 0) + (Number(buckets?.cacheWriteTokens) || 0);
  const output = Number(buckets?.outputTokens) || 0;
  return (cacheRead / 1e6) * rate.cacheRead + (input / 1e6) * rate.input + (output / 1e6) * rate.output;
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

'''

replace_once(
    "/** Sum a `route -> buckets` map into one bucket record. */",
    HELPERS + "/** Sum a `route -> buckets` map into one bucket record. */",
    "pricing helpers",
)

# ---------------------------------------------------------------- config
replace_once(
    """  backupRoots: z.array(z.string()).default([]),
});""",
    """  backupRoots: z.array(z.string()).default([]),
  // Official cost tier: 'auto' splits every sample by the Beijing-time peak
  // windows (off-peak is half price), 'peak'/'offpeak' force one tier.
  pricingTier: z.string().default('auto'),
  // Extra Beijing dates (YYYY-MM-DD) billed as off-peak regardless of weekday.
  holidayDates: z.array(z.string()).default([]),
});""",
    "config",
)

# ---------------------------------------------------------------- ledger plumbing
replace_once(
    "  constructor(ctx, root, { flushIntervalMs = 2000, decodeCapBytes = 32 * 1024 * 1024, onSaved, tzOffsetMinutes = 0 } = {}) {",
    "  constructor(ctx, root, { flushIntervalMs = 2000, decodeCapBytes = 32 * 1024 * 1024, onSaved, tzOffsetMinutes = 0, resolveTier } = {}) {",
    "ledger constructor signature",
)
replace_once(
    "    this.backfilled = false;\n  }",
    "    this.backfilled = false;\n"
    "    // Which price tier one sample belongs to; the service owns the policy.\n"
    "    this.resolveTier = typeof resolveTier === 'function' ? resolveTier : () => 'peak';\n  }",
    "ledger constructor body",
)
replace_once(
    """            totals: sumRoutes(routes),
            routes,
          };""",
    """            totals: sumRoutes(routes),
            routes,
            routeTiers: normalizeRouteTiers(item.routeTiers),
          };""",
    "manifest load",
)
replace_once(
    """    if (record.dayRequests === undefined) record.dayRequests = {};
    if (upToSeq !== undefined)""",
    """    if (record.dayRequests === undefined) record.dayRequests = {};
    if (record.routeTiers === undefined) record.routeTiers = {};
    if (upToSeq !== undefined)""",
    "apply init",
)
replace_once(
    """      const day = dayKey(time, this.tzOffsetMinutes);
      record.days[day] = addBuckets(record.days[day] ?? zeroBuckets(), buckets);""",
    """      const day = dayKey(time, this.tzOffsetMinutes);
      record.days[day] = addBuckets(record.days[day] ?? zeroBuckets(), buckets);
      // Peak/off-peak accounting: keep one bucket pair per route so the cost
      // view can price each tier at its own list price.
      const tier = this.resolveTier(time);
      const tierSlot = record.routeTiers[route]
        ?? (record.routeTiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      tierSlot[tier] = addBuckets(tierSlot[tier], buckets);""",
    "apply tier buckets",
)

# ---------------------------------------------------------------- aggregate
replace_once(
    """  const global = emptyTotals();
  const byDay = new Map();
  const byRoute = new Map();""",
    """  const global = emptyTotals();
  const byDay = new Map();
  const byRoute = new Map();
  const routeTiers = {};""",
    "aggregate locals",
)
replace_once(
    """    const totals = sumRoutes(routes);
    global.uncachedInputTokens += totals.uncachedInputTokens;""",
    """    const totals = sumRoutes(routes);
    for (const [tierRoute, split] of Object.entries(record.routeTiers ?? {})) {
      const slot = routeTiers[tierRoute] ?? (routeTiers[tierRoute] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      slot.peak = addBuckets(slot.peak, split.peak ?? zeroBuckets());
      slot.offpeak = addBuckets(slot.offpeak, split.offpeak ?? zeroBuckets());
    }
    global.uncachedInputTokens += totals.uncachedInputTokens;""",
    "aggregate tiers",
)
replace_once(
    """    routes: [...byRoute.entries()].map(([route, row]) => ({ route, ...decorate(row) })).sort((a, b) => b.totalTokens - a.totalTokens),
    sessions,""",
    """    routes: [...byRoute.entries()].map(([route, row]) => ({ route, ...decorate(row) })).sort((a, b) => b.totalTokens - a.totalTokens),
    routeTiers,
    sessions,""",
    "aggregate return",
)

# ---------------------------------------------------------------- cost summary
start = source.index("  officialCostSummary(agg) {")
end = source.index("  /** Credit cost for every route that has an observed WorkBuddy price. */")
NEW_SUMMARY = '''  /**
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
      const rate = OFFICIAL_DEEPSEEK_RATES[model];
      if (rate === undefined) continue;
      const all = bucketsOf(route);
      const routeTokens = Number(route.totalTokens) || totalsOfBuckets(all);
      let peakUsd = 0;
      let offpeakUsd = 0;
      let legacyUsd = 0;
      if (mode === 'peak') {
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

'''
source = source[:start] + NEW_SUMMARY + source[end:]

# `totalsOfBuckets` helper next to priceBuckets.
replace_once(
    "/** Normalize a stored per-route tier split; malformed entries are dropped. */",
    "/** Total tokens of one bucket record. */\n"
    "function totalsOfBuckets(buckets) {\n"
    "  return (Number(buckets?.cacheReadTokens) || 0)\n"
    "    + (Number(buckets?.uncachedInputTokens) || 0)\n"
    "    + (Number(buckets?.cacheWriteTokens) || 0)\n"
    "    + (Number(buckets?.outputTokens) || 0);\n"
    "}\n\n"
    "/** Normalize a stored per-route tier split; malformed entries are dropped. */",
    "totalsOfBuckets helper",
)

# ---------------------------------------------------------------- service wiring
replace_once(
    """    this.ledger = new TokenLedger(ctx, this.root, {
      flushIntervalMs: config.flushIntervalMs,
      decodeCapBytes: config.decodeCapBytes,
      tzOffsetMinutes: this.tzOffsetMinutes,
      onSaved: () => this.writeMirrors(),
    });""",
    """    this.pricingTier = ['auto', 'peak', 'offpeak'].includes(config.pricingTier)
      ? config.pricingTier
      : 'auto';
    this.holidaySet = new Set(Array.isArray(config.holidayDates) ? config.holidayDates : []);
    this.ledger = new TokenLedger(ctx, this.root, {
      flushIntervalMs: config.flushIntervalMs,
      decodeCapBytes: config.decodeCapBytes,
      tzOffsetMinutes: this.tzOffsetMinutes,
      onSaved: () => this.writeMirrors(),
      resolveTier: (epochMs) => (this.pricingTier === 'auto'
        ? pricingTierOf(epochMs, this.holidaySet)
        : this.pricingTier),
    });""",
    "service tier wiring",
)

open(FILE, "w", encoding="utf-8", newline="\n").write(source)
print("patched", len(original), "->", len(source), "bytes")
