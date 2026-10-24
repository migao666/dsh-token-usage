"""Patch 8: pull China's statutory holiday schedule from an API into the tier rule.

`pricingTierOf` already treats configured `holidayDates` as off-peak all day.
This adds an API source so the plugin does not need a hand-maintained list:

  * `holidayApiUrl` (default the timor.tech per-year endpoint, `{year}` replaced)
  * on start, the cached `~/.dsh/token-usage/holidays.json` is loaded, and any
    year that is missing (or older than 7 days) is fetched and cached
  * the API's `holiday: true` entries are the statutory days off; "调休补班"
    entries (`holiday: false`) stay weekday-priced, matching DeepSeek's stated
    rule that only Mon-Fri outside statutory holidays is peak
  * configured `holidayDates` remain an offline fallback / manual override
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


# ---------------------------------------------------------------- config
replace_once(
    """  // Extra Beijing dates (YYYY-MM-DD) billed as off-peak regardless of weekday.
  holidayDates: z.array(z.string()).default([]),""",
    """  // Extra Beijing dates (YYYY-MM-DD) billed as off-peak regardless of weekday.
  // These are a manual override / offline fallback on top of the API schedule.
  holidayDates: z.array(z.string()).default([]),
  // China statutory-holiday schedule API; `{year}` is replaced per request.
  // Empty disables the API and leaves only `holidayDates` in effect.
  holidayApiUrl: z.string().default('https://timor.tech/api/holiday/year/{year}'),""",
    "config",
)

# ---------------------------------------------------------------- constructor
replace_once(
    """    this.holidaySet = new Set(Array.isArray(config.holidayDates) ? config.holidayDates : []);""",
    """    this.holidaySet = new Set(Array.isArray(config.holidayDates) ? config.holidayDates : []);
    // Statutory holidays pulled from the schedule API, cached on disk so an
    // offline start still prices holidays correctly.
    this.holidayApiUrl = typeof config.holidayApiUrl === 'string' ? config.holidayApiUrl : '';
    this.holidayCachePath = join(this.root, 'holidays.json');
    this.holidayYears = new Set();
    this.holidaysFetchedAt = 0;""",
    "constructor holidays",
)

# ---------------------------------------------------------------- start ordering
replace_once(
    """  async start() {
    await this.loadCostRates();
    this.startExchangeRateRefresh();
    await this.ledger.load();""",
    """  async start() {
    await this.loadCostRates();
    this.startExchangeRateRefresh();
    // Tiering reads the holiday set, so it must be ready before any replay.
    await this.loadHolidays();
    await this.ledger.load();""",
    "start holidays",
)

# ---------------------------------------------------------------- methods
HOLIDAYS = '''  /**
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

'''
replace_once(
    """  /**
   * Attach a cost to every day, model, and session row.""",
    HOLIDAYS + """  /**
   * Attach a cost to every day, model, and session row.""",
    "loadHolidays methods",
)

open(FILE, "w", encoding="utf-8", newline="\n").write(source)
print("patched", len(original), "->", len(source), "bytes")
