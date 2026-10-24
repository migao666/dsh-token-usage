"""Patch 5: the tier migration must also run when only the per-day map is missing.

Patch 4 added `record.dayRoutes` (day -> route -> tier buckets) for the history
table's per-day cost. Records that were already fully tiered skipped the
migration, so their days had no cost. Treat a missing/empty `dayRoutes` map as
incomplete too.
"""
FILE = r"C:\Users\Administrator\.dsh\plugins\dsh-token-usage\lib\index.js"
source = open(FILE, encoding="utf-8").read()

OLD = """    // Complete enough already: the tier split covers the stored accounting.
    if (stored === 0 || seen >= stored * 0.999) continue;"""
NEW = """    // Complete enough already: the tier split covers the stored accounting and
    // the per-day map exists (the history table prices one row per day).
    const hasDayRoutes = Object.keys(record.dayRoutes ?? {}).length > 0;
    if (stored === 0 || (seen >= stored * 0.999 && hasDayRoutes)) continue;"""

if source.count(OLD) != 1:
    raise SystemExit(f"anchor matched {source.count(OLD)} times")
open(FILE, "w", encoding="utf-8", newline="\n").write(source.replace(OLD, NEW))
print("patched")
