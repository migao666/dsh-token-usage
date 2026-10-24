"""Patch 7 (client half): add a 费用 column to the day/model/session tables.

The host now attaches `row.cost = { usd, cny, credits }` to every row; this adds
one trailing column to each of the three history tables and renders the row in
the unit the cost switch is showing (积分 / 人民币 / 美元), `--` when no rate
covers that row.
"""
FILE = r"C:\Users\Administrator\.dsh\plugins\dsh-token-usage\lib\client.js"
source = open(FILE, encoding="utf-8").read()
original = source


def replace_once(old, new, label):
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"anchor {label!r} matched {count} times, expected 1")
    source = source.replace(old, new)


# 1. row formatter, defined next to the other cost helpers of the modal.
replace_once(
    """    var body;
    if (!data) {""",
    """    var costUnit = costMode === 'cny' ? '¥' : (costMode === 'usd' ? '$' : '积分');
    /** Render one row cost in the unit the cost switch is showing. */
    function rowCost(cost) {
      if (!cost) return '--';
      if (costMode === 'cny') return cost.cny === null || cost.cny === undefined ? '--' : moneyText(cost.cny, '¥');
      if (costMode === 'usd') return cost.usd === null || cost.usd === undefined ? '--' : moneyText(cost.usd, '$');
      return cost.credits === null || cost.credits === undefined ? '--' : creditsText(cost.credits);
    }

    var body;
    if (!data) {""",
    "rowCost helper",
)

# 2. models table: header + cell.
replace_once(
    """            h('th', { className: 'tsl-bar-cell' }, '占总 Token'),
            h('th', { className: 'tsl-r' }, '占比'))),""",
    """            h('th', { className: 'tsl-bar-cell' }, '占总 Token'),
            h('th', { className: 'tsl-r' }, '占比'),
            h('th', { className: 'tsl-r' }, '费用（' + costUnit + '）'))),""",
    "models header",
)
replace_once(
    """              h('td', { className: 'tsl-r' }, percent(share)));""",
    """              h('td', { className: 'tsl-r' }, percent(share)),
              h('td', { className: 'tsl-r' }, rowCost(r.cost)));""",
    "models cell",
)

# 3. sessions table: header + cell.
replace_once(
    """            h('th', { className: 'tsl-r' }, '请求'),
            h('th', null, '最近活动'))),""",
    """            h('th', { className: 'tsl-r' }, '请求'),
            h('th', null, '最近活动'),
            h('th', { className: 'tsl-r' }, '费用（' + costUnit + '）'))),""",
    "sessions header",
)
replace_once(
    """              h('td', { className: 'tsl-muted' }, when(s.lastActivity || s.createdAt)));""",
    """              h('td', { className: 'tsl-muted' }, when(s.lastActivity || s.createdAt)),
              h('td', { className: 'tsl-r' }, rowCost(s.cost)));""",
    "sessions cell",
)

# 4. days table: header + cell.
replace_once(
    """            h('th', { className: 'tsl-r' }, '输出'),
            h('th', { className: 'tsl-r' }, '缓存命中率'))),""",
    """            h('th', { className: 'tsl-r' }, '输出'),
            h('th', { className: 'tsl-r' }, '缓存命中率'),
            h('th', { className: 'tsl-r' }, '费用（' + costUnit + '）'))),""",
    "days header",
)
replace_once(
    """              h('td', { className: 'tsl-r' }, h('span', { className: 'tsl-pill' + ((Number(d.cacheHitRate) || 0) < 0.8 ? ' tsl-pill-warn' : '') }, percent(d.cacheHitRate))));""",
    """              h('td', { className: 'tsl-r' }, h('span', { className: 'tsl-pill' + ((Number(d.cacheHitRate) || 0) < 0.8 ? ' tsl-pill-warn' : '') }, percent(d.cacheHitRate))),
              h('td', { className: 'tsl-r' }, rowCost(d.cost)));""",
    "days cell",
)

open(FILE, "w", encoding="utf-8", newline="\n").write(source)
print("patched", len(original), "->", len(source), "bytes")
