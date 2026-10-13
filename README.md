# dsh-memory

DeepSeek Harness（dsh）的**分层记忆插件** —— 把自研的 L0–L4 记忆管线裁成 **PC / 手机通用**的最小实现。

**状态：已实现，PC 双线（0.1.6 / 0.2.0-rc.2）实测通过；手机待装。** 施工书见 [`设计方案.md`](设计方案.md)，摸清与实测补记见 [`摸清报告.md`](摸清报告.md)。

## 是什么

一个标准 dsh 插件（npm 包 + `defineTool` + `cordis.patch.yml` 的 `insert:`），给 dsh 加：

- **L3 永久事实**（版本化：同主题改值 → 追加新版本，旧值永不删）
- **L4 启动摘要**（`brief.md`，O(1) 读；旧版自动归档到 `log/`，不丢）
- **L2 待升格候选**（反复出现的线索，人工确认后 `memory_promote` 升格成 L3）
- **夜间整理**（到点由 dsh 原生 schedule 投递 → 扫描最近会话 → 走本地 broker 归纳 → 只追加落盘）

**不改 dsh 本体**，一份包 PC / 手机通吃。

## 三条铁律

1. **只追加不删** —— L3 版本化天生安全；候选升格/驳回只改 `status` 不物理删除
2. **模型一律走本地 broker** —— 默认 `http://127.0.0.1:9999`，key 只用假值 `local-broker`（真钥匙由 broker 注入），**代码里零真 key**
3. **定时归 host、插件只注册不自持** —— 用 dsh 原生 schedule 服务（自动化任务页可见、host 持久），**不用 setInterval**

## 存储（明文、人可读、可迁移）

落 `$DSH_HOME/memory/`（`DSH_HOME` 默认 `~/.dsh`；可用 `memory_dir` 覆盖）：

```
memory/
  brief.md            L4 启动摘要（人可读 Markdown）
  facts.yaml          L3 永久事实（history 版本链，最新一条=当前值）
  candidates.yaml     L2 待升格候选（pending / promoted / rejected 只改状态）
  log/
    YYYY-MM-DD.json   整理日志（append-only NDJSON：排查、注册诊断都在这里）
    brief-*.md        旧摘要归档（每次更新前归档，内容不丢）
  .sessions.json      已内部化处理的会话台账（避免重复归纳）
```

## 工具（六只）

| 工具 | 作用 |
|---|---|
| `memory_brief` | 读 L4 摘要（会话开始 / 需要时调） |
| `memory_recall` | 查 L3（关键词 / 标签），返回命中 fact 的完整版本历史 |
| `memory_note` | 记一条 L3 事实（同主题自动版本化；同值不写） |
| `memory_candidate` | 记一条 L2 待升格候选（同线索重复 → count+1） |
| `memory_promote` | 候选升格成 L3（人工确认后调） |
| `memory_organize` | 手动触发一次整理（支持 `dry_run` 试跑） |

## 安装

```bash
# 在 dsh 安装目录（或全局 dsh 可用的地方）：
dsh plugin --profile <你的profile> add /path/to/dsh-memory-0.1.1.tgz
# （也可 add 包名 / GitHub 地址；手机端三种输入都支持）
```

插件会自动加入 profile 的 bundles；profile 的 `cordis.patch.yml` 只用来覆盖配置（全部可选）：

```yaml
- id: dsh-memory
  config:
    daily_time: "04:00:00"          # 支持 HH:MM 或 HH:MM:SS，内部归一到秒级
    time_zone: "Asia/Shanghai"      # 缺省取宿主本地时区
    organizer_model: "deepseek-flash"
    broker_url: "http://127.0.0.1:9999"
    memory_dir: ""                  # 缺省 $DSH_HOME/memory
    organizer_session: "memory-organizer"
    # enable_schedule: false        # 置 false 跑一次 → 插件主动移除自己注册的定时任务
```

## 部署说明（重要）

- **dsh ≥ 0.2.0-rc.2（含手机内核 0.2.0-rc.2）**：schedule 服务在
  `@deepseek-ai/dsh-experimental-schedule-bundle`（**实验性、默认关**）。要看到"自动注册 + 夜间整理"，
  需把该 bundle 加进 profile 的 `dsh.profile.bundles`（或插件管理页开 "Automation tasks"）。
  master/0.2.1 起已并入 web-app 默认，无需此步。
- **dsh 0.1.x**：没有 schedule 服务 —— 插件自动降级：六只记忆工具照常可用，只是不注册定时任务。
- **整理会话**：插件自动创建/物化 `memory-organizer` 会话（经 `sessionPersistence` 落盘，可被定时投递冷恢复）；
  它只用来跑整理，不污染日常主会话。
- **卸载/停用**：Cordis 的 dispose 发生在**应用退出/重载**，所以插件**不会**在 dispose 里删定时任务
  （否则每次关应用都会丢定时）。要移除任务：配置里置 `enable_schedule: false` 跑一次（插件主动清理**自己**的任务），
  或在自动化任务页（Automation tasks）手动删。

## 与官方 MCP-memory 路线的关系

dsh 官方**没有**原生 memory 子系统（无 `$DSH_HOME/memories/` 约定、无 memory 包）；官方给的是
"挂第三方 memory MCP server"的路子（default-off，见官方 docs 的 mcp-memory 指引）。

本插件与它**并行、无冲突**，定位不同：

- MCP-memory：给模型挂一个"记忆检索服务"（黑盒存储，依赖那个 MCP server 自己的格式）。
- 本插件：**文件级** L3 版本化 + L4 摘要 + 夜间整理 —— 产物是 `$DSH_HOME/memory/` 下的**明文文件**，
  人可读、可 diff、可迁移、可被任何会话/工具读到，且"只追加不删"由代码兜底。

两者可同时使用。

## 开发

```bash
npm install        # devDeps：cordis/dsh-tools/dsh-llm/dsh-system-prompt + typescript
npm run build      # tsc → lib/
npm pack           # 出 tarball 给 dsh plugin add
node e2e/run.mjs   # 独立 E2E（临时 DSH_HOME；含真 broker 整理、幂等、降级、清理；需 broker 9999 在线）
```

E2E 覆盖：六工具注册与执行 / 版本化（旧值不丢）/ 候选+升格 / 真 broker 整理（dry-run + 实跑）/
落盘检查 / 自动注册（sessionPersistence 物化链 + 秒级 daily + 诊断落盘）/ 重载幂等 / 无 schedule 降级 /
`enable_schedule:false` 清理。

## 实测记录（详见摸清报告"实测补记"）

- **PC 0.1.6-alpha.2**（headless）：note→recall→版本化→organize 全通；无 schedule 服务 → 正常降级。
- **PC 0.2.0-rc.2**（web + experimental schedule bundle）：自动注册 ✓（`storages/schedule.json`）；
  到点投递 ✓（Host 冷恢复整理会话 → 模型调 `memory_organize` → brief/log 落盘）；重启幂等 ✓；
  真会话扫描归纳 ✓（3 场会话 → 2 条候选 + 摘要更新 + 旧摘要归档）。
