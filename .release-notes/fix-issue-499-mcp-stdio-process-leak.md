# 修复 MCP Gateway 进程泄漏

<!-- release-target: v2 -->

## Bug 修复

- 修复宿主客户端退出后 Gateway / Workflow stdio MCP 进程残留的问题：stdin 关闭或管道中断时，服务会在给在途请求留出有限的收尾窗口（默认 5 秒，可用 `AGENT_RECALL_MCP_SHUTDOWN_DRAIN_MS` 调整）后自行退出，并响应 SIGTERM / SIGINT 信号（#499 问题 2）。
