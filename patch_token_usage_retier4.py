"""Patch 6: the day-map completeness check must compare token coverage, not keys.

Patch 5 treated "dayRoutes is non-empty" as complete. A record whose live
samples created a small dayRoutes map before the log replay skipped migration,
leaving most of its tokens unpriced per day. Require the day map's tokens to
cover the record's stored accounting instead.
"""
FILE = r"C:\Users\Administrator\.dsh\plugins\dsh-token-usage\lib\index.js"
source = open(FILE, encoding="utf-8").read()

OLD = """    // Complete enough already: the tier split covers the stored accounting and
    // the per-day map exists (the history table prices one row per day).
    const hasDayRoutes = Object.keys(record.dayRoutes ?? {}).length > 0;
    if (stored === 0 || (seen >= stored * 0.999 && hasDayRoutes)) continue;"""
NEW = """    // Complete enough already: the tier split covers the stored accounting and
    // so does the per-day map (the history table prices one row per day).
    let dayTokens = 0;
    for (const routes of Object.values(record.dayRoutes ?? {})) {
      for (const tiers of Object.values(routes ?? {})) {
        dayTokens += totalsOfBuckets(tiers?.peak) + totalsOfBuckets(tiers?.offpeak);
      }
    }
    if (stored === 0 || (seen >= stored * 0.999 && dayTokens >= stored * 0.999)) continue;"""

if source.count(OLD) != 1:
    raise SystemExit(f"anchor matched {source.count(OLD)} times")
open(FILE, "w", encoding="utf-8", newline="\n").write(source.replace(OLD, NEW))
print("patched")
