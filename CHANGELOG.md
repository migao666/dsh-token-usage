# 更新记录

## 0.2.4 — 2026-10-24

- 「检查更新 / 安装更新」那一行从标题栏下方移到面板**最底部**（表格下方，右对齐，
  与内容用一条分隔线隔开）。

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
