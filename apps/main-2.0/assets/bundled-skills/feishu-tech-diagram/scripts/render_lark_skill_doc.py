#!/usr/bin/env python3
from __future__ import annotations

import html
import json
from pathlib import Path


SKILL = Path(__file__).resolve().parents[1]
PROMPTS = json.loads((SKILL / "references/diagram-prompts.json").read_text())
SPECS = {
    row["id"]: row
    for row in json.loads((SKILL / "references/template-specs.json").read_text())
}


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


parts: list[str] = [
    "<title>Feishu Tech Diagram Skill（66 类可编辑模板）</title>",
    '<callout emoji="🎨" background-color="light-blue" border-color="blue"><p>用于技术文档中的架构图、流程图、Agent 工作流和学习图。66 个示例均以飞书画板交付，节点、文字和连线可继续编辑。</p></callout>',
    "<h2>Skill 定义</h2>",
    '<pre lang="yaml"><code>name: feishu-tech-diagram<br/>description: 为飞书技术文档生成、重绘和校验可编辑图表，并沉淀可复用模板。</code></pre>',
    "<h2>目标</h2>",
    "<ul><li>读者在三秒内辨认主链、系统边界或状态变化。</li><li>一张图只表达一个核心结论，图和正文互补。</li><li>最终交付物是可编辑画板，不以 PNG/JPEG 代替模板。</li><li>模板使用中性名称，不携带真实业务、账号或来源信息。</li></ul>",
    "<h2>必做流程</h2>",
    '<ol><li seq="auto"><b>读取上下文。</b> 获取目标章节、相邻表格和已有画板。</li><li seq="auto"><b>整理图意图卡。</b> 写清结论、读者、层级、主链、分组、异常和方向。</li><li seq="auto"><b>选择模板。</b> 按要回答的问题选择关系结构，而不是按外观选。</li><li seq="auto"><b>替换内容并预览。</b> 检查文字、节点、连线、边界和失败路径。</li><li seq="auto"><b>写入并回读。</b> 覆盖前 dry-run，写入后验证节点可编辑。</li></ol>',
    "<h2>图意图卡</h2>",
    '<table><thead><tr><th background-color="light-blue">项目</th><th background-color="light-blue">要回答的问题</th></tr></thead><tbody><tr><td>一句话结论</td><td>读者看完图应该记住什么？</td></tr><tr><td>目标读者</td><td>产品、研发、SRE、安全还是管理者？</td></tr><tr><td>抽象层级</td><td>Context、Container、Component、Runtime、Process 还是 Decision？</td></tr><tr><td>主链</td><td>从哪里开始，经过哪些关键节点，到哪里结束？</td></tr><tr><td>分组与边界</td><td>哪些节点属于同一层、角色、系统或信任域？</td></tr><tr><td>分支与异常</td><td>哪里会判断、重试、降级、补偿、回滚或人工接管？</td></tr></tbody></table>',
    "<h2>画板交付规则</h2>",
    '<ul><li>通过 <code>&lt;whiteboard type="svg"&gt;</code> 导入基础形状、文字和连线。</li><li>每个画板紧跟对应模板说明，不集中堆在文档末尾。</li><li>位图只用于临时预览，不作为模板交付。</li><li>写入后至少通过 preview、source 或 raw 一种方式回读。</li></ul>',
    "<h2>66 类可复用模板</h2>",
    "<p>每个模板包含适用场景、核心结论、推荐布局、必备语义和一个可编辑画板。使用时必须替换示例里的通用节点。</p>",
]

categories: list[str] = []
for prompt in PROMPTS:
    if prompt["category"] not in categories:
        categories.append(prompt["category"])

for category in categories:
    parts.append(f"<h3>{esc(category)}</h3>")
    for prompt in (row for row in PROMPTS if row["category"] == category):
        spec = SPECS[prompt["id"]]
        asset = (
            "@skills/feishu-tech-diagram/assets/samples/"
            f"{prompt['id']}-{prompt['slug']}.svg"
        )
        semantics = "、".join(spec["required_semantics"])
        parts.extend(
            [
                f"<h4>{esc(prompt['id'])} {esc(prompt['title'])}</h4>",
                f"<p><b>适用场景：</b>{esc(spec['scene'])}</p>",
                f"<p><b>核心结论：</b>{esc(spec['core_conclusion'])}</p>",
                f"<p><b>推荐布局：</b>{esc(spec['layout'])}</p>",
                f"<p><b>必备语义：</b>{esc(semantics)}</p>",
                f'<whiteboard type="svg" path="{esc(asset)}"></whiteboard>',
            ]
        )

parts.extend(
    [
        "<h2>布局与文字规则</h2>",
        "<ul><li>主节点控制在 6–12 个；边超过 15 条或多条跨层回边时拆图。</li><li>横向主链用 LR，稳定层次用 TB，角色协作用泳道，调用先后用时序。</li><li>节点使用短标题和一行说明；关键边写协议、动作、数据或条件。</li><li>Context、安全与部署图必须明确系统、信任或运行边界。</li></ul>",
        "<h2>最小图组</h2>",
        '<table><thead><tr><th background-color="light-gray">目标</th><th background-color="light-gray">推荐组合</th></tr></thead><tbody><tr><td>系统说明</td><td>Context + Container</td></tr><tr><td>核心链路</td><td>Container + 时序图或数据流</td></tr><tr><td>生产评审</td><td>Container + 部署拓扑 + 故障传播 + SLO</td></tr><tr><td>安全评审</td><td>Context + 信任边界 + 认证授权 + 敏感操作审批</td></tr><tr><td>Agent 系统</td><td>Context + Agent 平台 + 执行时序 + 工具权限 + Trace/Eval</td></tr></tbody></table>',
        "<h2>交付检查</h2>",
        "<ul><li>画板中的节点、文字和连线可以继续编辑。</li><li>主链、结论与边界三秒内可辨认。</li><li>不含无依据新增的组件、依赖、日期或指标。</li><li>箭头有方向，关键边有协议、动作、数据或条件。</li><li>无文字截断、节点重叠、明显交叉线或大面积空白。</li></ul>",
        "<hr/><p>版本：66 类可编辑模板；同步日期：2026-08-10。</p>",
    ]
)

print("".join(parts))
