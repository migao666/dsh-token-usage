# Token用量 安装说明

这是一个 DSH 桌面版插件：会话头部显示当前会话 Token，历史弹窗展示跨会话统计、
API 请求次数 / Tokens 图表，以及 WorkBuddy 积分 / 人民币 / 美元三种费用口径。

## 关于这个包（0.2.1 修复版）

在官方 0.2.0 基础上打了这些修复（详见 `PATCH-NOTES.md` 与 `patches/`）：

- WorkBuddy 网关 state.json 自动探测（`workbuddyStatePath` 可留空）；
- 官方价高峰/空闲自动分档 + 历史按日志重新分档；
- 历史面板 `按天 / 按模型 / 按会话` 三个表新增「费用」列；
- 法定节假日从 API 拉取并缓存（`holidayApiUrl`，已内置 2026 全年）。

本包**自带 `node_modules/schemastery`**：插件把它声明为 peerDependency，而 DSH profile 默认
`autoInstallPeers: false`，`file:` 方式安装时不会自动补，缺了会激活失败
（`ERR_MODULE_NOT_FOUND: schemastery`）。因此把该依赖（及其依赖）随包一起带上，
解压后即可安装。若你的环境已能解析 schemastery，删掉这个目录也仍然可用。

## 前置条件

- DSH 桌面版，能正常打开 `desktop` profile；
- 安装/更新时需要网络（拉取插件依赖、DeepSeek 官方费率与实时汇率）；
- 当前测试版本：DSH `0.2.1-rc.3`，插件版本 `0.2.0`。

## 安装（推荐）

1. 把 `dsh-token-usage` 文件夹解压到长期保留的位置，例如：

   ```text
   C:\Users\<用户名>\Documents\dsh-token-usage
   ```

2. 在 DSH 里新建/打开会话，对 Agent 说：

   ```text
   请用 plugin_manager install_bundle 安装这个本地插件：
   C:\Users\<用户名>\Documents\dsh-token-usage
   ```

3. 等待 `application: applied`，然后**重启 DSH**。

4. 会话头部右侧出现 `Token用量` 胶囊，悬停可看本会话读数，点「历史累计」打开完整面板。

## WorkBuddy 积分（默认自动探测）

`积分` 口径读 workbuddy2api 网关的 `state.json`。**不用手工配置**：Host 在
`workbuddyStatePath` 留空时自动探测 ——

1. 环境变量 `WORKBUDDY_STATE_PATH` / `WORKBUDDY2API_STATE` / `WB_STATE_PATH`；
2. 各盘根下的常见布局，如 `<盘>:\wb-deploy\workbuddy2api\data\state.json`、
   `<盘>:\docker\wb-deploy\workbuddy2api\data\state.json`；
3. 在前两者都没命中时，对每个盘做一次有界扫描，找名为 `workbuddy2api` 的目录。

候选文件必须能解析出 `accounts[*].model_costs` 才会被采用；探测到的路径会出现在
面板数据 `costs.workbuddy.sourcePath`，`source` 标明 `config` / `auto` / `none`。
网关后启动、换盘、改目录都会被下一次刷新（最多 30 秒节流）重新发现。

需要固定某个文件时再显式配置（优先级最高）：

```yaml
workbuddyStatePath: 'D:\ls\docker\wb-deploy\workbuddy2api\data\state.json'
```

`人民币` / `美元` 与积分无关：按 DeepSeek 官方价计算，并**自动区分高峰/空闲**，
法定节假日从 `holidayApiUrl`（默认 timor.tech 按年接口）拉取并缓存到
`~/.dsh/token-usage/holidays.json`（已内置 2026 全年 33 个休息日作离线兜底），
（北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余含周末与节假日为半价）
—— 每个 usage 样本按事件时间归到 `peak` / `offpeak`，分别计价后相加；补丁上线前的
历史样本会用日志里的事件时间自动重算，日志已删除的会话留在 `legacy` 按高峰价计。
汇率每 15 分钟从 `open.er-api.com` 获取 USD/CNY，失败回退到上次成功值或 `usdToCny`。
找不到网关 state 时 `积分` 卡显示 `--`，不编造。

## 检查更新

历史面板标题栏下方有「检查更新」按钮：读取 `updateRepo` 的 GitHub 最新 Release，比较当前版本；
有新版本时点「安装更新」会自动下载并覆盖安装（旧文件备份在
`~/.dsh/plugins/.update-backup-<旧版本>-<时间>`），然后重启 DSH 生效。
**私有仓库**需要在 profile 的 `cordis.patch.yml` 里给 `token-usage` 填 `updateToken`；
把仓库改成公开则不需要。

## 换机器注意

- `backupRoots` 是**本机路径**，新机器上不要照抄；`workbuddyStatePath` 留空即可
  （自动探测），只有在自动探测不到时才需要手写；
- 官方费率是公开表；实时汇率需要网络，断网会显示「固定」或「上次」；
- 历史账本在 `~/.dsh/token-usage/manifest.json`，默认不随插件包迁移；
  如果需要带历史，单独复制这个 manifest 到新机器同一路径。

## 卸载

```text
请用 plugin_manager remove_bundle 卸载 dsh-token-usage
```

然后重启 DSH。

## 从 GitHub 拉取安装（另一台电脑）

仓库（私有）：https://github.com/migao666/dsh-token-usage

`powershell
git clone https://github.com/migao666/dsh-token-usage.git C:\Users\<用户名>\Documents\dsh-token-usage
`

如果这台电脑没有 git，也可以直接在 GitHub 网页上「Code → Download ZIP」解压。

然后在 DSH 会话里：

`	ext
请用 plugin_manager install_bundle 安装这个本地插件：
C:\Users\<用户名>\Documents\dsh-token-usage
`

等 pplication: applied 后重启 DSH。私有仓库需要先登录（gh auth login，或用带 repo 权限的 token）。
本机已配置自动同步：~/.dsh/plugins/dsh-token-usage 有改动时，计划任务每 5 分钟镜像并推送到该仓库。

