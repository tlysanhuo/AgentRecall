# 修复持久化目录下的远程会话状态

<!-- release-target: both -->

## Bug 修复

- 使用符号链接或 NFS 持久化 Codex、Claude Code 数据目录时，AgentRecall 现在能正确识别正在运行的远程会话，不再把当前会话误显示为 Closed 或关联到旧会话。
