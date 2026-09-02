---
name: feishu-tech-diagram
description: Use when a Lark/Feishu technical document needs an editable architecture diagram, flowchart, sequence diagram, state model, data relationship, Agent workflow, development process, reliability view, learning map, roadmap, or decision visualization.
---

# 飞书技术图表

先讲清关系，再处理布局和配色。图只补充正文，不重复正文；最终交付优先使用可编辑飞书画板。

## 必做流程

1. 读取目标章节和相邻上下文；有现有画板时先回读代码、raw 节点或预览。
2. 写图意图卡：一句话结论、目标读者、抽象层级、主链、分组、分支、方向和目标载体。
3. 从 [template-catalog.md](references/template-catalog.md) 选择关系结构最接近的模板，再读取 [template-specs.json](references/template-specs.json) 中同编号的输入、必备语义和坏味道。
4. 打开 [visual-examples.md](references/visual-examples.md) 中同编号 SVG，只复用构图；必须替换示例里的通用节点。
5. 生成后检查文字截断、节点重叠、交叉线、空白、抽象层级、边界、边标签和失败路径；最多迭代两轮，仍拥挤则拆图。
6. 写入飞书前预览；覆盖已有画板先 dry-run，写入后回读验证。

## 图意图卡

```text
一句话结论：
目标读者：
抽象层级：Context / Container / Component / Runtime / Process / Decision
主链：
分组：
分支或异常：
方向：LR / TB / 泳道 / 时序 / 状态 / 脑图
目标：本地 SVG 预览 / 新建可编辑画板 / 更新已有画板
```

## 选型规则

- 先按“要回答的问题”选模板，不按视觉外形选。
- 一张图只使用一个主要抽象层级；跨层信息拆成图组。
- 主节点控制在 6–12 个；边超过 15 条或多条跨层回边时拆图。
- 横向主链用 LR，稳定层次用 TB，角色协作用泳道，调用先后用时序。
- 节点写“短标题 + 一行职责”，边标签写协议、动作、数据或条件。
- Context 与安全图必须标系统或信任边界；生产评审图必须表达失败路径。

## 最小图组

- 系统说明：Context + Container。
- 核心链路：Container + 时序或数据流。
- 生产评审：Container + 部署拓扑 + 故障传播 + SLO。
- 安全评审：Context + 信任边界 + 认证授权 + 敏感操作审批。
- Agent 系统：Context + Agent 平台 + 执行时序 + 工具权限 + Trace/Eval。

## 可编辑交付

- 本地 SVG 只使用飞书画板可识别的基础形状、文字、连线和安全变换。
- 写入飞书时使用 `<whiteboard type="svg">...</whiteboard>` 或 `<whiteboard type="svg" path="@...">`，让基础元素转换为可编辑节点。
- 禁止用 PNG/JPEG 作为模板交付；位图只用于临时预览。
- 多个模板写入同一文档时，每个画板紧跟对应模板说明，不集中堆到文档末尾。
- 交付物不得包含水印、来源声明、会话链接、任务标识、真实业务名或账号信息。

## 资产

- 模板目录：[template-catalog.md](references/template-catalog.md)
- 完整结构化规范：[template-specs.json](references/template-specs.json)
- 可改写提示词：[diagram-prompts.json](references/diagram-prompts.json)
- SVG 示例索引：[visual-examples.md](references/visual-examples.md)
- SVG 源文件：`assets/samples/`

更新资产后运行：

```bash
python3 tests/validate_assets.py
```

## 交付检查

- 主链、边界和结论三秒内可辨认。
- 不含无依据新增的组件、依赖、日期或指标。
- 同层对齐、同组同色，形状语义一致。
- 箭头有方向，关键边有协议、动作、数据或条件。
- 无文字截断、节点重叠、明显交叉线或大面积空白。
- 飞书中的节点、文字和连线可以继续编辑。
- 写入后已通过 preview、source 或 raw 至少一种方式回读。
