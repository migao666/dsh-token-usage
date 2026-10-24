"""Patch 3: let the tier migration complete partially tiered records.

Patch 2 only tiered records that had *no* tier split yet. A record that already
carried a few post-patch samples kept its large pre-patch remainder in `legacy`
forever. The migration now runs for any record whose tier split covers less than
its stored totals, and replaces the split with the log-derived one (the log
covers the same samples; agreement is still checked first).
"""
FILE = r"C:\Users\Administrator\.dsh\plugins\dsh-token-usage\lib\index.js"
source = open(FILE, encoding="utf-8").read()
original = source

OLD = """  const pending = new Map();
  for (const record of ledger.records.values()) {
    let seen = 0;
    for (const split of Object.values(record.routeTiers ?? {})) {
      seen += totalsOfBuckets(split.peak) + totalsOfBuckets(split.offpeak);
    }
    if (seen > 0) continue;
    pending.set(canonicalSessionId(record.sessionId), record);
  }"""

NEW = """  const pending = new Map();
  for (const record of ledger.records.values()) {
    let stored = 0;
    let seen = 0;
    for (const buckets of Object.values(record.routes ?? {})) stored += totalsOfBuckets(buckets);
    for (const split of Object.values(record.routeTiers ?? {})) {
      seen += totalsOfBuckets(split.peak) + totalsOfBuckets(split.offpeak);
    }
    // Complete enough already: the tier split covers the stored accounting.
    if (stored === 0 || seen >= stored * 0.999) continue;
    pending.set(canonicalSessionId(record.sessionId), record);
  }"""

if source.count(OLD) != 1:
    raise SystemExit(f"selection anchor matched {source.count(OLD)} times")
source = source.replace(OLD, NEW)

open(FILE, "w", encoding="utf-8", newline="\n").write(source)
print("patched", len(original), "->", len(source), "bytes")
