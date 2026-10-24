"""Patch 2 for dsh-token-usage: re-tier historical ledger rows from the session logs.

Samples recorded before the peak/off-peak split carry no tier, so they would be
priced at the peak rate forever. The logs do carry per-event timestamps, so a
one-time pass replays each log whose record has no tier split and derives the
split (`peak` / `offpeak`) for it. Records whose log has been deleted stay
`legacy` (peak-priced); a replay that disagrees with the stored totals is
ignored rather than trusted.
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


RETIER = '''/**
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
    let seen = 0;
    for (const split of Object.values(record.routeTiers ?? {})) {
      seen += totalsOfBuckets(split.peak) + totalsOfBuckets(split.offpeak);
    }
    if (seen > 0) continue;
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
        .find((file) => /session(\\.v\\d+)?\\.jsonl(\\.zstd)?$/.test(file));
      if (logFile === undefined) continue;
      const parsed = parseSessionLog(logFile, ledger.decodeCap);
      if (parsed === null) continue;
      const fallbackAt = record.lastActivity || record.createdAt || Date.now();
      const tiers = {};
      for (let index = 0; index < parsed.samples.length; index += 1) {
        const route = (typeof parsed.sampleRoutes?.[index] === 'string' && parsed.sampleRoutes[index] !== '')
          ? parsed.sampleRoutes[index]
          : (parsed.route || 'unknown');
        const at = Number(parsed.sampleTimes?.[index]) > 0 ? Number(parsed.sampleTimes[index]) : fallbackAt;
        const tier = ledger.resolveTier(at);
        const slot = tiers[route] ?? (tiers[route] = { peak: zeroBuckets(), offpeak: zeroBuckets() });
        slot[tier] = addBuckets(slot[tier], parsed.samples[index]);
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
      ledger.dirty = true;
      changed += 1;
    }
  }
  return changed;
}

'''

replace_once(
    "export async function backfillCaches(",
    RETIER + "export async function backfillCaches(",
    "retier helper",
)

replace_once(
    """    const added = logResult.added + cacheResult.added + backupResult.added;
    if (added > 0) {""",
    """    // Fourth source: the tier split for records written before it existed.
    const retiered = await retierFromLogs(this.ledger).catch((error) => {
      this.ctx.logger?.warn?.(`[${name}] tier migration failed: ${String(error)}`);
      return 0;
    });
    if (retiered > 0) {
      this.ctx.logger?.info?.(`[${name}] tiered ${retiered} historical session(s) from their logs`);
      await this.ledger.flush();
    }
    const added = logResult.added + cacheResult.added + backupResult.added;
    if (added > 0) {""",
    "start wiring",
)

open(FILE, "w", encoding="utf-8", newline="\n").write(source)
print("patched", len(original), "->", len(source), "bytes")
