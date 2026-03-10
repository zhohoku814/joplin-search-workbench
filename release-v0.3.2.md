# v0.3.2 Release

## 中文

`Search Workbench / 搜索工作台` 的这一版聚焦于结构化整理，而不是打补丁。

### 这次更新

- 引入统一的 `i18n` 消息架构
- 补齐中英双语界面文案
- 增加 `Reset Filters / 重置筛选`
- 增加 `Clear All / 全部清空`
- 用 `Advanced Filters / 高级筛选` 折叠区重构面板密度，扩大结果可视区域
- README、插件 manifest、发布文案统一改为中英双语

### 设计原则

- 保持现有稳定搜索 / 索引行为不被破坏
- 不用零散补丁，而是统一抽离 messages 并集中处理文案
- 把高频搜索动作和低频筛选条件分层显示，避免界面长期拥挤

---

## English

This release of `Search Workbench / 搜索工作台` focuses on structural cleanup rather than one-off patches.

### What's new

- Shared `i18n` message architecture
- Complete bilingual Chinese / English UI copy
- Added `Reset Filters`
- Added `Clear All`
- Reworked panel density with a collapsible `Advanced Filters` section so the results area stays larger
- README, plugin manifest, and release copy are now bilingual

### Design goals

- Preserve the existing stable search / index behavior
- Avoid scattered patching by centralizing UI copy in shared messages
- Separate high-frequency search actions from lower-frequency filters so the panel stays readable
