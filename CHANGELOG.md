# 更新记录

## 0.2.6 — 2026-10-31

> 为什么跳过 0.2.5：0.2.5 是某台机器上遗留的本地构建（GitHub 从未发布过对应 Release），
> 只有版本号高于它，那些机器上的「检查更新」才会把它认成新版本。

### 检查更新重做：确认弹窗 + 强制拷贝安装

- 点「检查更新」→ 先问 GitHub 最新版本；**有新版本立刻弹确认框**
  （版本号、安装包名、会先备份旧文件、装完需重启），确认后才下载。
- 安装从「覆盖式 cp」改成**强制拷贝安装**：
  1. 安装根目录若是符号链接（link 安装），先用 realpath 解析到真实目录——
     更新的必须是"实际被加载的那份"，否则改的只是链接、重启就被源目录还原；
  2. 先把当前目录整体备份到 `.update-backup-<旧版本>-<时间戳>`（跳过 node_modules）；
  3. **删掉除 node_modules 外的全部旧文件**，再整包拷贝——旧版有、新版没有的文件不会残留
     （半新半旧正是"版本号变了、界面没变"的来源）；
  4. 安装后读回 package.json 校验版本，返回 verified / target / linked；
     校验失败会在面板上直接报错，而不是假报"已更新"。
- 抽出可单测的 `forceInstallPackage()`；`selftest-host` 新增 7 项断言
  （覆盖旧客户端、删除多余文件、保留 node_modules、备份可回滚、版本校验）。

## 0.2.4 — 2026-10-31

> 本地累计的一轮改动，**承接 GitHub 上的 v0.2.3** 一起发（不另起 0.2.5 / 0.2.6）。
> 原先分记的 0.2.4 / 0.2.5 / 0.2.6 内容已全部并入本版。

### 积分口径

- 修复「历史记录积分列除今天外全部不显示」「累计费用从 4,823 掉到 500 多」。
  根因：网关 `model_costs` 只保留 **6 小时**（`modelCostTTL`，`internal/pool/entry.go:430`），
  插件每次都只用当前快照重建价目表，于是 6 小时内没再被请求的模型失去单价 ⇒ 那些天的积分算不出来、
  顶部累计只剩「当前能计价的那部分 token」（还会随时间上下跳）。
- 新增**积分单价缓存** `<root>/cost-rates.json`：按模型记住最近一次观测单价，加载时与网关快照
  合并（新观测覆盖旧值，旧值保留），默认保留 180 天（新配置 `costRateRetentionDays`）。
- 网关重启、state.json 暂时不可读或换机，历史积分都不再变空；缓存损坏只降级为「仅用实时快照」。
- 首次运行会把网关 `backups/state.json.bak-*` 里仍存在的旧单价导入缓存，尽量救回被 6h 窗口丢掉的价格。
- 仍未覆盖：**从未被任何本地快照捕获过的模型**，其历史行继续显示 `--`——插件不编造价格。

### 版式（Stitch 设计稿）

- 按「Token 用量与效能监控看板」落第一批：统计卡改「标签 / 数值 + 芯片 / 分隔线 + 左右脚注」，
  总 Token 卡显示 7 日环比（↗ +x%），缓存卡在命中率 ≥90% 时挂「极速镜像」芯片，
  费用卡把「覆盖 x%」移到右侧脚注；按天表「日 Token 消耗」改为数字 + 内联进度条
  （<900px 自动隐藏条，只留数字）。
- 第二批设计 token：弹窗圆角 16 / 卡片 12、标题行加「Live Monitor」胶囊、
  头部右侧加「GitHub Releases」按钮（页脚不再重复，只保留这一个入口）、
  数值 26px/700、表头与单元格内边距 9px。
- 图标与字体对齐修正：`<a>`/`<button>` 补 `font:inherit`（此前回落到 serif）、
  内联 svg 统一 `display:block; flex:none`、头部改为 `align-items:center`、
  窄窗（<1000px）自动隐藏「实时 · 每 2 秒刷新」文字防止头部溢出；
  关闭按钮由 `×` 字符改为 12px SVG 十字，墨迹居中。

### 图表

- 修复「API 请求次数曲线把 3698 画得比 2901 低」：曲线原先先做三点滑动平均
  `(前 + 2×本 + 后) / 4`，孤立高峰被两侧安静日压低、被高峰夹着的普通值被抬高，
  导致曲线与表格数字相反。现在直接画原始值，顺滑交给 Catmull-Rom 曲线本身。
- 修复「API 请求曲线悬停时每到一个点都轻微卡顿」：去掉提示框的
  `transition:left .06s linear`（每次换点重新起动画）；14 个每日 `onMouseEnter`
  改为覆盖绘图区的**单层 mousemove**（按横坐标取最近一天，内联 rect 设 `pointer-events:none`）；
  提示框位置改为**跟随指针连续移动**，数值仍取最近一天。

