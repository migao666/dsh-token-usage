"""Patch 4: per-row cost (day / model / session) for the history tables.

Adds a tier-aware cost to every aggregate row:
  * `days[]`   -> priced from a new per-day, per-route, per-tier ledger map
  * `routes[]` -> priced from the existing per-route tier split
  * `sessions[]` -> priced from each record's per-route tier split
Credits (WorkBuddy gateway price) and money (DeepSeek official price) are both
attached as `row.cost = { usd, cny, credits }`, null where no rate covers the
row. Untiered leftovers are priced at the peak rate, and a row whose tokens are
only partly representable is scaled by the priced share (never invented).
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
replace_once(
    "/** Normalize a stored per-route tier split; malformed entries are dropped. */",
    """/** Normalize one `{ peak, offpeak }` tier pair. */
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

/** Normalize a stored per-route tier split; malformed entries are dropped. */""",
    "tier normalizers",
)

# ---------------------------------------------------------------- ledger: day routing
replace_once(
    """    if (record.routeTiers === undefined) record.routeTiers = {};""",
    """    if (record.routeTiers === undefined) record.routeTiers = {};
    if (record.dayRoutes === undefined) record.dayRoutes = {};""",
    "apply dayRoutes init",
)
replace_once(
    """      const tier = this.resolveTier(time);
      const tierSlot = record.routeTiers[route]
        ?? (record.routeTiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      tierSlot[tier] = addBuckets(tierSlot[tier], buckets);""",
    """      const tier = this.resolveTier(time);
      const tierSlot = record.routeTiers[route]
        ?? (record.routeTiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      tierSlot[tier] = addBuckets(tierSlot[tier], buckets);
      // Same split per day, so the history table can price one row per day.
      const dayRoutes = record.dayRoutes[day] ?? (record.dayRoutes[day] = {});
      const dayTier = dayRoutes[route]
        ?? (dayRoutes[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
      dayTier[tier] = addBuckets(dayTier[tier], buckets);""",
    "apply dayRoutes tracking",
)
replace_once(
    """            routeTiers: normalizeRouteTiers(item.routeTiers),
          };""",
    """            routeTiers: normalizeRouteTiers(item.routeTiers),
            dayRoutes: normalizeDayRoutes(item.dayRoutes),
          };""",
    "manifest load dayRoutes",
)
replace_once(
    """      record.routeTiers = tiers;
      ledger.dirty = true;""",
    """      record.routeTiers = tiers;
      record.dayRoutes = dayRoutes;
      ledger.dirty = true;""",
    "retier dayRoutes store",
)
replace_once(
    """      const parsed = parseSessionLog(logFile, ledger.decodeCap);
      if (parsed === null) continue;
      const fallbackAt = record.lastActivity || record.createdAt || Date.now();
      const tiers = {};""",
    """      const parsed = parseSessionLog(logFile, ledger.decodeCap);
      if (parsed === null) continue;
      const fallbackAt = record.lastActivity || record.createdAt || Date.now();
      const tiers = {};
      const dayRoutes = {};""",
    "retier dayRoutes locals",
)
replace_once(
    """        const tier = ledger.resolveTier(at);
        const slot = tiers[route] ?? (tiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
        slot[tier] = addBuckets(slot[tier], parsed.samples[index]);""",
    """        const tier = ledger.resolveTier(at);
        const slot = tiers[route] ?? (tiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
        slot[tier] = addBuckets(slot[tier], parsed.samples[index]);
        const day = dayKey(at, ledger.tzOffsetMinutes);
        const daySlot = dayRoutes[day] ?? (dayRoutes[day] = {});
        const dayTier = daySlot[route]
          ?? (daySlot[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
        dayTier[tier] = addBuckets(dayTier[tier], parsed.samples[index]);""",
    "retier dayRoutes fill",
)

# ---------------------------------------------------------------- service: per-row cost
replace_once(
    """  dashboard() {
    const agg = aggregate(this.ledger, this.tzOffsetMinutes);""",
    """  dashboard() {
    const agg = aggregate(this.ledger, this.tzOffsetMinutes);
    this.attachRowCosts(agg);""",
    "dashboard hook",
)

ROW_COST = '''  /**
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
      const rate = OFFICIAL_DEEPSEEK_RATES[model];
      if (rate === undefined) return undefined;
      const peakBuckets = tiers?.peak ?? zeroBuckets();
      const offpeakBuckets = tiers?.offpeak ?? zeroBuckets();
      const leftoverBuckets = leftover ?? zeroBuckets();
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

'''

replace_once(
    """  /**
   * DeepSeek official list-price cost, split by the tier each sample was recorded
   * in.""",
    ROW_COST + """  /**
   * DeepSeek official list-price cost, split by the tier each sample was recorded
   * in.""",
    "attachRowCosts method",
)

open(FILE, "w", encoding="utf-8", newline="\n").write(source)
print("patched", len(original), "->", len(source), "bytes")
