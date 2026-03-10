# Joplin Search Workbench / Joplin 搜索工作台

A VS Code-style search workbench for Joplin: preview context first, then decide which note to open.

适用于 Joplin 的 VS Code 风格搜索工作台：先看上下文，再决定打开哪篇笔记。

## Features / 功能

- Snippet-based search results with title + body preview  
  片段式搜索结果，支持标题 + 正文上下文预览
- Match highlighting in titles and snippets  
  标题与片段中的命中高亮
- Search modes: Smart / Literal / Regex  
  搜索模式：智能 / 精确文本 / 正则
- Scope filters for title / body / all  
  范围筛选：标题 / 正文 / 全部
- Sorting and grouping options  
  支持排序与分组
- Notebook filter, note-type filter, and date filters  
  支持笔记本筛选、笔记类型筛选与时间筛选
- **Advanced Filters** collapsible section to keep the visible result area large  
  通过可折叠的 **Advanced Filters / 高级筛选** 区域，提高结果可视空间
- **Reset Filters** keeps the current query and restores filter defaults  
  **Reset Filters / 重置筛选** 会保留当前搜索词，并恢复筛选默认值
- **Clear All** clears the whole form and returns the panel to a neutral state  
  **Clear All / 全部清空** 会清空整个搜索表单，并让面板回到中性状态
- Index status and search status feedback  
  提供索引状态与搜索状态反馈
- Click a snippet to jump into the target note  
  点击片段可跳转到目标笔记对应位置附近
- Built on a shared `i18n` message architecture for both Chinese and English UI copy  
  基于统一的 `i18n` 消息架构，支持中英文界面文案

## Why this plugin exists / 为什么做这个插件

Joplin's built-in search is fast, but sometimes you need a more inspectable workflow: compare multiple hits, read nearby context, and decide precisely where to go before opening the note.

Joplin 自带搜索很快，但有时你需要一种更可检查的工作流：先比较多个命中、阅读附近上下文，再决定准确进入哪篇笔记、哪个位置。

## Install / 安装

### From release package / 从 Release 安装

Download the latest `.jpl` from GitHub Releases, then install it in Joplin:

从 GitHub Releases 下载最新 `.jpl` 文件，然后在 Joplin 中安装：

- `Tools -> Options -> Plugins -> Install from file`
- `工具 -> 选项 -> 插件 -> 从文件安装`
- Select the downloaded `com.openclaw.searchWorkbench.jpl`
- 选择下载好的 `com.openclaw.searchWorkbench.jpl`
- Restart Joplin
- 重启 Joplin

## Usage / 使用说明

1. Open **Search Workbench / 搜索工作台** from the toolbar or Tools menu  
   通过工具栏按钮或工具菜单打开 **Search Workbench / 搜索工作台**
2. Wait for the initial index to finish  
   等待首次索引完成
3. Enter a query and click **Search / 搜索**  
   输入搜索词并点击 **Search / 搜索**
4. Expand **Advanced Filters / 高级筛选** when you need extra conditions  
   需要更多条件时展开 **Advanced Filters / 高级筛选**
5. Use **Reset Filters** to keep the query but restore filter defaults  
   使用 **Reset Filters** 保留搜索词并恢复筛选默认值
6. Use **Clear All** to clear the whole form  
   使用 **Clear All** 清空整个表单
7. Click any snippet to open the note near the matched section  
   点击任意片段，打开目标笔记并定位到命中位置附近
8. Use **Rebuild Index / 重建索引** when you want to force a fresh index  
   如需强制刷新索引，可使用 **Rebuild Index / 重建索引**

## Language / 语言

The plugin now uses a shared i18n message layer:

本插件现在使用统一的 i18n 消息层：

- `Auto / 自动` follows the Joplin app locale  
  `Auto / 自动` 会跟随 Joplin 应用语言
- `English` forces the English UI  
  `English` 会强制使用英文界面
- `简体中文` forces the Simplified Chinese UI  
  `简体中文` 会强制使用简体中文界面

## Version / 版本

Current release line: **0.3.2**

当前版本线：**0.3.2**

Recent milestones / 最近里程碑：

- `0.3.1`: stable milestone for server-rendered search/index state and scrolling layout  
  `0.3.1`：服务端渲染搜索/索引状态与滚动布局的稳定里程碑
- `0.3.2`: bilingual UI text, shared i18n, reset actions, and collapsible advanced filters  
  `0.3.2`：双语界面文案、统一 i18n、重置操作与可折叠高级筛选

## Development / 开发

```bash
npm install
npm test
npm run dist
```

## License / 许可证

AGPL-3.0-or-later
