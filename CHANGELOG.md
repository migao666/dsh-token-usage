# 更新记录

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
