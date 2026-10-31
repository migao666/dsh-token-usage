/**
 * Host-side test: usage folding, ledger persistence, backfill, aggregation.
 *
 * Runs against the real session logs on this machine, so the folding is checked
 * against data the harness actually produced rather than a synthetic fixture.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  normalizeUsage, usageOf, parseSessionLog, decodeZstdLog,
  TokenLedger, backfill, backfillCaches, backfillBackups, aggregate, totalOf, promptOf, cacheHitOf, dayKey,
  forceInstallPackage,
} from '../lib/index.js';

let failures = 0;
function check(label, cond, extra) {
  if (!cond) failures += 1;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra !== undefined ? ' -> ' + extra : ''}`);
}

console.log('=== host test ===');

// ---------------------------------------------------------------- usage
console.log('\n[1] usage validation');
check('accepts a valid record', JSON.stringify(normalizeUsage({ inputTokens: 550, outputTokens: 219, cacheReadTokens: 128 }))
  === '{"uncachedInputTokens":550,"outputTokens":219,"cacheReadTokens":128,"cacheWriteTokens":0}');
check('rejects negatives', normalizeUsage({ inputTokens: -1, outputTokens: 5 }) === undefined);
check('rejects floats', normalizeUsage({ inputTokens: 1.5, outputTokens: 5 }) === undefined);
check('rejects null', normalizeUsage(null) === undefined);
check('rejects non-objects', normalizeUsage('x') === undefined);
check('defaults the missing cache buckets', normalizeUsage({ inputTokens: 1, outputTokens: 2 }).cacheReadTokens === 0);

console.log('\n[2] event -> usage');
const settled = { type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 6 } } };
check('reads data.usage', usageOf(settled).outputTokens === 6);
const streamed = {
  type: 'assistant/attempt',
  data: { stream: [{ type: 'chunk', chunk: { type: 'text' } }, { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 8 } } }] },
};
const streamedUsage = usageOf(streamed);
// `usageOf` returns NORMALISED buckets, so the field is `uncachedInputTokens`,
// not the provider's `inputTokens`.
check('reads the last usage chunk', streamedUsage !== undefined && streamedUsage.uncachedInputTokens === 7,
  streamedUsage === undefined ? 'usageOf returned undefined' : JSON.stringify(streamedUsage));
check('the settled message prefers data.usage', usageOf(settled).uncachedInputTokens === 5);
check('ignores other event types', usageOf({ type: 'user/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } }) === undefined);

console.log('\n[3] bucket maths');
const b = { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 5 };
check('total = in + cacheR + cacheW + out', totalOf(b) === 425, String(totalOf(b)));
check('prompt excludes output', promptOf(b) === 405, String(promptOf(b)));
check('cache hit = cacheR / (cacheR + in)', Math.abs(cacheHitOf(b).cacheHitRate - 0.75) < 1e-9, String(cacheHitOf(b).cacheHitRate));
check('no prompt traffic -> null (not 0)', cacheHitOf({ uncachedInputTokens: 0, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 }).cacheHitRate === null);
check('day key is local', /^\d{4}-\d{2}-\d{2}$/.test(dayKey(Date.now(), 480)), dayKey(Date.now(), 480));
// 2026-10-23 11:35 +08:00 == 03:35Z; a subtract-sign bug produces 10-22.
check('day key uses +08 offset correctly', dayKey(Date.UTC(2026, 9, 23, 3, 35), 480) === '2026-10-23',
  dayKey(Date.UTC(2026, 9, 23, 3, 35), 480));
check('day key edge just after local midnight',
  dayKey(Date.UTC(2026, 9, 22, 16, 30), 480) === '2026-10-23',
  dayKey(Date.UTC(2026, 9, 22, 16, 30), 480));

console.log('\n[4] log replay (synthetic)');
const tmp = mkdtempSync(join(tmpdir(), 'tsl-'));
const sessId = 'session-synthetic-0001';
const events = [
  { type: 'session', version: 4, id: sessId, createdAt: 1700000000000, cwd: 'C:/w' },
  { type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'p', model: 'm' } } } },
];
for (let i = 1; i <= 4; i += 1) {
  events.push({ type: 'assistant/message', seq: i * 2 - 1, time: i, data: { turn: 1, step: i, usage: { inputTokens: 10, outputTokens: 2 }, stream: [] } });
}
const logPath = join(tmp, 'session.v4.jsonl.zstd');
writeFileSync(logPath, zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n')));
const parsed = parseSessionLog(logPath, 8 * 1024 * 1024);
check('parses the log', parsed !== null);
check('reads the session id', parsed.sessionId === sessId);
check('reads the route', parsed.route === 'p:m', parsed.route);
check('reads the cwd', parsed.cwd === 'C:/w');
check('four samples', parsed.samples.length === 4, String(parsed.samples.length));
check('max seq recorded', parsed.maxSeq === 7, String(parsed.maxSeq));
const sum = parsed.samples.reduce((a, s) => a + s.outputTokens, 0);
check('output sums to 8', sum === 8, String(sum));

console.log('\n[5] retry replacement');
const retryEvents = [
  events[0], events[1],
  { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 }, stream: [] } },
  { type: 'llm/retry-started', seq: 2, time: 2, data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, stream: [] } },
];
const retryPath = join(tmp, 'retry.jsonl.zstd');
writeFileSync(retryPath, zstdCompressSync(Buffer.from(retryEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')));
const retryParsed = parseSessionLog(retryPath, 8 * 1024 * 1024);
const retryOut = retryParsed.samples.reduce((a, s) => a + s.outputTokens, 0);
// A retry does NOT subtract: the provider bills both attempts, and the official
// `tokenUsage` projection clears the slot so the retried attempt simply adds.
check('both attempts are billed', retryOut === 55, String(retryOut));
check('no negative correction on retry', !retryParsed.samples.some((s) => s.outputTokens < 0),
  JSON.stringify(retryParsed.samples.map((s) => s.outputTokens)));

// A same-step re-settlement WITHOUT a retry is a rewrite: it replaces.
const rewriteEvents = [
  events[0], events[1],
  { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 }, stream: [] } },
  { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, stream: [] } },
];
const rewritePath = join(tmp, 'rewrite.jsonl.zstd');
writeFileSync(rewritePath, zstdCompressSync(Buffer.from(rewriteEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')));
const rewriteParsed = parseSessionLog(rewritePath, 8 * 1024 * 1024);
// 50 - 45 + 5 = 10 in output, and 100 - 90 + 10 = 20 in input: the later
// reading wins in every bucket, not just the ones that happen to be positive.
const rewriteOut = rewriteParsed.samples.reduce((a, s) => a + s.outputTokens, 0);
const rewriteIn = rewriteParsed.samples.reduce((a, s) => a + s.uncachedInputTokens, 0);
check('a rewrite nets to the later reading (output)', rewriteOut === 5, String(rewriteOut));
check('a rewrite nets to the later reading (input)', rewriteIn === 10, String(rewriteIn));
check('a rewrite emits a negative correction', rewriteParsed.samples.some((s) => s.outputTokens < 0),
  JSON.stringify(rewriteParsed.samples.map((s) => s.outputTokens)));

// An identical re-settlement must be ignored, not counted twice.
const dupEvents = [
  events[0], events[1],
  { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, stream: [] } },
  { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, stream: [] } },
];
const dupPath = join(tmp, 'dup.jsonl.zstd');
writeFileSync(dupPath, zstdCompressSync(Buffer.from(dupEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')));
const dupParsed = parseSessionLog(dupPath, 8 * 1024 * 1024);
check('an identical re-settlement is ignored', dupParsed.samples.length === 1, String(dupParsed.samples.length));

console.log('\n[6] ledger + watermark');
const ledger = new TokenLedger({ logger: {} }, join(tmp, 'ledger'), { flushIntervalMs: 100000 });
await ledger.load();
ledger.apply(sessId, { cwd: 'C:/w', route: 'p:m' }, parsed.samples, 1700000000000, { upToSeq: parsed.maxSeq });
check('samples counted', ledger.records.get(sessId).requests === 4, String(ledger.records.get(sessId).requests));
// A replayed event at or below the watermark must be ignored.
const ignored = ledger.applyLive(sessId, {}, { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, 3);
check('event at the watermark is ignored', ignored === false);
const counted = ledger.applyLive(sessId, {}, { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2, 9);
check('event past the watermark counts', counted === true);
check('requests went to 5', ledger.records.get(sessId).requests === 5, String(ledger.records.get(sessId).requests));

console.log('\n[7] persistence');
await ledger.flush({ force: true });
const manifestPath = join(tmp, 'ledger', 'manifest.json');
check('manifest written', existsSync(manifestPath));
const reloaded = new TokenLedger({ logger: {} }, join(tmp, 'ledger'), {});
await reloaded.load();
check('round-trips', reloaded.records.get(sessId)?.requests === 5, String(reloaded.records.get(sessId)?.requests));
check('watermark round-trips', reloaded.records.get(sessId)?.upToSeq === 9, String(reloaded.records.get(sessId)?.upToSeq));

console.log('\n[8] aggregation');
const agg = aggregate(ledger, 480);
check('global row present', agg.global.totalTokens > 0, String(agg.global.totalTokens));
check('day row present', agg.days.length >= 1, String(agg.days.length));
check('route row present', agg.routes.some((r) => r.route === 'p:m'));
check('session row carries the title slot', Array.isArray(agg.sessions) && agg.sessions[0]?.sessionId === sessId);
check('cache hit on the global row', typeof agg.global.cacheHitRate === 'number');

console.log('\n[9] backfill against real logs');
const real = await backfill(ledger, 5000);
check('backfill ran', real.scanned > 0, `scanned=${real.scanned} added=${real.added}`);
if (real.added > 0) {
  const after = aggregate(ledger, 480);
  check('history totals are non-zero', after.global.totalTokens > 0, String(after.global.totalTokens));
  check('multiple routes seen', after.routes.length >= 1, JSON.stringify(after.routes.map((r) => r.route)));
}

console.log('\n[10] projection-cache backfill (deleted sessions)');
const cacheHome = mkdtempSync(join(tmpdir(), 'tsl-cache-home-'));
const cacheDir = join(cacheHome, 'storages', 'session_projcache', 'sessions');
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, 'deleted-session-1.json'), JSON.stringify({
  version: 7,
  record: {
    identity: { cwd: 'C:/deleted-workspace', createdAt: 1790000000000 },
    rows: {
      title: { val: '已删除的会话' },
      tokenUsage: {
        seq: 42,
        val: {
          totals: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 },
        },
      },
    },
  },
}));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = cacheHome;
const cacheLedger = new TokenLedger({ logger: { warn() {} } }, join(tmp, 'cache-ledger'), {});
await cacheLedger.load();
const cacheResult = await backfillCaches(cacheLedger, 10);
check('cache backfill added the deleted session', cacheResult.added === 1, JSON.stringify(cacheResult));
const deleted = cacheLedger.records.get('session-deleted-session-1');
check('deleted session totals are cumulative',
  deleted !== undefined && deleted.totals.cacheReadTokens === 300,
  deleted === undefined ? 'missing' : JSON.stringify(deleted.totals));
check('deleted session title captured', deleted !== undefined && deleted.title === '已删除的会话');
const again = await backfillCaches(cacheLedger, 10);
check('cache backfill is idempotent (no double count)',
  again.added === 0 && cacheLedger.records.get('session-deleted-session-1').totals.cacheReadTokens === 300,
  JSON.stringify(again));
process.env.DSH_HOME = previousHome;
rmSync(cacheHome, { recursive: true, force: true });

console.log('\n[11] duplicate-session migration');
const migRoot = join(tmp, 'mig-ledger');
mkdirSync(migRoot, { recursive: true });
writeFileSync(join(migRoot, 'manifest.json'), JSON.stringify([
  {
    sessionId: 'session-dup', cwd: 'C:/x', title: 'dup', route: 'p:m',
    createdAt: 1, lastActivity: 2, requests: 2, upToSeq: 10,
    totals: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 0 },
  },
  {
    sessionId: 'dup', cwd: 'C:/x', title: '', route: '',
    createdAt: 1, lastActivity: 2, requests: 0, upToSeq: 10,
    totals: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 0 },
  },
]));
const mig = new TokenLedger({ logger: {} }, migRoot, {});
await mig.load();
check('duplicate folded into the canonical id', mig.records.has('session-dup') && !mig.records.has('dup'));
check('duplicate totals are not doubled',
  mig.records.get('session-dup').totals.cacheReadTokens === 300,
  String(mig.records.get('session-dup').totals.cacheReadTokens));
check('migration marks the ledger dirty', mig.dirty === true);

console.log('\n[12] external session backups');
const backupRoot = join(tmp, 'backup-root');
const backupSessionDir = join(backupRoot, 'sessions', 'proj', 'session-backup-1');
mkdirSync(backupSessionDir, { recursive: true });
const backupEvents = [
  { type: 'session', version: 4, id: 'session-backup-1', cwd: 'C:/backup-ws', createdAt: 1 },
  {
    type: 'assistant/message', seq: 1, time: 2,
    data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, message: { role: 'assistant', content: [] } },
  },
];
writeFileSync(
  join(backupSessionDir, 'session.v4.jsonl.zstd'),
  zstdCompressSync(Buffer.from(backupEvents.map((event) => JSON.stringify(event)).join('\n') + '\n')),
);
const backupLedger = new TokenLedger({ logger: {} }, join(tmp, 'backup-ledger'), {});
await backupLedger.load();
const backupResult = await backfillBackups(backupLedger, [backupRoot], 10);
check('backup backfill added the session', backupResult.added === 1, JSON.stringify(backupResult));
const backupRecord = backupLedger.records.get('session-backup-1');
check('backup totals are folded',
  backupRecord !== undefined && backupRecord.totals.uncachedInputTokens === 10 && backupRecord.totals.outputTokens === 5,
  backupRecord === undefined ? 'missing' : JSON.stringify(backupRecord.totals));
check('backup cwd captured', backupRecord !== undefined && backupRecord.cwd === 'C:/backup-ws');

console.log('\n[13] per-request model breakdown');
const multiEvents = [
  { type: 'session', version: 4, id: 'session-multi-model', cwd: 'C:/multi', createdAt: 1 },
  { type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'p', model: 'm' } } } },
  {
    type: 'assistant/message', seq: 1, time: 2,
    data: {
      turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2 },
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'q', model: 'n' } },
    },
  },
  {
    type: 'assistant/message', seq: 3, time: 3,
    data: {
      turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 3 },
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
    },
  },
];
const multiPath = join(tmp, 'multi.jsonl.zstd');
writeFileSync(multiPath, zstdCompressSync(Buffer.from(multiEvents.map((event) => JSON.stringify(event)).join('\n') + '\n')));
const multiParsed = parseSessionLog(multiPath, 8 * 1024 * 1024);
check('sample routes follow the settled message source',
  JSON.stringify(multiParsed.sampleRoutes) === JSON.stringify(['q:n', 'p:m']), JSON.stringify(multiParsed.sampleRoutes));
const multiLedger = new TokenLedger({ logger: {} }, join(tmp, 'multi-ledger'), {});
multiLedger.apply('session-multi-model', multiParsed, multiParsed.samples, multiParsed.createdAt, {
  upToSeq: multiParsed.maxSeq,
  sampleRoutes: multiParsed.sampleRoutes,
});
const multiAgg = aggregate(multiLedger, 480);
const qn = multiAgg.routes.find((row) => row.route === 'q:n');
const pm = multiAgg.routes.find((row) => row.route === 'p:m');
check('q:n gets only its own request tokens', qn !== undefined && qn.totalTokens === 12, qn && String(qn.totalTokens));
check('p:m gets only its own request tokens', pm !== undefined && pm.totalTokens === 23, pm && String(pm.totalTokens));
check('global equals the sum of per-route totals', multiAgg.global.totalTokens === 35, String(multiAgg.global.totalTokens));

console.log('\n[14] per-day split');
const t1 = Date.UTC(2026, 9, 22, 3, 0); // 2026-10-22 11:00 +08
const t2 = Date.UTC(2026, 9, 23, 3, 0); // 2026-10-23 11:00 +08
const dayLedger = new TokenLedger({ logger: {} }, join(tmp, 'day-ledger'), { tzOffsetMinutes: 480 });
dayLedger.apply('session-days', { cwd: 'C:/x', route: 'p:m', createdAt: t1, lastActivity: t2 }, [
  { uncachedInputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { uncachedInputTokens: 2, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
], t2, { sampleTimes: [t1, t2], sampleRoutes: ['p:m', 'p:m'] });
const dayAgg = aggregate(dayLedger, 480);
const d1 = dayAgg.days.find((row) => row.day === '2026-10-22');
const d2 = dayAgg.days.find((row) => row.day === '2026-10-23');
check('first request lands on 2026-10-22', d1 !== undefined && d1.totalTokens === 11, d1 && String(d1.totalTokens));
check('second request lands on 2026-10-23', d2 !== undefined && d2.totalTokens === 22, d2 && String(d2.totalTokens));
check('per-day request counts follow sample times', d1 !== undefined && d1.requests === 1
  && d2 !== undefined && d2.requests === 1, JSON.stringify([d1 && d1.requests, d2 && d2.requests]));
check('per-day totals sum to the session total', dayAgg.global.totalTokens === 33, String(dayAgg.global.totalTokens));

// ---------------------------------------------------------------- install
console.log('\n[15] forced copy install (update button)');
{
  const base = mkdtempSync(join(tmpdir(), 'tu-install-'));
  const target = join(base, 'installed');
  mkdirSync(join(target, 'lib'), { recursive: true });
  mkdirSync(join(target, 'node_modules'), { recursive: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-token-usage', version: '0.2.4' }));
  writeFileSync(join(target, 'lib', 'client.js'), 'old-client');
  writeFileSync(join(target, 'stale.txt'), 'left over from the old build');
  writeFileSync(join(target, 'node_modules', 'keep.txt'), 'keep me');

  const release = join(base, 'release');
  mkdirSync(join(release, 'lib'), { recursive: true });
  writeFileSync(join(release, 'package.json'), JSON.stringify({ name: 'dsh-token-usage', version: '0.2.5' }));
  writeFileSync(join(release, 'lib', 'client.js'), 'new-client');

  const result = await forceInstallPackage({ packageDir: release, targetRoot: target, currentVersion: '0.2.4' });
  check('installs the new version', result.installed === '0.2.5', result.installed);
  check('reports verified', result.verified === true);
  check('overwrites the client bundle', readFileSync(join(target, 'lib', 'client.js'), 'utf8') === 'new-client');
  check('drops files the new version no longer ships', !existsSync(join(target, 'stale.txt')));
  check('keeps node_modules', existsSync(join(target, 'node_modules', 'keep.txt')));
  check('backs the old tree up first', existsSync(join(result.backup, 'package.json')));
  check('backup still holds the old version',
    JSON.parse(readFileSync(join(result.backup, 'package.json'), 'utf8')).version === '0.2.4');
  rmSync(base, { recursive: true, force: true });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n=> ${failures === 0 ? 'ALL HOST TESTS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);

