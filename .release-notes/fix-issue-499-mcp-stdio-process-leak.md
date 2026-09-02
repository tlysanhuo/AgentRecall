# 修复 MCP Gateway 进程泄漏

<!-- release-target: v2 -->

## Bug 修复

- 修复宿主客户端(如 Codex、Claude Code)退出后 Gateway / Workflow MCP 进程残留、随时间不断累积的问题:这些进程现在会在收尾后自行退出,不再长期占用系统资源。
