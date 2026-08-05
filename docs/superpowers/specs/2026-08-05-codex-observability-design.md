# Codex「观测」工作台设计

## 目标

在 V2 增加独立的「观测」页面。用户只在这个页面中创建和继续 Codex 会话，AgentRecall 完整记录这些受管会话的本地执行过程，用于查看 Codex 实际收到的上下文、工具与 Skill、逐步执行事件和原始协议数据。

该能力采用专用入口边界：

- 只观测由「观测」页面启动的 Codex，不接管终端中直接运行的 Codex，也不记录 Eval、Workflow 或其他 Agent 调用。
- 不修改 Codex Provider、认证信息、`CODEX_HOME` 或全局配置，不把请求改道到本地 HTTP 代理。
- 观测记录仅保存在本机，不进入 AI 搜索、记忆提取、同步或上传链路。
- Codex 正常请求仍由 `codex app-server` 按用户现有配置发送到其上游服务；AgentRecall 记录的是本机 app-server 与 rollout 实际暴露的内容。

“完整记录”不承诺获取服务端未下发的隐藏提示词或未公开的思维链。页面展示 Codex 提供的 reasoning summary 和事件，但不把它描述为完整 chain-of-thought。

## 产品结构

V2 顶部导航增加「观测」（英文为 `Observe`），与 Eval 平级，不放进 Eval 的内部页签。页面采用三栏结构：

1. 左栏是观测会话列表，展示标题、项目、模型、状态、更新时间和记录完整性，并提供新建、继续、停止和删除入口。
2. 中栏是原生多轮对话，按 turn 展示用户输入、Codex 回复、工具调用、审批、错误和运行状态。用户离开页面后，运行中的 turn 继续执行和记录。
3. 右栏是当前会话或 turn 的检查器，包含“上下文”“时间线”“原始数据”三个视图。

新建会话时选择工作目录；模型和 reasoning effort 默认跟随当前 Codex 配置，也允许在会话创建时覆盖。观测会话不注入 Eval 用例、Workflow Prompt 或 Configured Agent 指令，确保看到的是使用用户本机 Codex 配置启动的会话，而不是另一个 AgentRecall Harness。

会话生命周期状态分为：

- `idle`：会话可继续，目前没有活跃 turn。
- `running`：Codex 正在执行。
- `awaiting_approval`：等待用户处理工具或文件操作审批。
- `stopped`：用户已停止当前 app-server；保留 thread，可再次继续。
- `error`：Codex 启动或执行失败。

记录完整性与生命周期正交，单独分为 `pending`、`complete` 和 `incomplete`。例如一个会话可以处于 `idle + incomplete`：Codex 已经结束当前 turn，但记录器写盘失败或 rollout 无法补全。页面不能用 `error` 或 `idle` 覆盖完整性警告。

页面切换不改变状态。关闭应用时终止由观测服务持有的 app-server 与子进程；下次启动后，已有 thread 可以通过 `thread/resume` 继续，但不会把上次被应用退出中断的 turn 伪装成成功。

## 执行边界

主进程新增 Codex 观测服务，负责会话生命周期、RPC、落盘和 IPC；renderer 不直接启动进程或访问文件。

每个正在使用的观测会话持有一个 `codex app-server --listen stdio://` 进程和 `CodexRpcClient`。第一次发送消息时使用 `thread/start`，后续进程仍在时继续使用同一 thread；进程被停止、退出或应用重启后，下一次发送使用 `thread/resume`。同一会话同时只允许一个活跃 turn，不同观测会话可以独立运行。

`thread/start` 使用：

- 用户选定的 `cwd`、可选模型和 reasoning effort。
- `baseInstructions: null`、`developerInstructions: null`，让 Codex 使用其正常配置，不额外注入 AgentRecall 自动化指令。
- `experimentalRawEvents: true` 与 `persistExtendedHistory: true`，保留 app-server 能提供的详细事件和 rollout 历史。
- `approvalPolicy: "on-request"`，审批通过现有主进程审批能力发送到观测页面并回写 app-server。

停止操作优先发送 `turn/cancel`，随后关闭 app-server。若 app-server 无响应，使用现有跨平台进程管理边界终止该服务拥有的进程树。只能处理服务创建并持有 PID 的进程，不扫描或终止名称相同的外部 Codex。

## 双来源采集

选择“原始 RPC + rollout 补全”的混合方案。

