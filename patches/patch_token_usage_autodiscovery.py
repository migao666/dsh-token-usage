"""Patch dsh-token-usage's host bundle: auto-discover the WorkBuddy gateway state.

The shipped 0.2.0 build only reads `workbuddyStatePath` and defaults it to '',
so the 积分 view stays empty unless the path is configured by hand. This patch
keeps that config as an explicit override and adds discovery when it is empty:

  WORKBUDDY_STATE_PATH / WORKBUDDY2API_STATE / WB_STATE_PATH
    -> known gateway layouts directly under any drive root
    -> a bounded, name-targeted scan for a `workbuddy2api` directory

Every candidate is validated by parsing it and requiring
`accounts[*].model_costs`, so an unrelated state.json is never picked up.
Discovery also re-runs when the discovered file disappears, and the rates are
re-read when the file changes (throttled to once per 30 s).
"""
FILE = r"C:\Users\Administrator\.dsh\plugins\dsh-token-usage\lib\index.js"
ORIGINAL = r"C:\Users\Administrator\.dsh\plugins\dsh-token-usage\lib\index.js.orig-0.2.0"

source = open(ORIGINAL, encoding="utf-8").read()
original = source

DISCOVERY = r'''
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
'''


def replace_once(old, new, label):
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"anchor {label!r} matched {count} times, expected 1")
    source = source.replace(old, new)


replace_once(
    "import { existsSync, readFileSync } from 'node:fs';",
    "import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';",
    "node:fs import",
)
replace_once(
    "import z from 'schemastery';",
    "import z from 'schemastery';\n" + DISCOVERY,
    "schemastery import",
)
replace_once(
    "    this.workbuddyStatePath = typeof config.workbuddyStatePath === 'string' ? config.workbuddyStatePath : '';",
    "    this.workbuddyStatePath = typeof config.workbuddyStatePath === 'string' ? config.workbuddyStatePath : '';\n"
    "    // 'config' when the path came from config, 'auto' when it was discovered,\n"
    "    // 'none' when neither produced a usable ledger.\n"
    "    this.costSource = this.workbuddyStatePath === '' ? 'none' : 'config';\n"
    "    this.costSourcePath = this.workbuddyStatePath;\n"
    "    this.costSourceStamp = 0;\n"
    "    this.costsCheckedAt = 0;",
    "constructor",
)
replace_once(
    """    this.costsLoaded = true;
    const path = this.workbuddyStatePath;
    if (!path || !existsSync(path)) {
      this.costRates = {};
      this.costSourcePath = '';
      return;
    }""",
    """    this.costsLoaded = true;
    const configured = this.workbuddyStatePath;
    const path = configured === '' ? discoverWorkbuddyStatePath() : configured;
    this.costSource = configured === '' ? (path === '' ? 'none' : 'auto') : 'config';
    if (!path || !existsSync(path)) {
      this.costRates = {};
      this.costSourcePath = '';
      this.costSourceStamp = 0;
      this.costsCheckedAt = Date.now();
      return;
    }""",
    "loadCostRates head",
)
replace_once(
    """      this.costRates = rates;
      this.costSourcePath = path;""",
    """      this.costRates = rates;
      this.costSourcePath = path;
      this.costSourceStamp = workbuddyStateStamp(path);
      this.costsCheckedAt = Date.now();""",
    "loadCostRates success",
)
replace_once(
    """    await this.ledger.load();
    if (!this.costsLoaded) await this.loadCostRates();
    return this.dashboard();""",
    """    await this.ledger.load();
    if (!this.costsLoaded) await this.loadCostRates();
    else await this.refreshCostRates();
    return this.dashboard();""",
    "snapshot",
)
replace_once(
    """  /** DeepSeek official list-price cost for the routes that have a public rate. */""",
    """  /**
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

  /** DeepSeek official list-price cost for the routes that have a public rate. */""",
    "refreshCostRates",
)
replace_once(
    """    const workbuddy = {
      configured,
      unit: 'credits',""",
    """    const workbuddy = {
      configured,
      source: this.costSource ?? 'none',
      unit: 'credits',""",
    "costSummary",
)

open(FILE, "w", encoding="utf-8", newline="\n").write(source)
print("patched", len(original), "->", len(source), "bytes")
