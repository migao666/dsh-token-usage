# 本地补丁说明（dsh-token-usage 0.2.0）

本目录不是未改动的发行包。安装到本机时做了四处本地修复，升级/重装插件后需要重新应用。

## 1. `workbuddyStatePath` 自动探测（Host 半，`lib/index.js`）

**问题**：0.2.0 只认显式配置的 `workbuddyStatePath`，默认空字符串 → `loadCostRates()`
直接返回空费率表 → 「积分」卡永远显示 `--`。README 里写的示例路径
`C:\wb-deploy\workbuddy2api\data\state.json` 在本机不存在（实际在
`D:\ls\docker\wb-deploy\workbuddy2api\data\state.json`）。

**改动**（`lib/index.js`，加了 `// --- WorkBuddy gateway state: automatic discovery`
区块）：

- `workbuddyStatePath` 留空时自动探测，顺序：环境变量
  `WORKBUDDY_STATE_PATH` / `WORKBUDDY2API_STATE` / `WB_STATE_PATH` → 各已挂载盘根下的
  常见布局（`wb-deploy/workbuddy2api/data/state.json`、`workbuddy2api/data/state.json`、
  `docker/wb-deploy/...`）→ 每个盘一次有界 BFS（找名为 `workbuddy2api` 的目录，深度 4、
  每盘 500 个目录预算，跳过 `node_modules`/`Windows`/`Program Files` 等）。
- 候选必须解析出 `accounts[*].model_costs` 才采用，避免误认无关的 `state.json`。
- 探测结果 memo 化，但每次使用前重新校验；文件消失或网关后启动会重新探测。
- 新增 `refreshCostRates()`：`snapshot()` 每次最多每 30 秒检查一次源文件的 mtime，
  网关改了费率会自动重读（此前只在插件加载时读一次）。
- `costs.workbuddy` 新增 `source: 'config' | 'auto' | 'none'`，`sourcePath` 仍是实际读取的文件。

**验证**（本机，插件热重载后）：

```json
{
  "configured": true,
  "source": "auto",
  "sourcePath": "D:\\ls\\docker\\wb-deploy\\workbuddy2api\\data\\state.json",
  "credits": 46.41,
  "coverage": 1
}
```

## 2. 官方价高峰 / 空闲自动分档（Host 半，`lib/index.js`）

**问题**：0.2.0 只按「高峰价」计价，而 DeepSeek 在北京时间周一至周五
09:00–12:00、14:00–18:00 之外（含周末与法定节假日）一律半价 → 空闲时段金额虚高
最多 2 倍。

**改动**：

- `pricingTierOf(epochMs, holidays)`：按北京时间判档（周末 / `holidayDates` 全天空闲）。
- 账本每个样本按事件时间写入 `routeTiers[route] = { peak, offpeak }`；日志回放本来
  就带每条事件的 `time`，所以冷数据也能正确分档。
- `officialCostSummary` 按档计价（空闲 = 高峰价 × 0.5），`costs.official` 新增
  `peak / offpeak / legacy` 三段（`usd`、`cny`、`tokens`）与 `tier` 模式；
  `usd` / `cny` 仍是分档混合后的总额，客户端无需改动。
- 新增配置：`pricingTier: auto|peak|offpeak`（默认 auto）、
  `holidayDates: ['YYYY-MM-DD', …]`（额外的北京时间节假日）。

**历史数据**：`retierFromLogs()` 在启动时对「没有分档或分档不完整」的记录回放会话
日志，按事件时间补齐分档（回放总量与记录总量不一致时放弃，不猜）。日志已被删除的
会话没有时间信息，留在 `legacy` 段按高峰价计，界面与数据里都能看出这部分。

**验证**：09:00–11:59 / 14:00–17:59 判 `peak`，12:00 / 13:00 / 18:00 与周末判
`offpeak`；`pricingTier: 'peak'` 时同一份用量金额正好翻倍（实测 0.5952 → 1.1977 USD）。
本机 2026-10-24 是周六，87M tokens 全部落 `offpeak`，人民币从「全按高峰」的
¥8.6 降到 ¥4.3（汇率回退 7.2 时）。

## 3. 历史表格按行显示费用（Host + Client 半）

**需求**：`按天 / 按模型 / 按会话` 三个表各加一列「费用」，粒度分别是一天、一个模型、一个会话。

**改动**：

- 账本新增 `dayRoutes[day][route] = { peak, offpeak }`（`apply()` 与 `retierFromLogs()` 都写）；
  已有记录若缺这张表，启动迁移会按日志补齐（分档与按天表的 token 覆盖都必须够，否则重算）。
- `dashboard()` 聚合后调用 `attachRowCosts(agg)`，给 `days[] / routes[] / sessions[]` 每行挂
  `cost = { usd, cny, credits }`：金额按官方价分档（空闲半价、未分档按高峰），积分按网关
  `cost_per_1k`；没有对应费率的行是 `null`，不编造。按天行只覆盖部分 token 时按已计价占比
  缩放，不会凭空放大。
