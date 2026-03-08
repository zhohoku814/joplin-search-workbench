import joplin from 'api';
import {
	MenuItemLocation,
	ToolbarButtonLocation,
	ToastType,
	ModelType,
	SettingItemType,
	SettingStorage,
} from 'api/types';

const uslug = require('@joplin/fork-uslug');

const PANEL_ID = 'searchWorkbench.panel';
const SETTINGS_SECTION = 'searchWorkbench';
const SETTINGS_STATS = 'searchWorkbench.noteStats';
const PAGE_SIZE = 100;
const MAX_RESULTS = 200;

type SearchMode = 'smart' | 'literal' | 'regex';
type SearchScope = 'all' | 'title' | 'body';
type SortBy = 'relevance' | 'updated' | 'created' | 'lastViewed' | 'usageCount' | 'title' | 'bodyLength';
type SortDir = 'desc' | 'asc';
type GroupBy = 'none' | 'folder' | 'updatedMonth' | 'noteType';
type DateField = 'updated' | 'created' | 'lastViewed';
type NoteTypeFilter = 'all' | 'note' | 'todo';
type BlockType = 'title' | 'heading' | 'code' | 'quote' | 'task' | 'list' | 'table' | 'paragraph';

interface NoteStats {
	usageCount: number;
	lastViewed: number;
}

interface CachedFolder {
	id: string;
	title: string;
	parent_id?: string;
	path: string;
}

interface LineMeta {
	lineNumber: number;
	sectionText: string;
	sectionSlug: string;
	inCodeFence: boolean;
}

interface CachedNote {
	id: string;
	title: string;
	body: string;
	parent_id: string;
	updated_time: number;
	created_time: number;
	is_todo: number;
	todo_completed: number;
	folderPath: string;
	lines: string[];
	lineMeta: LineMeta[];
	bodyLength: number;
}

interface SearchRequest {
	query: string;
	mode: SearchMode;
	scope: SearchScope;
	caseSensitive: boolean;
	noteType: NoteTypeFilter;
	notebookQuery: string;
	dateField: DateField;
	dateFrom: string;
	dateTo: string;
	sortBy: SortBy;
	sortDir: SortDir;
	groupBy: GroupBy;
}

interface SearchSnippet {
	text: string;
	line: number;
	blockType: BlockType;
	sectionText: string;
	sectionSlug: string;
	highlights: string[];
}

interface SearchResult {
	noteId: string;
	title: string;
	folderPath: string;
	noteType: 'note' | 'todo';
	updatedTime: number;
	createdTime: number;
	lastViewed: number;
	usageCount: number;
	bodyLength: number;
	score: number;
	snippets: SearchSnippet[];
}

interface SearchResponse {
	request: SearchRequest;
	statusText: string;
	resultCount: number;
	groups: Array<{
		key: string;
		label: string;
		items: SearchResult[];
	}>;
}

interface SmartTokens {
	tokens: string[];
	phrases: string[];
}

let panelHandle: any = null;
let cachedFolders: CachedFolder[] = [];
let cachedNotes: CachedNote[] = [];
let cacheDirty = true;
let isIndexing = false;
let lastSearchRequest: SearchRequest = {
	query: '',
	mode: 'smart',
	scope: 'all',
	caseSensitive: false,
	noteType: 'all',
	notebookQuery: '',
	dateField: 'updated',
	dateFrom: '',
	dateTo: '',
	sortBy: 'relevance',
	sortDir: 'desc',
	groupBy: 'none',
};
let noteStats: Record<string, NoteStats> = {};
let saveStatsTimer: NodeJS.Timeout | null = null;
let lastSelectedNoteId = '';
let backgroundReindexTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function normaliseNewlines(text: string): string {
	return (text || '').replace(/\r\n/g, '\n');
}

