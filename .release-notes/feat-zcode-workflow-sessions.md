# ZCode Workflow 任务会话修复

<!-- release-target: both -->

## Bug 修复

- 🧩 ZCode 中由 Workflow 发起的任务会话不再作为独立会话出现在列表中,现在会正确归属到其发起会话;统计与跨设备同步也不再重复计算。旧版本数据不受影响。