- 客户端三个表末尾加「费用（单位）」列，单位跟随顶部 `积分 / 人民币 / 美元` 切换，空值显示 `--`。

**验证**：按天 ¥4.99 ≈ 全局 ¥4.99；各会话 3.70 + 0.30 + 0.50 + 0.49 ≈ 4.99；`routes` 行与
全局一致。客户端 bundle 已确认包含新列（刷新页面即生效）。

## 4. 法定节假日从 API 拉取（Host 半 + 配置）

**改动**：

- 新增配置 `holidayApiUrl`（默认 `https://timor.tech/api/holiday/year/{year}`，`{year}` 按年替换；
  空字符串 = 关闭）。
- 启动时 `loadHolidays()` 先读缓存 `<root>/holidays.json`，再对缺失/超过 7 天的年份调 API；
  只取 `holiday: true`（法定休息日）的 `date`，调休补班（`holiday: false`）仍按星期规则
  （与官方“周一至周五除法定节假日”的表述一致）。
- 节假日集合在 `ledger.load()` / 回放 / 重新分档之前就绪，所以当天样本能正确落 `offpeak`。
- 配置里的 `holidayDates` 继续叠加生效（离线兜底）；本机已内置 2026 年 33 个法定休息日。
- 缓存写失败、API 不可达都只告警，不影响计价（退回已缓存年份 + 手工列表）。

**验证**：2026-10-05（周一，国庆）→ offpeak；2026-10-12（周一，普通）10:00 → peak、20:00 → offpeak；
春节/端午/中秋日期 → offpeak；调休补班周六（2026-10-10）→ offpeak（周末规则）。
本机缓存 `~/.dsh/token-usage/holidays.json`：2026 年 33 天（01-01 … 10-07）。

**边界**：已经分档完成的历史记录不会因为节假日数据后到而自动重算；需要精确重算时删除
`~/.dsh/token-usage/manifest.json` 让插件按日志重建（会丢掉日志已删会话的记录）。

## 5. 面板「检查更新」与自更新（Host + Client 半）

- Host 新增 `GET /dsh-token-usage/api/update`（比较版本）与 `POST`（下载并安装），
  通过 PowerShell `-EncodedCommand` 调 GitHub API（自动走系统代理；`updateToken` 经环境变量传入，
  不落命令行）。GitHub 404/401 会转成「私有仓库需要 updateToken / 改为公开」的提示。
- 安装流程：下载 Release 资产 → `Expand-Archive` → 校验包名 → 备份现有文件到
  `~/.dsh/plugins/.update-backup-<旧版本>-<时间>`（保留 `node_modules`）→ 覆盖 → 提示重启。
- 快照 `meta` 增加 `version`；客户端标题栏下方新增「检查更新 / 安装更新」那一行。
- 新增配置 `updateRepo`（默认 `migao666/dsh-token-usage`）、`updateToken`（私有仓库需要）。

**验证**：Release v0.2.2 存在时，把本地版本临时改成 0.2.1 → 接口返回 `newer: true`；
POST 后 `applied: true`、版本变为 0.2.2、生成备份目录；无 token 访问私有仓库时返回
可读的 404 提示。

## 6. `schemastery` peer 依赖（安装层）

包只把 `schemastery` 声明为 `peerDependencies`，而本机 profile 的
`pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，`file:` link 安装不会补 peer →
插件激活报 `ERR_MODULE_NOT_FOUND: Cannot find package 'schemastery'`。

修法：在插件目录里装了 `schemastery@3.18.0`（`node_modules/`，`package.json` 保持出厂形态）。
换机器时要么同样 `pnpm add schemastery@3.18.0`，要么把 `schemastery` 挪进
`dependencies` 再分发。

## 回滚 / 重装

- 原始 Host 包：`lib/index.js.orig-0.2.0`，直接覆盖 `lib/index.js` 即回滚。
- 重装同版本 zip 后：用 `patch_token_usage_autodiscovery.py`（同目录）从
  `lib/index.js.orig-0.2.0` 重新生成补丁后的文件；再执行一次
  `pluginManager.setPluginEnabled('include:token-usage', false/true)` 让 Host 重新加载。
- 只想临时指定路径时，不必打补丁：在 profile 的 `cordis.patch.yml` 里覆盖
  `workbuddyStatePath` 即可（显式配置优先级最高）。

- 重打顺序：patch_token_usage_autodiscovery.py → patch_token_usage_pricing_tiers.py → patch_token_usage_retier.py → patch_token_usage_retier2.py（都从 lib/index.js.orig-0.2.0 起步、依次叠加）。
- 分档算错时可以删除 ~/.dsh/token-usage/manifest.json 让插件按日志重建账本；这会丢掉日志已被删除的会话记录，谨慎。

- 重打顺序（都从 `lib/index.js.orig-0.2.0` / `lib/client.js.orig-0.2.0` 起步、依次叠加）：autodiscovery → pricing_tiers → retier → retier2 → row_costs → retier3 → retier4 → client_cost_column。