function escapeHtml(text: string): string {
	return (text || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function formatDateLabel(ts: number): string {
	if (!ts) return '—';
	return new Date(ts).toLocaleString();
}

function blockTypeLabel(blockType: BlockType): string {
	switch (blockType) {
		case 'title': return '标题';
		case 'heading': return '标题段';
		case 'code': return '代码块';
		case 'quote': return '引用';
		case 'task': return '任务';
		case 'list': return '列表';
		case 'table': return '表格';
		default: return '正文';
	}
}

function createPanelHtml(): string {
	return `
		<div class="sw-root">
			<div class="sw-header">
				<div>
					<div class="sw-title">Search Workbench</div>
					<div class="sw-subtitle">像 VS Code 一样先看内容，再决定进不进去</div>
				</div>
				<div class="sw-header-actions">
					<button id="refreshIndexBtn" class="sw-btn secondary">重建索引</button>
				</div>
			</div>

			<div class="sw-form">
				<div class="sw-row query-row">
					<input id="queryInput" class="sw-input" type="text" placeholder="搜正文、标题、代码块、引用、Markdown 标记...">
					<button id="searchBtn" class="sw-btn">搜索</button>
				</div>

				<div class="sw-row compact-grid">
					<label><span>模式</span><select id="modeSelect" class="sw-select">
						<option value="smart">智能</option>
						<option value="literal">精确文本</option>
						<option value="regex">正则</option>
					</select></label>
					<label><span>范围</span><select id="scopeSelect" class="sw-select">
						<option value="all">标题 + 正文</option>
						<option value="title">仅标题</option>
						<option value="body">仅正文</option>
					</select></label>
					<label><span>排序</span><select id="sortBySelect" class="sw-select">
						<option value="relevance">相关度</option>
						<option value="updated">更改日期</option>
						<option value="created">创建日期</option>
						<option value="lastViewed">上次查看</option>
						<option value="usageCount">使用次数</option>
						<option value="title">标题</option>
						<option value="bodyLength">笔记长度</option>
					</select></label>
					<label><span>顺序</span><select id="sortDirSelect" class="sw-select">
						<option value="desc">降序</option>
						<option value="asc">升序</option>
					</select></label>
					<label><span>分组</span><select id="groupBySelect" class="sw-select">
						<option value="none">不分组</option>
						<option value="folder">按笔记本</option>
						<option value="updatedMonth">按更新时间月份</option>
						<option value="noteType">按笔记类型</option>
					</select></label>
				</div>

				<div class="sw-row compact-grid">
					<label><span>笔记本筛选</span><input id="notebookInput" class="sw-input" type="text" placeholder="模糊匹配路径"></label>
					<label><span>笔记类型</span><select id="noteTypeSelect" class="sw-select">
						<option value="all">全部</option>
						<option value="note">普通笔记</option>
						<option value="todo">待办笔记</option>
					</select></label>
					<label><span>时间字段</span><select id="dateFieldSelect" class="sw-select">
						<option value="updated">更改日期</option>
						<option value="created">创建日期</option>
						<option value="lastViewed">上次查看</option>
					</select></label>
					<label><span>开始</span><input id="dateFromInput" class="sw-input" type="date"></label>
					<label><span>结束</span><input id="dateToInput" class="sw-input" type="date"></label>
				</div>

				<div class="sw-row check-row">
					<label class="check-item"><input id="caseSensitiveInput" type="checkbox"> 区分大小写</label>
				</div>
			</div>

			<div class="sw-status">
				<div id="statusText">准备就绪</div>
				<div id="metaText"></div>
			</div>

			<div id="resultsRoot" class="sw-results"></div>
		</div>
	`;
}

async function showToast(message: string) {
	await joplin.views.dialogs.showToast({ message, type: ToastType.Info });
}

async function postPanelMessage(message: any) {
	if (!panelHandle) return;
	try {
		joplin.views.panels.postMessage(panelHandle, message);
	} catch (_error) {
		// Ignore.
	}
}

function buildFolderPaths(folders: Array<{ id: string; title: string; parent_id?: string }>): CachedFolder[] {
	const byId = new Map<string, { id: string; title: string; parent_id?: string }>();
	for (const folder of folders) byId.set(folder.id, folder);

	const cache = new Map<string, string>();
	const folderPath = (folderId: string): string => {
		if (!folderId) return '未分类';
		if (cache.has(folderId)) return cache.get(folderId) as string;
		const folder = byId.get(folderId);
		if (!folder) return '未知笔记本';
		const parentPath = folder.parent_id ? folderPath(folder.parent_id) : '';
		const path = parentPath ? `${parentPath} / ${folder.title}` : folder.title;
		cache.set(folderId, path);
		return path;
	};

	return folders.map(folder => ({
		id: folder.id,
		title: folder.title,
		parent_id: folder.parent_id,
		path: folderPath(folder.id),
	}));
}

async function fetchAll<T = any>(path: string[], fields: string[] = []): Promise<T[]> {
	let page = 1;
	const output: T[] = [];

	while (true) {
		const response = await joplin.data.get(path, { fields, limit: PAGE_SIZE, page });
		if (Array.isArray(response)) {
			output.push(...response);
			break;
		}
		if (response?.items) {
			output.push(...response.items);
			if (!response.has_more) break;
			page += 1;
			continue;
		}
		break;
	}

	return output;
}

function buildLineMeta(body: string): { lines: string[]; lineMeta: LineMeta[] } {
	const lines = normaliseNewlines(body).split('\n');
	const lineMeta: LineMeta[] = [];
	let inCodeFence = false;
	let sectionText = '';
	let sectionSlug = '';

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] || '';
		const headingMatch = !inCodeFence ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
		if (headingMatch) {
			sectionText = headingMatch[2].trim();
			sectionSlug = uslug(sectionText);
		}
		lineMeta.push({
			lineNumber: i + 1,
			sectionText,
			sectionSlug,
			inCodeFence,
		});
		if (/^```/.test(line.trim())) inCodeFence = !inCodeFence;
	}

	return { lines, lineMeta };
}

function detectBlockType(lines: string[], meta: LineMeta[], index: number): BlockType {
	const line = lines[index] || '';
	const trimmed = line.trim();
	if (index === 0 && trimmed.length && !/^#{1,6}\s/.test(trimmed)) return 'paragraph';
	if (/^(#{1,6})\s+/.test(trimmed)) return 'heading';
	if (meta[index]?.inCodeFence || /^```/.test(trimmed)) return 'code';
	if (/^>\s?/.test(trimmed)) return 'quote';
	if (/^[-*+]\s+\[[ xX]\]/.test(trimmed) || /^\d+\.\s+\[[ xX]\]/.test(trimmed)) return 'task';
	if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) return 'list';
	if (/^\|.*\|$/.test(trimmed)) return 'table';
	return 'paragraph';
}

