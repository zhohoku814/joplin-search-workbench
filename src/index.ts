import joplin from '../api';
import {
	MenuItemLocation,
	ToolbarButtonLocation,
	ToastType,
	SettingItemType,
	SettingStorage,
} from '../api/types';

const uslug = require('@joplin/fork-uslug');
const {
	buildLineMeta,
	makeTaskProgress,
	normaliseNewlines,
	searchNotesWithProgress,
} = require('./searchCore');

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

interface RuntimeErrorEntry {
	stage: string;
	item: string;
	message: string;
}

let panelHandle: any = null;
let cachedFolders: CachedFolder[] = [];
let cachedNotes: CachedNote[] = [];
let cacheDirty = true;
let isIndexing = false;
let currentIndexPromise: Promise<void> | null = null;
let latestTaskStates: Record<string, any> = { index: null, search: null };
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
let searchRunId = 0;
let lastSearchResponse: any = null;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorMessage(error: any): string {
	if (!error) return '未知错误';
	if (typeof error === 'string') return error;
	if (error.message) return String(error.message);
	return String(error);
}

function pushRuntimeError(errors: RuntimeErrorEntry[], stage: string, item: string, error: any) {
	errors.push({ stage, item, message: toErrorMessage(error) });
	if (errors.length > 10) errors.splice(0, errors.length - 10);
}