### app-server RPC

扩展现有 `CodexRpcClient` 的观察回调，在任何标准化、截断或请求分发之前报告：

- AgentRecall 发往 app-server 的 request、notification 和 response。
- app-server 返回的 response、notification 和 server request。
- 无法解析的 stdout 行、stderr、进程启动、退出、超时、取消及记录器状态。

原始回调是旁路能力；现有 Workflow 和 Configured Agent 未传入回调时行为不变。标准化的 `AgentEvent` 继续供对话和实时时间线使用，但不能代替原始记录，因为当前标准化过程会裁剪部分工具参数和结果。

### Codex rollout

拿到 thread ID 后，通过现有 Codex Session 发现边界定位对应 rollout。观测服务读取与该 thread 对应的本地记录，补充并固化：

- `session_meta.base_instructions` 中的系统指令。
- developer/system 消息和动态工具定义。
- 原始 response items、event messages、usage 与 app-server 没有完整返回的本地事件。
- 可用 Skill 信息，以及能够从指令或实际工具读取中确认的 Skill 使用情况。

rollout 补全按源文件字节位置增量执行，并保存源指纹和读取游标。turn 完成、应用恢复未完成记录以及用户打开详情时都可以触发补全。观测服务不改写或删除 Codex 原始 rollout；补全得到的原始行和上下文快照复制到自己的记录目录，因此以后原始 rollout 被移动时，已采集的内容仍可查看。

如果 rollout 尚未生成，服务短暂重试并保留 `pending` 状态；最终仍无法定位时，RPC 记录继续可用，但会话标为 `incomplete`，页面明确指出缺少哪一来源。

## 展示内容

“上下文”视图按来源分组显示：

- System instructions。
- Developer instructions。
- 当前和历史 user prompts。
- 可用工具、MCP Server 与工具 schema。
- 可确认的 Skill 清单和实际 Skill 读取/调用；无法从 Codex 数据确认时不猜测。
- 模型、reasoning effort、工作目录、thread ID、turn ID、Codex 版本及 usage。

“时间线”视图按统一序号展示：

- thread/turn 生命周期。
- assistant 增量与最终消息。
- reasoning summary。
- tool call、参数、结果和耗时。
- MCP 启动状态、审批请求与选择。
- 子 Agent、协作或 subprocess 事件（仅在 Codex 实际发出对应事件时）。
- usage、错误、取消、进程退出和 rollout 补全状态。

“原始数据”视图提供 RPC 与 rollout 两个来源筛选，默认只加载事件摘要。选中单条后再读取完整 payload，支持复制。页面始终展示来源、方向、时间、序号、method/type 和是否经过凭证脱敏，避免把派生时间线误认为原始报文。

## 存储设计

PostgreSQL 只保存可查询的小型索引：

- 观测会话 ID、标题、工作目录、模型和 reasoning effort。
- thread ID、生命周期状态、创建/更新时间、最后错误和记录完整性。
- turn ID、用户输入、开始/结束时间、状态和 usage 摘要。
- 记录目录的相对标识，不保存任意绝对记录路径。

高容量内容保存在 Electron `userData` 下的专用目录，而不是仓库、`~/.codex` 或通用 Session 数据目录：

```text
<userData>/observability/codex/<observation-session-id>/
├── manifest.json
├── journal.jsonl
├── timeline.jsonl
├── rollout.jsonl
└── blobs/
    └── <sha256>
```

- `journal.jsonl` 是原始 RPC、stderr 和生命周期事件的有序索引，包含 schema version、单调递增序号、时间、方向、turn 和 payload 引用。
- 大 payload 先按内容哈希写入 blob，再追加 journal 引用；journal 不引用尚未成功写入的 blob。
- `rollout.jsonl` 保存已复制的原始 rollout 行与源游标。
- `timeline.jsonl` 是可重建的派生缓存，用于快速加载 UI，不是完整性的唯一依据。
- `manifest.json` 保存格式版本、记录完整性、已脱敏字段统计和最近成功 flush 位置，使用临时文件加原子替换更新。

写入器同步分配序号，通过单会话串行队列保证顺序，并在 turn 完成、停止、删除和应用退出时进行有界 flush。写盘失败后不继续宣称“完整记录”：服务尽力取消当前 turn，将内存状态标为 `incomplete`，页面持续显示记录故障。恢复后只能继续新的 turn，不能把已丢失的区间标回完整。