function parseSmartTokens(query: string): SmartTokens {
	const tokens: string[] = [];
	const phrases: string[] = [];
	const regex = /"([^"]+)"|(\S+)/g;
	let match: RegExpExecArray | null = null;
	while ((match = regex.exec(query)) !== null) {
		const value = (match[1] || match[2] || '').trim();
		if (!value) continue;
		tokens.push(value);
		if (match[1]) phrases.push(value);
	}
	return { tokens, phrases };
}

function toComparable(text: string, caseSensitive: boolean): string {
	return caseSensitive ? text : text.toLowerCase();
}

function literalOccurrences(text: string, needle: string, caseSensitive: boolean): number {
	if (!needle) return 0;
	const haystack = toComparable(text, caseSensitive);
	const target = toComparable(needle, caseSensitive);
	let count = 0;
	let position = 0;
	while (true) {
		const found = haystack.indexOf(target, position);
		if (found < 0) break;
		count += 1;
		position = found + Math.max(1, target.length);
	}
	return count;
}

function safeRegex(query: string, caseSensitive: boolean): RegExp | null {
	try {
		return new RegExp(query, caseSensitive ? 'g' : 'gi');
	} catch (_error) {
		return null;
	}
}

function matchText(text: string, request: SearchRequest): { matched: boolean; hits: number; highlights: string[] } {
	const query = request.query.trim();
	if (!query) return { matched: false, hits: 0, highlights: [] };

	if (request.mode === 'regex') {
		const regex = safeRegex(query, request.caseSensitive);
		if (!regex) return { matched: false, hits: 0, highlights: [] };
		const matches = text.match(regex) || [];
		return { matched: matches.length > 0, hits: matches.length, highlights: Array.from(new Set(matches)).slice(0, 10) };
	}

	if (request.mode === 'literal') {
		const hits = literalOccurrences(text, query, request.caseSensitive);
		return { matched: hits > 0, hits, highlights: hits ? [query] : [] };
	}

	const parsed = parseSmartTokens(query);
	if (!parsed.tokens.length) return { matched: false, hits: 0, highlights: [] };
	let hits = 0;
	for (const token of parsed.tokens) {
		const tokenHits = literalOccurrences(text, token, request.caseSensitive);
		if (!tokenHits) return { matched: false, hits: 0, highlights: [] };
		hits += tokenHits;
	}
	return { matched: hits > 0, hits, highlights: parsed.tokens.slice(0, 10) };
}