### 布局

- 修复「窗口变矮 / 任务侧栏被压缩时弹窗下半部分被截断且不出现滚动条」：
  弹窗中部新增可滚动层 `.tsl-dash-body`（`flex:1 1 auto;min-height:0;overflow:auto`），
  包住「统计卡 / 趋势图 / 工具栏 / 表格」，底部「检查更新」行留在滚动层外；
  表格容器改 `flex:1 1 auto;min-height:120px`，允许收缩。
- 「检查更新 / 安装更新」一行固定在面板**最底部**（表格下方，右对齐，与内容用分隔线隔开）。

### 价格刷新（原 0.2.5）

- 费用卡刷新按钮：一次重拉 USD/CNY、DeepSeek/智谱官方价、WorkBuddy 积分单价；
  Node fetch 被 reset 时 Host 回退 PowerShell。
- 刷新结果分级：`已刷新` / `已刷新（部分）` / `刷新失败`，单个来源无数据不再全盘报错。
- 官方价增加智谱 GLM-5.3-Flash / GLM-5.3（人民币价，按实时汇率折算）；
  刷新失败保留上一次有效目录，覆盖率照实显示。
- API 请求图：圆点对齐日期刻度中心，首尾平缓收口，不再断崖或三角缺口。

### 工具与测试

- 新增 `scripts/selftest-cost-cache.mjs`（19 项）：合并、保留期、0 单价、损坏缓存、备份导入。
- 新增 `scripts/preview-dashboard.mjs`：用**真样式表**＋同构 markup 生成
  `evidence/preview-dashboard.html`，不装插件也能离线看版式（不参与运行时）。
- `selftest-client.mjs` 追加布局/版式/交互断言（滚动层、卡片脚注、内联条、单层悬停覆盖、
  无 transition、Releases 只在头部、无引擎状态行、极速镜像等）。

## 0.2.3 — 2026-10-24

- 「检查更新」的错误提示可读化：解码 PowerShell CLIXML，GitHub 404/401 时提示
  「私有仓库需要 updateToken / 改为公开」。
- PowerShell 调用改用 `-EncodedCommand`，避免脚本里的引号在 Windows 命令行被吃掉。
- 仓库改为公开；新增 GitHub Actions：`ci`（语法/元数据检查）与 `release`（打 tag 自动构建 zip 并发 Release）。

## 0.2.2 — 2026-10-24

- **面板「检查更新」**：历史弹窗标题栏下方新增一行，读取 GitHub `releases/latest`
  并比较当前版本；有新版本时可一键下载并安装（Host 会备份旧文件、保留 `node_modules`，
  装完提示重启 DSH 生效）。新增配置 `updateRepo`（默认 `migao666/dsh-token-usage`）与
  `updateToken`（私有仓库需要，公开仓库留空）。
- 快照 `meta` 新增 `version` 字段，供界面显示当前版本。

## 0.2.1 — 2026-10-24

基于官方 0.2.0 的本地修复版。

- **WorkBuddy 积分来源自动探测**：`workbuddyStatePath` 留空时按
  `WORKBUDDY_STATE_PATH` / 常见 `wb-deploy`、`workbuddy2api` 布局 / 有界扫描自动查找，候选必须能
  解析出 `accounts[*].model_costs`；显式配置优先。返回数据新增 `costs.workbuddy.source`
  （`config` / `auto` / `none`），并在源文件变化时（30 秒节流）自动重读费率。
- **官方价高峰 / 空闲自动分档**：北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余
  （含周末与法定节假日）半价；每个 usage 样本按事件时间打档，`costs.official` 新增
  `peak` / `offpeak` / `legacy` 明细，新增配置 `pricingTier: auto|peak|offpeak`。
- **历史重新分档**：启动时用会话日志里的事件时间给旧记录补分档（分档与按天覆盖不足时重算；
  日志已删的会话留在 `legacy` 按高峰价计）。
- **历史面板费用列**：`按天 / 按模型 / 按会话` 三个表末尾新增「费用」列，单位跟随顶部
  `积分 / 人民币 / 美元` 切换；按天行按「天 × 模型 × 档位」计价，会话行为其所有模型之和。
- **法定节假日 API**：`holidayApiUrl`（默认 `https://timor.tech/api/holiday/year/{year}`）
  启动时拉取当年放假安排并缓存到 `<root>/holidays.json`（7 天刷新、离线用缓存）；只取法定
  休息日，调休补班日仍按星期规则；已内置 2026 全年 33 天作为离线兜底。
- 安装层：`schemastery` 以 vendored `node_modules` 随包提供（profile 的
  `autoInstallPeers: false` 不会自动补 peer 依赖）。
