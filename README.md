# Token用量（dsh-token-usage）

Token用量统计插件，为 DeepSeek Harness 记录**历史消耗**与**实时消耗**。

- **实时**：会话标题栏一个常驻读数，悬停展开面板 —— 累计 token、缓存命中率、输出速度、上下文占用。
- **历史**：面板里点「历史累计」打开弹窗 —— 顶部给出跨会话累计（含已删除/已归档会话），
  下面按天 / 按模型 / 按会话三个维度查看。面板/弹窗打开期间每 **2 秒**重读一次工作区镜像，
  关闭后停止轮询；Host 每 2 秒落盘并重写镜像。
- **按模型精确到每次请求**：每条 `assistant/message` 用它自己的 `source.provider:model` 归属，
  同一会话中途换模型会拆成多行；日志/缓存里无法归属的差额记到「未标注」，不伪造模型。


仓库（私有）：[https://github.com/migao666/dsh-token-usage](https://github.com/migao666/dsh-token-usage)
## 数据怎么来的

实时通道全部走官方；历史优先走官方 `workspaceFiles`，不可用时兜底同源 HTTP 快照。

| 数据 | 通道 | 说明 |
| --- | --- | --- |
| 实时累计 | `useProjection('tokenUsage')` | 框架注入的标准 prop，四个互斥桶 |
| 输出速度 / 首字延迟 | `useProjection('sessionStats')` | 官方折叠好的计时字段 |
| 上下文占用 | `useProjection('contextPressure')` | 提示词占用 / 路由容量 |
| 历史（跨会话） | `ctx.resources` + `workspaceFiles.read` | 本插件注册 `tokenusage` 资源协议，读取 `<workspace>/.dsh-token-usage.json` 镜像；不可用时兜底同源 `GET /dsh-token-usage/api/snapshot` |

**为什么不用自定义 Remote 命名空间**：浏览器端的官方 Remote assembly 只挂载它自己生成的命名空间，
第三方 Host Service 即使有 `typertRemote` 标记，也不会自动变成 `ctx.remote.xxx`；客户端会拿到
`undefined`，历史就显示不可用。因此历史改走**官方已挂载的 `workspaceFiles` 命名空间**：
Host 端把聚合结果镜像到当前工作区的 `.dsh-token-usage.json`，客户端用
`workspaceFiles.read(sessionId, '.dsh-token-usage.json', …)` 读回来。账本真源仍在
`~/.dsh/token-usage/manifest.json`，镜像只是给界面读的只读视图。

**历史传输优先级**：优先官方 `workspaceFiles.read` 读工作区镜像；拿不到时用
`ctx.inject(['webServer'])` 注册的同源 `GET /dsh-token-usage/api/snapshot` 兜底。
不能在 `apply()` 里用 `ctx.get('webServer')` 一次性判断——那时服务还没挂载，会永久跳过注册并落到 SPA 405。

## 指标口径

**缓存命中率** —— 分母是「这一路提示词一共被送进去多少 token」，分子是其中走缓存命中的部分：

```
cacheHitRate = cacheRead / (cacheRead + uncachedInput)
```

`outputTokens` 不参与（它不是提示词，谈不上命中）；`cacheWriteTokens` 也不进分母（那是写入花费，不是本次读取的规模）。

算不出来时（还没有任何缓存读）显示 `--` 而非 `0%`：0% 是一个断言，`--` 才是「不知道」。

**输出速度** = `decodeTokens / decodeMs`；**首字延迟** = `ttftMs / ttftSteps`；**模型耗时占比** = `llmMs / (llmMs + toolMs)`。三者都取自官方 `sessionStats`，插件只做除法；分子为 0 或分母缺失时显示 `--`。

**按天口径**：账本按每次 usage 的 `event.time` 落到本地日桶；日志/备份回放按每条 sample 的时间逐日拆分；
投影缓存-only 的差额落到该会话最后活动日。旧账本首次加载会先按 `lastActivity` 建一个兜底日，
再回扫日志/备份升级为逐日。日期键用「本地 UTC 偏移（中国 +480）**加**到 epoch」再取 UTC 日期；
早期写成减法，整体错移 16 小时，导致“今天”的数据落到昨天。

## 历史仪表盘

`历史累计` 弹窗按 AI Studio 参考稿重做，直接读 `snapshot()` 的真实聚合数据：

- 顶部 4 张统计卡：历史总 Token、全局缓存命中率、累计费用、调用/会话体量；
  - 费用卡有 **`积分 / 人民币 / 美元`** 三个切换按钮；
- 最近 12–14 天图表可在 **`API 请求次数` / `Tokens`** 之间切换：
  - API 请求次数：面积趋势图，鼠标悬停显示日期、请求次数和 Token；
  - Tokens：堆叠柱状图，鼠标悬停显示日期、总 Token、输入（命中缓存）、
    输入（未命中缓存）、输出；
- `按天 / 按模型 / 按会话` 三个页签，支持过滤和导出 JSON；
- 三个页签末尾都有 **`费用`** 列，单位跟随顶部费用卡的 `积分 / 人民币 / 美元` 切换：
  - 按天：当天分档计价后的实际费用；
  - 按模型：该路由（`provider:model`）自己分档计价后的费用；
  - 按会话：该会话内所有路由的费用之和；
  - 没有官方价/网关价的模型显示 `--`，不编造；
- 按天表默认今天在最上面，行内显示缓存读、新增输入、输出、缓存命中率。

**检查更新**：历史弹窗标题栏下方有一行版本信息与「检查更新」按钮。Host 读取
`updateRepo`（默认 `migao666/dsh-token-usage`）的 GitHub `releases/latest`，比较当前版本
（`meta.version`）；发现新版本后点「安装更新」即可下载该 Release 的 zip、备份现有文件
（备份到 `~/.dsh/plugins/.update-backup-<旧版本>-<时间>`，保留 `node_modules`）并覆盖安装，
之后重启 DSH 生效。私有仓库需要在配置里填 `updateToken`（只读权限即可）；公开仓库留空。

**费用口径**：费用卡有三种真实口径，点 `积分 / 人民币 / 美元` 切换：

- **积分**：Host 从 workbuddy2api 网关的 `state.json` 读取
  `accounts[*].model_costs[*].cost_per_1k`（实测积分/千 token），按样本加权计算；
  **`workbuddyStatePath` 留空即自动探测**：先看环境变量
  `WORKBUDDY_STATE_PATH` / `WORKBUDDY2API_STATE` / `WB_STATE_PATH`，再试各盘根下
  常见的 `wb-deploy/workbuddy2api/data/state.json` 布局，最后有界扫描名为
  `workbuddy2api` 的目录；候选必须能解析出 `accounts[*].model_costs` 才采用，
  显式配置始终优先。来源见面板数据的 `costs.workbuddy.sourcePath`，
  `costs.workbuddy.source` 标明 `config` / `auto` / `none`；
- **人民币 / 美元**：按官方公开价计算（DeepSeek、智谱 GLM），只有有官方价的模型
  才计入，卡片显示覆盖比例；人民币由 Host 定期从
  `https://open.er-api.com/v6/latest/USD` 读取 USD/CNY，失败时用上次成功值
  或 `usdToCny` 回退值，并在卡片标注「实时 / 上次 / 固定」。
  **费用卡右侧的刷新图标**会一次性重拉汇率、DeepSeek/智谱官方价和 WorkBuddy
  `state.json`；单个来源失败时保留旧值，不会把失败当成功。
  **高峰 / 空闲自动分档**（`pricingTier: auto`，默认）：DeepSeek 在北京时间
  周一至周五 09:00–12:00、14:00–18:00 收高峰价，其余时间（含周末与法定节假日）
  半价。Host 给每个 usage 样本按事件时间打上 `peak` / `offpeak`，分别计价后相加，
  因此 `costs.official.usd / cny` 是分档混合后的真实金额；明细在
  `costs.official.peak / offpeak / legacy`，`costs.official.tier` 是当前模式
  （`auto` / `peak` / `offpeak`，后两者用于估算或对照）。补丁上线前的历史样本会被
  自动用日志里的事件时间重算分档（`retierFromLogs`）；日志已不存在的会话没有时间
  信息，仍留在 `legacy` 里按高峰价计，避免编造。
  **法定节假日自动拉取**：`holidayApiUrl`（默认
  `https://timor.tech/api/holiday/year/{year}`，`{year}` 按年替换）在启动时拉取当年的
  放假安排（只取 `holiday: true` 的法定休息日，调休补班工作日仍按星期规则），结果缓存到
  `<root>/holidays.json`，离线启动用缓存、超过 7 天自动刷新；`holidayDates` 里的
  手工日期始终叠加生效（离线兜底，已内置 2026 全年 33 个法定休息日）。
  注意：已分档的历史记录不会因新增节假日数据自动重算（需要时删 `manifest.json` 重建）。

**官方公开价来源**：

- DeepSeek：<https://api-docs.deepseek.com/quick_start/pricing>
  （2026-10-24 抓取；`deepseek-v4.1-flash` 缓存命中 $0.006/M、未命中 $0.30/M、输出 $1.20/M，峰值价）。
- 智谱 GLM：<https://docs.bigmodel.cn/cn/guide/start/pricing>
  （2026-10-24 抓取；`GLM-5.3-Flash` 缓存命中 ¥0.23/M、未命中 ¥0.80/M、输出 ¥2.80/M，人民币价；Host 用实时 USD/CNY 折算成美元后计价）。

`space-bunny` 是 WorkBuddy 的匿名模型，没有公开官方单价；OpenAI 官方定价页当前被
Cloudflare 拦截，无法可靠抓取这些路由的单价。它们不计算，不编造金额；覆盖面会显示在
费用卡上。

隐藏面板也同步改成“本会话 Token + 组成条 + 缓存命中率 / 输出速度 / 上下文占用 / 轮次步数”。

## 统计口径的验证

与官方 `tokenUsage` 投影**逐项一致**，包括重试与重写的语义：

- **重试**（`llm/retry-started`）不 subtracting —— 服务方对两次尝试都计费，重试后的样本直接累加。
- **重写**（同 turn/step 再次结算且数值不同）只计入**差值**。
- **相同数值重复结算**忽略。

`scripts/verify-parity.mjs` 会用一份独立实现的「官方口径」折叠去对拍本插件的折叠结果，对你机器上每一个会话日志逐一验证（含 1000+ 样本的重试会话）。

## 冷启动回扫

首次启动会回扫两个历史来源，把插件启用之前的消耗也统计进来：

1. `~/.dsh/sessions` 下的会话日志（能拿到逐条 usage，最准）；
2. `~/.dsh/storages/session_projcache/sessions` 下的 `tokenUsage` 投影缓存 ——
   **会话被删除后日志目录会消失，但缓存可能还在**，这是“已删除会话也算进历史累计”的来源；
3. `backupRoots` 里配置的会话备份目录（每个含 `sessions/` 日志和/或 `projcache/` 缓存），
   用来补齐**插件启用前就已删除、当前 `~/.dsh` 里已经没有**的会话。本机已配置
   `E:\dsh会话备份_20261017` 与 `E:\dsh会话备份_20261018_1840`。

回扫会记录每条日志的最高事件序号作为水位，之后的实时事件按序号去重 —— 否则「回扫 + 实时」会把同一批事件数两遍。
两个来源都按 `sessionId` 合并、每个桶取较大值（不是相加），所以同一会话不会重复计数。
如果日志和投影缓存都已经被彻底清掉，那部分历史无法恢复；其余能读到的都会累计。

每次账本落盘后，Host 还会把聚合结果写到各工作区根目录的 `.dsh-token-usage.json`（隐藏文件，约 2–4 KB），
供浏览器通过 `workspaceFiles` 读取；删掉它不会丢数据，下一次落盘会重建。

## 安装

```bash
# 方式一：从目录安装（开发用）
node scripts/install.mjs --profile desktop

# 方式二：作为组合包安装
dsh plugin --profile desktop add dsh-token-usage
```

装完 **重启 dsh**。

> 本机当前 profile 的 pnpm 依赖图里有一个 git 依赖，而宿主进程 PATH 中没有 `git`，
> 因此 `plugin_manager install_bundle` 会在 pnpm 解析阶段失败（与本插件无关）。
> 本机是按「复制包 + 写 loader 行 + 写 package.json 依赖」手工安装的；
> 等 `git` 可用后，上面的标准安装方式即可正常工作。

## 配置

```yaml
- id: token-usage
  name: dsh-token-usage
  config:
    root: ""               # 账本目录，空 = <DSH_HOME>/token-usage
    flushIntervalMs: 2000  # 账本落盘间隔
    decodeCapBytes: 33554432
    backfillLimit: 2000    # 单次回扫的会话上限
    timeZoneOffsetMinutes: 480  # 按天统一用北京时间（UTC+8），与宿主时区无关
    workbuddyStatePath: ''  # 可选：积分单价来源；空 = 自动探测 workbuddy2api 的 state.json
    usdToCny: 7.2          # 人民币视图的离线回退汇率
    exchangeRateUrl: 'https://open.er-api.com/v6/latest/USD'  # 实时汇率源；空 = 只用回退值
    exchangeRateRefreshMs: 900000  # 15 分钟刷新一次
    pricingTier: auto      # 官方价分档：auto（按北京时间高峰/空闲自动分）/ peak / offpeak
    holidayDates:          # 手工/离线兜底的法定休息日（YYYY-MM-DD），已内置 2026 全年
      - '2026-10-01'
    holidayApiUrl: 'https://timor.tech/api/holiday/year/{year}'  # 放假安排 API，空 = 关闭
    backupRoots:           # 额外会话备份根目录（每个含 sessions/ 和/或 projcache/）
      - 'E:\dsh会话备份_20261017'
      - 'E:\dsh会话备份_20261018_1840'
```

## 积分单价缓存

网关的 `state.json` 只保留最近 **6 小时**内观测到的 `model_costs`（`modelCostTTL`）。
插件因此把见过的单价写进 `<root>/cost-rates.json`（按模型一行：`per1k` / `samples` /
`firstSeen` / `lastSeen`），加载时与实时快照合并：

- 新观测覆盖旧值；旧值保留到超过 `costRateRetentionDays`（默认 180 天）；
- 网关离线、state.json 丢失或缓存损坏，都只降级为"用已有缓存 + 实时快照"，不报错；
- 首次运行会扫 `<gateway>/backups/state.json.bak-*` 把旧单价导入缓存。

所以"某天积分列显示 `--`"只剩一种含义：**那个模型从未被任何本地快照记录过**，插件不会编造价格。

## 账本文件

```
<DSH_HOME>/token-usage/manifest.json
```

单写者 + 原子落盘（写临时文件再 `rename`）。删掉即可清空全部统计；删掉后下次启动会重新回扫补齐。

## 测试

```bash
node scripts/selftest-cost-cache.mjs  # 积分单价缓存 / 合并 / 保留期 / 备份导入
node scripts/selftest-host.mjs     # 折叠 / 水位 / 落盘 / 聚合 / 真实日志回扫
node scripts/selftest-client.mjs   # 在 vm 里加载 lib/client.js 并渲染悬浮面板与弹窗
node scripts/verify-parity.mjs     # 对拍官方 tokenUsage 投影口径
```

client 测试用真实会话量级的数据驱动一个最小 React stub（带 deps 比较的 `useEffect`、`setState` 触发重渲染、数组 children 展平、portal 记录），覆盖触发器读数、悬停展开、四个指标卡、历史弹窗三个页签，以及资源缺失时的降级路径。

## 架构

```
lib/index.js        host 端：事件订阅、usage 折叠、账本、回扫、Remote 服务
lib/client.js       client 端：由 src/body.js 生成
src/body.js         client 源码（纯 IIFE，依赖 react / react-dom / 官方 primitives）
scripts/build-client.mjs   把 body 包成 DSH client module 格式
scripts/link-peers.mjs     从 app.asar 取出 peer 依赖供本地测试
```

client 端不引打包器：body 只 `require` 三个模块，由 DSH 的 `window.__ModuleLoader__` 工厂注入。悬浮面板用官方 `useAnchoredPosition` + `useDismissOnOutsidePointer` 定位与关闭，历史弹窗走 `react-dom` 的 portal —— 因此和 harness 里其它浮层行为一致。