function extractSnippets(note: CachedNote, request: SearchRequest): SearchSnippet[] {
	const snippets: SearchSnippet[] = [];
	const seenLines = new Set<number>();
	const includeTitle = request.scope !== 'body';
	const includeBody = request.scope !== 'title';

	if (includeTitle) {
		const titleMatch = matchText(note.title, request);
		if (titleMatch.matched) {
			snippets.push({
				text: note.title,
				line: 0,
				blockType: 'title',
				sectionText: '',
				sectionSlug: '',
				highlights: titleMatch.highlights,
			});
		}
	}

	if (!includeBody) return snippets;

	for (let i = 0; i < note.lines.length && snippets.length < 4; i += 1) {
		const line = note.lines[i];
		const lineMatch = matchText(line, request);
		if (!lineMatch.matched || seenLines.has(i)) continue;
		seenLines.add(i);
		const parts = [note.lines[i - 1], line, note.lines[i + 1]].filter(Boolean).map(s => (s || '').trim()).filter(Boolean);
		const text = parts.join(' ⏎ ');
		const meta = note.lineMeta[i];
		snippets.push({
			text,
			line: i + 1,
			blockType: detectBlockType(note.lines, note.lineMeta, i),
			sectionText: meta?.sectionText || '',
			sectionSlug: meta?.sectionSlug || '',
			highlights: lineMatch.highlights,
		});
	}

	return snippets;
}

function scoreResult(note: CachedNote, request: SearchRequest, snippets: SearchSnippet[]): number {
	const titleMatch = matchText(note.title, request);
	const bodyMatch = matchText(note.body, request);
	let score = 0;
	if (titleMatch.matched) score += 120 + titleMatch.hits * 18;
	if (bodyMatch.matched) score += 40 + bodyMatch.hits * 6;
	if (request.mode === 'literal' && request.query && literalOccurrences(note.title, request.query, request.caseSensitive)) score += 50;
	if (request.mode === 'smart') {
		const phrases = parseSmartTokens(request.query).phrases;
		for (const phrase of phrases) {
			score += literalOccurrences(note.title, phrase, request.caseSensitive) * 30;
			score += literalOccurrences(note.body, phrase, request.caseSensitive) * 10;
		}
	}
	if (snippets.length) score += Math.max(0, 20 - snippets[0].line);
	return score;
}

function withinDateRange(value: number, from: string, to: string): boolean {
	if (!from && !to) return true;
	if (!value) return false;
	const current = new Date(value).getTime();
	if (from) {
		const fromTs = new Date(`${from}T00:00:00`).getTime();
		if (current < fromTs) return false;
	}
	if (to) {
		const toTs = new Date(`${to}T23:59:59`).getTime();
		if (current > toTs) return false;
	}
	return true;
}

