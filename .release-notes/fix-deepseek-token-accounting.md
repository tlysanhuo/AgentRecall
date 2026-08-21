# DeepSeek Harness Token 统计修复

<!-- release-target: both -->

## Bug 修复

- DeepSeek Harness 会话现在会正确区分缓存写入、缓存读取和推理 Token，并完整统计不同会话与各轮用量，避免遗漏或重复。
