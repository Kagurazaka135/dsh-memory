# dsh-memory

DeepSeek Harness（dsh）的**分层记忆插件** —— 把自研的 L0–L4 记忆管线裁成 **PC / 手机通用**的最小实现。

**状态：设计阶段。** 施工书见 [`设计方案.md`](设计方案.md)。

## 是什么

一个标准 dsh 插件（npm 包 + `defineTool` + `cordis.patch.yml`），给 dsh 加：

- **L3 永久事实**（版本化，只追加不覆盖）
- **L4 启动摘要**（~200 行，O(1) 读）
- **夜间整理**（走 dsh 原生 schedule，模型走本地 broker）

**不改 dsh 本体**，一份包 PC / 手机通吃。

## 三条铁律

1. 只追加不删
2. 模型一律走本地 broker（代码里零真 key）
3. 定时归 host、插件只注册不自持

## 待办

- [ ] 摸清 dsh 原生 memory 机制（定"增强 vs 替代"）
- [ ] 摸清 `ctx.schedule` 插件侧 API
- [ ] 仓库骨架
- [ ] L3/L4 存储 + 工具
- [ ] 夜间整理
- [ ] PC 实测 → 手机验证

见 [`设计方案.md` §8 施工步骤](设计方案.md)。