function noteMatchesFilters(note: CachedNote, request: SearchRequest): boolean {
	if (request.noteType === 'note' && note.is_todo) return false;
	if (request.noteType === 'todo' && !note.is_todo) return false;
	if (request.notebookQuery.trim()) {
		const folderHaystack = note.folderPath.toLowerCase();
		if (!folderHaystack.includes(request.notebookQuery.trim().toLowerCase())) return false;
	}
	let dateValue = 0;
	if (request.dateField === 'created') dateValue = note.created_time;
	if (request.dateField === 'updated') dateValue = note.updated_time;
	if (request.dateField === 'lastViewed') dateValue = noteStats[note.id]?.lastViewed || 0;
	if (!withinDateRange(dateValue, request.dateFrom, request.dateTo)) return false;
	return true;
}

function compareResults(a: SearchResult, b: SearchResult, sortBy: SortBy, sortDir: SortDir): number {
	const direction = sortDir === 'asc' ? 1 : -1;
	let left: number | string = 0;
	let right: number | string = 0;
	if (sortBy === 'relevance') {
		left = a.score;
		right = b.score;
	} else if (sortBy === 'updated') {
		left = a.updatedTime;
		right = b.updatedTime;
	} else if (sortBy === 'created') {
		left = a.createdTime;
		right = b.createdTime;
	} else if (sortBy === 'lastViewed') {
		left = a.lastViewed;
		right = b.lastViewed;
	} else if (sortBy === 'usageCount') {
		left = a.usageCount;
		right = b.usageCount;
	} else if (sortBy === 'bodyLength') {
		left = a.bodyLength;
		right = b.bodyLength;
	} else {
		left = a.title.toLowerCase();
		right = b.title.toLowerCase();
	}
	if (left < right) return -1 * direction;
	if (left > right) return 1 * direction;
	return (b.score - a.score);
}

function groupLabel(result: SearchResult, groupBy: GroupBy): { key: string; label: string } {
	if (groupBy === 'folder') return { key: result.folderPath || '未知笔记本', label: result.folderPath || '未知笔记本' };
	if (groupBy === 'noteType') return { key: result.noteType, label: result.noteType === 'todo' ? '待办笔记' : '普通笔记' };
	if (groupBy === 'updatedMonth') {
		const date = result.updatedTime ? new Date(result.updatedTime) : null;
		const key = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : '未修改';
		return { key, label: key };
	}
	return { key: 'all', label: '搜索结果' };
}

function searchNotes(request: SearchRequest): SearchResponse {
	const query = request.query.trim();
	if (!query) {
		return {
			request,
			statusText: '请输入搜索词。支持智能 / 精确文本 / 正则。',
			resultCount: 0,
			groups: [],
		};
	}

	if (request.mode === 'regex' && !safeRegex(query, request.caseSensitive)) {
		return {
			request,
			statusText: '正则表达式无效，请检查写法。',
			resultCount: 0,
			groups: [],
		};
	}

	const results: SearchResult[] = [];
	for (const note of cachedNotes) {
		if (!noteMatchesFilters(note, request)) continue;

		const titleText = request.scope === 'body' ? '' : note.title;
		const bodyText = request.scope === 'title' ? '' : note.body;
		const matched = (titleText && matchText(titleText, request).matched) || (bodyText && matchText(bodyText, request).matched);
		if (!matched) continue;

		const snippets = extractSnippets(note, request);
		if (!snippets.length) continue;

		const stats = noteStats[note.id] || { usageCount: 0, lastViewed: 0 };
		results.push({
			noteId: note.id,
			title: note.title,
			folderPath: note.folderPath,
			noteType: note.is_todo ? 'todo' : 'note',
			updatedTime: note.updated_time,
			createdTime: note.created_time,
			lastViewed: stats.lastViewed || 0,
			usageCount: stats.usageCount || 0,
			bodyLength: note.bodyLength,
			score: scoreResult(note, request, snippets),
			snippets,
		});
	}

	results.sort((a, b) => compareResults(a, b, request.sortBy, request.sortDir));
	const limited = results.slice(0, MAX_RESULTS);
	const groupedMap = new Map<string, { key: string; label: string; items: SearchResult[] }>();
	for (const result of limited) {
		const group = groupLabel(result, request.groupBy);
		if (!groupedMap.has(group.key)) groupedMap.set(group.key, { key: group.key, label: group.label, items: [] });
		groupedMap.get(group.key)?.items.push(result);
	}

	const groups = Array.from(groupedMap.values());
	return {
		request,
		statusText: results.length > MAX_RESULTS ? `命中 ${results.length} 条，已显示前 ${MAX_RESULTS} 条。` : `命中 ${results.length} 条。`,
		resultCount: results.length,
		groups,
	};
}