function escapeHtml(text: string): string {
	return (text || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function escapeScriptJson(data: any): string {
	return JSON.stringify(data)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

function createPanelHtml(): string {
	const payload = escapeScriptJson({
		request: lastSearchRequest,
		response: lastSearchResponse,
		runtimes: latestTaskStates,
	});
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
				<div class="sw-status-main">
					<div id="statusText">准备就绪</div>
					<div id="statusDetail" class="sw-status-detail"></div>
				</div>
				<div id="metaText" class="sw-status-meta"></div>
			</div>

			<div id="runtimeRoot" class="sw-runtime-root"></div>
			<div id="resultsRoot" class="sw-results"></div>
		</div>
		<script id="initialState" type="application/json">${payload}</script>
	`;
}

async function showToast(message: string) {
	await joplin.views.dialogs.showToast({ message, type: ToastType.Info });
}

async function refreshPanel() {
	if (!panelHandle) return;
	await joplin.views.panels.setHtml(panelHandle, createPanelHtml());
}

async function emitRuntime(progress: any) {
	if (!progress?.kind) return;
	latestTaskStates = {
		...latestTaskStates,
		[progress.kind]: progress,
	};
	await refreshPanel();
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

async function countAllNotes(reason: string, errors: RuntimeErrorEntry[]): Promise<number> {
	let page = 1;
	let total = 0;
	while (true) {
		let response: any;
		try {
			response = await joplin.data.get(['notes'], { fields: ['id', 'title'], limit: PAGE_SIZE, page });
		} catch (error) {
			pushRuntimeError(errors, 'count-notes', `page:${page}`, error);
			throw new Error(`统计笔记总量失败（第 ${page} 页）：${toErrorMessage(error)}`);
		}

		const items = Array.isArray(response) ? response : (response?.items || []);
		total += items.length;
		const lastItem = items.length ? items[items.length - 1] : null;
		await emitRuntime(makeTaskProgress({
			kind: 'index',
			phase: 'count',
			state: 'running',
			statusText: `正在统计索引总量（${reason}）...`,
			detail: `已预扫 ${total} 篇笔记`,
			processed: total,
			total: 0,
			currentLabel: lastItem?.title || lastItem?.id || '',
			errors,
		}));

		if (Array.isArray(response) || !response?.has_more) break;
		page += 1;
	}
	return total;
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
	if (currentIndexPromise) return currentIndexPromise;

	const previousFolders = cachedFolders;
	const previousNotes = cachedNotes;
	currentIndexPromise = (async () => {
		isIndexing = true;
		const errors: RuntimeErrorEntry[] = [];

		try {
			await emitRuntime(makeTaskProgress({
				kind: 'index',
				phase: 'start',
				state: 'running',
				statusText: `准备重建索引（${reason}）...`,
				detail: '开始统计笔记总量',
				processed: 0,
				total: 0,
				errors,
			}));

			const totalNotes = await countAllNotes(reason, errors);
			await emitRuntime(makeTaskProgress({
				kind: 'index',
				phase: 'folders',
				state: 'running',
				statusText: `正在读取笔记本结构（${reason}）...`,
				detail: totalNotes ? `准备建立 ${totalNotes} 篇笔记的索引` : '没有发现笔记',
				processed: 0,
				total: totalNotes,
				errors,
			}));

			const folders = await fetchAll<Array<{ id: string; title: string; parent_id?: string }>[number]>(['folders'], ['id', 'title', 'parent_id']);
			const builtFolders = buildFolderPaths(folders);
			const folderMap = new Map<string, string>(builtFolders.map(folder => [folder.id, folder.path]));
			const builtNotes: CachedNote[] = [];

			let page = 1;
			let processed = 0;
			while (true) {
				let response: any;
				try {
					response = await joplin.data.get(['notes'], {
						fields: ['id', 'title', 'body', 'parent_id', 'updated_time', 'created_time', 'is_todo', 'todo_completed'],
						limit: PAGE_SIZE,
						page,
					});
				} catch (error) {
					pushRuntimeError(errors, 'fetch-note-page', `page:${page}`, error);
					throw new Error(`读取笔记内容失败（第 ${page} 页）：${toErrorMessage(error)}`);
				}

				const items = Array.isArray(response) ? response : (response?.items || []);
				for (const note of items) {
					try {
						const body = normaliseNewlines(note.body || '');
						const parsed = buildLineMeta(body, uslug);
						builtNotes.push({
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
						});
					} catch (error) {
						pushRuntimeError(errors, 'parse-note', note.title || note.id || '(未知笔记)', error);
					}

					processed += 1;
					if (processed === 1 || processed % 10 === 0 || processed === totalNotes) {
						await emitRuntime(makeTaskProgress({
							kind: 'index',
							phase: 'notes',
							state: 'running',
							statusText: `正在重建索引（${reason}）...`,
							detail: totalNotes ? `已建立 ${processed} / ${totalNotes} 篇笔记` : `已建立 ${processed} 篇笔记`,
							processed,
							total: totalNotes,
							currentLabel: note.title || note.id || '',
							errors,
						}));
					}
				}

				if (Array.isArray(response) || !response?.has_more) break;
				page += 1;
			}

			cachedFolders = builtFolders;
			cachedNotes = builtNotes;
			cacheDirty = false;
			await emitRuntime(makeTaskProgress({
				kind: 'index',
				phase: 'done',
				state: errors.length ? 'warning' : 'done',
				statusText: `索引已就绪：${builtNotes.length} 篇笔记。`,
				detail: errors.length ? `完成，但有 ${errors.length} 条索引问题（下方显示最近错误）` : '索引建立完成',
				processed: totalNotes || builtNotes.length,
				total: totalNotes || builtNotes.length,
				errors,
			}));
		} catch (error) {
			cachedFolders = previousFolders;
			cachedNotes = previousNotes;
			cacheDirty = true;
			pushRuntimeError(errors, 'index', reason, error);
			await emitRuntime(makeTaskProgress({
				kind: 'index',
				phase: 'error',
				state: 'error',
				statusText: '索引失败',
				detail: toErrorMessage(error),
				processed: 0,
				total: 0,
				errors,
			}));
			throw error;
		} finally {
			isIndexing = false;
			currentIndexPromise = null;
		}
	})();

	return currentIndexPromise;
}

function scheduleBackgroundReindex(reason = '内容变化') {
	cacheDirty = true;
	if (backgroundReindexTimer) clearTimeout(backgroundReindexTimer);
	backgroundReindexTimer = setTimeout(async () => {
		try {
			await rebuildIndex(reason);
			if (lastSearchRequest.query.trim()) {
				await runSearch(lastSearchRequest);
			}
		} catch (_error) {
			// 已通过 runtime 状态展示错误，这里不再重复抛出。
		}
	}, 1200);
}

async function ensureIndexReady() {
	if (currentIndexPromise) {
		await currentIndexPromise;
		return;
	}
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
	const currentRunId = ++searchRunId;

	try {
		if (currentIndexPromise) {
			await emitRuntime(makeTaskProgress({
				kind: 'search',
				phase: 'wait-index',
				state: 'running',
				statusText: '等待索引完成后再搜索...',
				detail: '索引进行中，完成后会自动继续',
				processed: 0,
				total: 0,
			}));
		}
		await ensureIndexReady();
	} catch (error) {
		if (currentRunId !== searchRunId) return;
		const message = `搜索前索引失败：${toErrorMessage(error)}`;
		await emitRuntime(makeTaskProgress({
			kind: 'search',
			phase: 'error',
			state: 'error',
			statusText: message,
			detail: '请先查看上方索引错误，修复后再重建索引',
			processed: 0,
			total: 0,
		}));
		lastSearchResponse = {
			request,
			statusText: message,
			resultCount: 0,
			groups: [],
		};
		await refreshPanel();
		return;
	}

	const outcome = await searchNotesWithProgress(cachedNotes, noteStats, request, {
		maxResults: MAX_RESULTS,
		progressEvery: 20,
		shouldCancel: () => currentRunId !== searchRunId,
		onProgress: async (progress: any) => {
			if (currentRunId !== searchRunId) return;
			await emitRuntime(progress);
		},
	});

	if (currentRunId !== searchRunId || outcome?.cancelled) return;
	lastSearchResponse = outcome.response;
	await emitRuntime(outcome.progress);
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
			try {
				if (message?.type === 'ready') {
					return;
				}
				if (message?.type === 'search') {
					void runSearch({ ...lastSearchRequest, ...message.payload });
					return;
				}
				if (message?.type === 'refreshIndex') {
					cacheDirty = true;
					void (async () => {
						try {
							await rebuildIndex('手动刷新');
							if (lastSearchRequest.query.trim()) await runSearch(lastSearchRequest);
						} catch (_error) {
							// 错误已通过 runtime 状态显示。
						}
					})();
					return;
				}
				if (message?.type === 'openResult') {
					void openResult(message.payload.noteId, message.payload.sectionSlug, message.payload.line);
				}
			} catch (error) {
				await emitRuntime(makeTaskProgress({
					kind: 'index',
					phase: 'panel-message-error',
					state: 'error',
					statusText: '面板消息处理失败',
					detail: toErrorMessage(error),
					processed: 0,
					total: 0,
					errors: [{ stage: 'panel-message', item: message?.type || 'unknown', message: toErrorMessage(error) }],
				}));
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
				try {
					await rebuildIndex('命令触发');
					if (lastSearchRequest.query.trim()) await runSearch(lastSearchRequest);
				} catch (_error) {
					// 错误已通过 runtime 状态显示。
				}
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

		try {
			await rebuildIndex('初始化');
		} catch (_error) {
			// 错误已通过 runtime 状态显示。
		}
		await recordSelectedNoteUsage();
		await joplin.views.panels.show(panelHandle, true);
	},
});