读取接口按序号分页，renderer 不一次性加载整个 JSONL 或大型 payload。删除会话需要确认，先停止该服务拥有的运行进程，再删除数据库索引和专用记录目录；不删除 Codex 原始 rollout，也不影响普通 Session 数据。

## 数据安全

原始记录可能包含源码、命令、文件内容和工具输出。首次进入页面展示本地记录说明，并在会话详情持续显示记录大小和删除入口。

持久化前统一清理结构化凭证字段，包括但不限于 `authorization`、`x-api-key`、`api_key`、`access_token`、`refresh_token`、`cookie` 和 `set-cookie`。环境变量对象不整体写入记录，Codex auth 文件和 Provider 配置不进入 payload。工具参数与工具输出原则上原样保留，因为它们是观测目标；页面提醒其中可能包含项目敏感信息。

Renderer 只能通过白名单 IPC 读取指定观测会话目录内的数据。主进程校验会话 ID、turn ID、分页范围和 blob hash，不接受 renderer 传入的任意文件路径。记录不会自动上传、进入遥测或交给摘要模型。

## IPC 与实时更新

Preload 暴露最小化的观测 API：

- 列出、读取、创建、重命名和删除观测会话。
- 发送消息、取消 turn、停止或继续会话。
- 响应审批。
- 分页读取时间线、原始事件和单个 payload。
- 订阅会话状态、增量文本和新事件通知。

主进程是状态真源。Renderer 重新挂载或从其他页面返回时，先读取会话快照，再从最后序号订阅增量；检测到序号缺口时重新分页补齐，而不是依赖一次性事件保证正确性。

## 错误与恢复

- Codex 不可执行：会话不进入 running，展示可操作错误，不修改 Provider 或回退到远程 SDK。
- app-server 初始化失败：保存启动和 stderr 记录，关闭残留进程。
- 单次 turn 失败：保留之前的 thread 和所有已写记录，允许用户重试或继续。
- 审批页面暂时不可见：会话保持 `awaiting_approval`，重新进入页面后仍可处理；应用退出则取消 turn。
- app-server 意外退出：记录退出码和 signal，活跃 turn 标为 error；后续可用 `thread/resume` 继续。
- 应用异常退出：下次启动将数据库中 running/awaiting_approval 的 turn 标为 interrupted，并根据本地 rollout 尝试最后一次补全。
- 数据库索引与记录目录不一致：保留可恢复一侧并展示 incomplete；不静默删除文件或伪造成功记录。

## 平台与范围

- 首版只修改 V2。V1 没有 app-server Agent 执行、审批和顶部功能页框架；这不是 V1/V2 共有的 Session 清理、发现或索引行为。
- 普通 Session 发现逻辑保持不变。Codex 生成的 rollout 若被现有索引器发现，仍可能像其他 Codex 会话一样出现在 Session 页面，但专用观测 journal 不进入普通 Session 索引。
- macOS 和 Windows 都通过现有 CLI 路径解析与无 shell 的 spawn 边界启动 Codex；文件位置基于 `app.getPath("userData")`，不硬编码 `/Users`、盘符或 POSIX 命令。
- 进程终止覆盖 POSIX signal 和 Windows 进程树，且必须以观测服务持有的确切进程为目标。

## 验证

- 主进程测试使用临时 `HOME`、临时 `userData`、临时 `CODEX_HOME`、合成 rollout 和伪 app-server，不读取或改写开发者真实的 Codex、Session、Skills 或 Electron 数据。
- 覆盖双向 RPC 在标准化前落盘、敏感字段脱敏、blob 先于 journal、序号顺序、分页读取、rollout 增量补全、重启恢复和记录失败后标记 incomplete。
- 覆盖 macOS/POSIX 与 Windows 路径、可执行文件解析和精确进程终止分支，不在测试中启动或结束真实 Codex。
- 不新增 renderer 回归测试；通过类型检查、V2 构建和真实页面手工验证布局、实时增量、审批、停止、恢复、删除及 Raw payload 按需加载。
- 手工验证至少运行一个真实多轮 Codex 会话，确认 system/developer/user、工具与 Skill、RPC、rollout、usage、thread/turn 和错误状态能按来源展示。
- 运行 `npm run release-note:check`。实现分支只增加一份 `.release-notes/codex-observability.md`，用用户语言描述新增的本地 Codex 观测能力。