async function loadStats() {
	const stored = await joplin.settings.value(SETTINGS_STATS);
	noteStats = stored && typeof stored === 'object' ? stored : {};
}

function scheduleSaveStats() {
	if (saveStatsTimer) clearTimeout(saveStatsTimer);
	saveStatsTimer = setTimeout(async () => {
		await joplin.settings.setValue(SETTINGS_STATS, noteStats);
	}, 500);
}

async function recordSelectedNoteUsage() {
	const note = await joplin.workspace.selectedNote();
	if (!note?.id || note.id === lastSelectedNoteId) return;
	lastSelectedNoteId = note.id;
	const current = noteStats[note.id] || { usageCount: 0, lastViewed: 0 };
	noteStats[note.id] = {
		usageCount: current.usageCount + 1,
		lastViewed: Date.now(),
	};
	scheduleSaveStats();
}

async function rebuildIndex(reason = '手动刷新') {
	if (isIndexing) return;
	isIndexing = true;
	await postPanelMessage({ type: 'status', text: `正在重建索引（${reason}）...` });
	try {
		const folders = await fetchAll<Array<{ id: string; title: string; parent_id?: string }>[number]>(['folders'], ['id', 'title', 'parent_id']);
		cachedFolders = buildFolderPaths(folders);
		const folderMap = new Map<string, string>(cachedFolders.map(folder => [folder.id, folder.path]));

		const notes = await fetchAll<Array<any>[number]>(['notes'], ['id', 'title', 'body', 'parent_id', 'updated_time', 'created_time', 'is_todo', 'todo_completed']);
		cachedNotes = notes.map(note => {
			const body = normaliseNewlines(note.body || '');
			const parsed = buildLineMeta(body);
			return {
				id: note.id,
				title: note.title || '(无标题)',
				body,
				parent_id: note.parent_id || '',
				updated_time: note.updated_time || 0,
				created_time: note.created_time || 0,
				is_todo: note.is_todo || 0,
				todo_completed: note.todo_completed || 0,
				folderPath: folderMap.get(note.parent_id) || '未知笔记本',
				lines: parsed.lines,
				lineMeta: parsed.lineMeta,
				bodyLength: body.length,
			} as CachedNote;
		});

		cacheDirty = false;
		await postPanelMessage({ type: 'status', text: `索引已就绪：${cachedNotes.length} 篇笔记。` });
	} finally {
		isIndexing = false;
	}
}

function scheduleBackgroundReindex(reason = '内容变化') {
	cacheDirty = true;
	if (backgroundReindexTimer) clearTimeout(backgroundReindexTimer);
	backgroundReindexTimer = setTimeout(async () => {
		await rebuildIndex(reason);
		if (lastSearchRequest.query.trim()) {
			const response = searchNotes(lastSearchRequest);
			await postPanelMessage({ type: 'results', payload: response });
		}
	}, 1200);
}

async function ensureIndexReady() {
	if (cacheDirty || !cachedNotes.length) {
		await rebuildIndex(cacheDirty ? '自动更新' : '初始化');
	}
}

