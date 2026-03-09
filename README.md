# Joplin Search Workbench

A VS Code-style search workbench for Joplin with snippets, highlighting, grouping, sorting, regex, and date filters.

## Features

- Full-note search with result snippets
- Match highlighting in titles and snippets
- Search modes: smart, literal, regex
- Scope filters for title/body/all
- Grouping and sorting options
- Notebook filter and note-type filter
- Date-based filtering
- Index status and search status feedback
- Click a snippet to jump into the target note

## Why this plugin exists

Joplin's built-in search is fast, but sometimes you want a more inspectable workflow: preview nearby context, compare multiple matches, and choose the exact note and section before opening it. Search Workbench is built for that style of searching.

## Install

### From release package

Download the latest `.jpl` file from the GitHub Releases page and install it in Joplin:

- `Tools` → `Options` → `Plugins`
- Click the gear icon
- Choose `Install from file`
- Select the downloaded `.jpl`
- Restart Joplin

## Usage

- Open **Search Workbench** from the toolbar or Tools menu
- Wait for the initial index to finish
- Enter a query and click **搜索**
- Click any snippet to open the note near the matched section
- Use **重建索引** when you want to force a fresh index rebuild

## Version

Current release: **0.3.1**

Milestone stability notes:

- `4c0aca2`: server-side rendering for results and runtime state
- `12e79f1`: scrolling fix without changing search/index behavior

## License

AGPL-3.0-or-later