async function openResult(noteId: string, sectionSlug: string, line: number) {
	let opened = false;
	try {
		await joplin.commands.execute('openNote', noteId);
		opened = true;
	} catch (_error) {
		try {
			await joplin.commands.execute('openItem', noteId);
			opened = true;
		} catch (_error2) {
			opened = false;
		}
	}

	if (opened && sectionSlug) {
		await sleep(120);
		try {
			await joplin.commands.execute('scrollToHash', sectionSlug);
		} catch (_error) {
			// Ignore.
		}
	}

	if (!opened) {
		await showToast('没有成功打开目标笔记，可能是当前 Joplin 版本的内部命令名不同。');
		return;
	}

	await showToast(line > 0 ? `已打开，命中在第 ${line} 行附近` : '已打开目标笔记');
}

async function runSearch(request: SearchRequest) {
	lastSearchRequest = request;
	await ensureIndexReady();
	const response = searchNotes(request);
	await postPanelMessage({ type: 'results', payload: response });
}

joplin.plugins.register({
	onStart: async function() {
		await joplin.settings.registerSection(SETTINGS_SECTION, {
			label: 'Search Workbench',
			iconName: 'fas fa-search',
			description: 'Search Workbench 的内部数据。使用次数和上次查看会从插件安装后开始累计。',
		});

		await joplin.settings.registerSettings({
			[SETTINGS_STATS]: {
				value: {},
				type: SettingItemType.Object,
				public: false,
				section: SETTINGS_SECTION,
				storage: SettingStorage.File,
				label: 'Note stats cache',
			},
		});

		await loadStats();

		panelHandle = await joplin.views.panels.create(PANEL_ID);

		await joplin.views.panels.onMessage(panelHandle, async (message: any) => {
			if (message?.type === 'ready') {
				await postPanelMessage({ type: 'init', payload: { request: lastSearchRequest } });
				await ensureIndexReady();
				return;
			}
			if (message?.type === 'search') {
				await runSearch({ ...lastSearchRequest, ...message.payload });
				return;
			}
			if (message?.type === 'refreshIndex') {
				cacheDirty = true;
				await rebuildIndex('手动刷新');
				if (lastSearchRequest.query.trim()) await runSearch(lastSearchRequest);
				return;
			}
			if (message?.type === 'openResult') {
				await openResult(message.payload.noteId, message.payload.sectionSlug, message.payload.line);
			}
		});

		await joplin.views.panels.setHtml(panelHandle, createPanelHtml());
		await joplin.views.panels.addScript(panelHandle, './webview.css');
		await joplin.views.panels.addScript(panelHandle, './webview.js');

		await joplin.commands.register({
			name: 'searchWorkbench.togglePanel',
			label: '显示/隐藏 Search Workbench',
			iconName: 'fas fa-search',
			execute: async () => {
				const visible = await joplin.views.panels.visible(panelHandle);
				await joplin.views.panels.show(panelHandle, !visible);
			},
		});

		await joplin.commands.register({
			name: 'searchWorkbench.refreshIndex',
			label: '重建 Search Workbench 索引',
			iconName: 'fas fa-rotate',
			execute: async () => {
				cacheDirty = true;
				await rebuildIndex('命令触发');
				if (lastSearchRequest.query.trim()) await runSearch(lastSearchRequest);
			},
		});

		await joplin.views.toolbarButtons.create('searchWorkbenchToggleButton', 'searchWorkbench.togglePanel', ToolbarButtonLocation.NoteToolbar);
		await joplin.views.menuItems.create('searchWorkbenchToggleMenu', 'searchWorkbench.togglePanel', MenuItemLocation.Tools);
		await joplin.views.menuItems.create('searchWorkbenchRefreshMenu', 'searchWorkbench.refreshIndex', MenuItemLocation.Tools);

		await joplin.workspace.onNoteSelectionChange(async () => {
			await recordSelectedNoteUsage();
		});

		await joplin.workspace.onNoteChange(async () => {
			scheduleBackgroundReindex('笔记变化');
		});

		await joplin.workspace.onSyncComplete(async () => {
			scheduleBackgroundReindex('同步完成');
		});

		await rebuildIndex('初始化');
		await recordSelectedNoteUsage();
		await joplin.views.panels.show(panelHandle, true);
	},
});
