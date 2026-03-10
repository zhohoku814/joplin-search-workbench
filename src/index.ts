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
const { createUi } = require('./i18n');
const { cloneRequest } = require('./panelClientState');

const PANEL_ID = 'searchWorkbench.panel';
const SETTINGS_SECTION = 'searchWorkbench';
const SETTINGS_STATS = 'searchWorkbench.noteStats';
const SETTINGS_UI_LANGUAGE = 'searchWorkbench.uiLanguage';
const PAGE_SIZE = 100;
const MAX_RESULTS = 200;

type SearchMode = 'smart' | 'literal' | 'regex';
type SearchScope = 'all' | 'title' | 'body';
type SortBy = 'relevance' | 'updated' | 'created' | 'lastViewed' | 'usageCount' | 'title' | 'bodyLength';
type SortDir = 'desc' | 'asc';
type GroupBy = 'none' | 'folder' | 'updatedMonth' | 'noteType';
type DateField = 'updated' | 'created' | 'lastViewed';
type NoteTypeFilter = 'all' | 'note' | 'todo';

type RuntimeKind = 'index' | 'search';
type UiLanguage = 'auto' | 'zh-CN' | 'en';

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

interface PanelMeta {
	indexDirty: boolean;
	lastAction: string;
	revision: number;
	advancedOpen: boolean;
}

interface PanelModel {
	request: SearchRequest;
	response: any;
	runtimes: Record<RuntimeKind, any>;
	meta: PanelMeta;
}

interface PanelModelPatch {
	request?: SearchRequest;
	response?: any;
	runtimes?: Partial<Record<RuntimeKind, any>>;
	meta?: Partial<PanelMeta>;
}

let panelHandle: any = null;
let panelRenderRunning = false;
let panelRenderRequested = false;
let cachedFolders: CachedFolder[] = [];
let cachedNotes: CachedNote[] = [];
let cacheDirty = true;
let currentIndexPromise: Promise<void> | null = null;
let noteStats: Record<string, NoteStats> = {};
let saveStatsTimer: NodeJS.Timeout | null = null;
let lastSelectedNoteId = '';
let searchRunId = 0;
let uiLanguageSetting: UiLanguage = 'auto';
let ui = createUi('auto', Intl.DateTimeFormat().resolvedOptions().locale);
let panelModel: PanelModel = createPanelModel();

function createDefaultRequest(): SearchRequest {
	return cloneRequest({}) as SearchRequest;
}

function createPanelModel(): PanelModel {
	return {
		request: createDefaultRequest(),
		response: null,
		runtimes: {
			index: null,
			search: null,
		},
		meta: {
			indexDirty: true,
			lastAction: 'init',
			revision: 0,
			advancedOpen: false,
		},
	};
}

function t(key: string, vars?: Record<string, any>) {
	return ui.t(key, vars);
}

function reasonLabel(reason: string) {
	return t(`reason.${reason}`);
}

function localeString(ts: number) {
	return new Date(ts).toLocaleString(ui.locale);
}

async function reloadUi() {
	uiLanguageSetting = (await joplin.settings.value(SETTINGS_UI_LANGUAGE) || 'auto') as UiLanguage;
	ui = createUi(uiLanguageSetting, Intl.DateTimeFormat().resolvedOptions().locale);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorMessage(error: any): string {
	if (!error) return t('common.unknownError');
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

function serialisePanelModel() {
	return {
		request: cloneRequest(panelModel.request),
		defaultRequest: createDefaultRequest(),
		response: panelModel.response,
		runtimes: {
			index: panelModel.runtimes.index,
			search: panelModel.runtimes.search,
		},
		meta: {
			...panelModel.meta,
			indexDirty: cacheDirty,
			locale: ui.locale,
		},
		messages: ui.messages,
		dictionary: ui.dict,
	};
}

function selected(value: string, expected: string): string {
	return value === expected ? ' selected' : '';
}

function checked(value: boolean): string {
	return value ? ' checked' : '';
}

function escapeAttribute(text: string): string {
	return escapeHtml(text).replace(/`/g, '&#096;');
}

function formatTime(ts: number): string {
	if (!ts) return t('common.noValue');
	return localeString(ts);
}

function highlightText(text: string, highlights: string[] = []): string {
	let html = escapeHtml(text || '');
	const unique = Array.from(new Set((highlights || []).filter(Boolean)))
		.sort((a, b) => b.length - a.length)
		.slice(0, 12);
	for (const item of unique) {
		const escaped = escapeHtml(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		html = html.replace(new RegExp(escaped, 'gi'), match => `<mark>${match}</mark>`);
	}
	return html;
}

function runtimePriority(runtime: any): number {
	if (!runtime) return 0;
	if (runtime.state === 'running') return 5;
	if (runtime.state === 'error') return 4;
	if (runtime.state === 'warning') return 3;
	if (runtime.state === 'done') return 2;
	return 1;
}

function getPrimaryRuntime(): any {
	const candidates = [panelModel.runtimes.search, panelModel.runtimes.index].filter(Boolean);
	candidates.sort((a, b) => runtimePriority(b) - runtimePriority(a));
	return candidates[0] || null;
}

function countActiveFilters(request: SearchRequest): number {
	const defaults = createDefaultRequest();
	let count = 0;
	const fields: Array<keyof SearchRequest> = [
		'mode',
		'scope',
		'caseSensitive',
		'noteType',
		'notebookQuery',
		'dateField',
		'dateFrom',
		'dateTo',
		'sortBy',
		'sortDir',
		'groupBy',
	];
	for (const field of fields) {
		if (request[field] !== defaults[field]) count += 1;
	}
	return count;
}

function phaseLabel(phase: string): string {
	return t(`phase.${phase || ''}`);
}

function blockTypeLabel(blockType: string): string {
	return t(`block.${blockType || ''}`);
}

function renderStatusHtml(): string {
	const primary = getPrimaryRuntime();
	const statusText = primary?.statusText || panelModel.response?.statusText || t('status.ready');
	const detail = primary?.detail || '';
	const metaText = panelModel.response ? t('status.meta', { groups: panelModel.response.groups.length, results: panelModel.response.resultCount }) : '';
	return `
		<div class="sw-status">
			<div class="sw-status-main">
				<div id="statusText">${escapeHtml(statusText)}</div>
				<div id="statusDetail" class="sw-status-detail">${escapeHtml(detail)}</div>
			</div>
			<div id="metaText" class="sw-status-meta">${escapeHtml(metaText)}</div>
		</div>
	`;
}

function renderRuntimeCardsHtml(): string {
	const order: RuntimeKind[] = ['index', 'search'];
	const cards = order
		.map(kind => panelModel.runtimes[kind])
		.filter(Boolean)
		.map(runtime => {
			const percentText = runtime.percent == null ? t('common.noValue') : `${runtime.percent}%`;
			const progressWidth = runtime.percent == null ? 0 : Math.max(0, Math.min(100, runtime.percent));
			const errors = Array.isArray(runtime.errors) ? runtime.errors : [];
			return `
				<section class="runtime-card ${escapeHtml(runtime.state || 'idle')}">
					<div class="runtime-head">
						<div class="runtime-kind">${escapeHtml(runtime.kind === 'index' ? t('runtime.index') : t('runtime.search'))}</div>
						<div class="runtime-phase">${escapeHtml(phaseLabel(runtime.phase || ''))}</div>
					</div>
					<div class="runtime-main">
						<div class="runtime-line"><span>${escapeHtml(runtime.statusText || t('common.noValue'))}</span><strong>${escapeHtml(percentText)}</strong></div>
						<div class="runtime-progress ${runtime.percent == null ? 'indeterminate' : ''}"><div class="runtime-progress-fill" style="width:${progressWidth}%"></div></div>
						<div class="runtime-detail">${escapeHtml(runtime.detail || '') || escapeHtml(t('common.noValue'))}</div>
						<div class="runtime-stats">${escapeHtml(t('runtime.processed', { processed: String(runtime.processed || 0), suffix: runtime.total ? ` / ${runtime.total}` : '' }))}</div>
						${runtime.currentLabel ? `<div class="runtime-current">${escapeHtml(t('runtime.current', { label: runtime.currentLabel }))}</div>` : ''}
						${errors.length ? `<div class="runtime-errors">${errors.map((item: any) => `<div class="runtime-error-item"><span>${escapeHtml(item.stage || 'error')}</span><strong>${escapeHtml(item.item || '')}</strong><em>${escapeHtml(item.message || '')}</em></div>`).join('')}</div>` : ''}
					</div>
				</section>
			`;
		});
	return `<div id="runtimeRoot" class="sw-runtime-root">${cards.join('')}</div>`;
}

function renderResultsHtml(): string {
	if (!panelModel.response) return `<div id="resultsRoot" class="sw-results"><div class="empty">${escapeHtml(t('empty.noResultsYet'))}</div></div>`;
	if (!panelModel.response.groups.length) return `<div id="resultsRoot" class="sw-results"><div class="empty">${escapeHtml(t('empty.noMatches'))}</div></div>`;
	return `
		<div id="resultsRoot" class="sw-results">
			${panelModel.response.groups.map((group: any) => `
				<section class="result-group">
					<div class="group-title">${escapeHtml(group.label)} <span>${group.items.length}</span></div>
					<div class="group-list">
						${group.items.map((item: any) => {
							const snippets = (item.snippets || []).map((snippet: any) => `
								<button class="snippet-item" data-note-id="${escapeAttribute(item.noteId)}" data-section-slug="${escapeAttribute(snippet.sectionSlug || '')}" data-line="${Number(snippet.line || 0)}">
									<div class="snippet-meta">
										<span class="badge">${escapeHtml(blockTypeLabel(snippet.blockType))}</span>
										<span>${escapeHtml(snippet.line ? t('snippet.line', { line: snippet.line }) : t('snippet.title'))}</span>
										${snippet.sectionText ? `<span class="section">${escapeHtml(snippet.sectionText)}</span>` : ''}
									</div>
									<div class="snippet-text">${highlightText(snippet.text, snippet.highlights)}</div>
								</button>
							`).join('');
							return `
								<article class="result-item">
									<div class="result-header">
										<div>
											<div class="result-title">${highlightText(item.title, (item.snippets && item.snippets[0] && item.snippets[0].highlights) || [])}</div>
											<div class="result-path">${escapeHtml(item.folderPath)} · ${escapeHtml(t(item.noteType === 'todo' ? 'noteType.todo' : 'noteType.note'))}</div>
										</div>
										<div class="result-side">
											<div>${escapeHtml(t('result.score', { score: Math.round(item.score) }))}</div>
											<div>${escapeHtml(t('result.usage', { count: item.usageCount || 0 }))}</div>
										</div>
									</div>
									<div class="result-times">
										<span>${escapeHtml(t('result.updated', { value: formatTime(item.updatedTime) }))}</span>
										<span>${escapeHtml(t('result.created', { value: formatTime(item.createdTime) }))}</span>
										<span>${escapeHtml(t('result.viewed', { value: formatTime(item.lastViewed) }))}</span>
									</div>
									<div class="snippet-list">${snippets}</div>
								</article>
							`;
						}).join('')}
					</div>
				</section>
			`).join('')}
		</div>
	`;
}

function createPanelHtml(): string {
	const request = cloneRequest(panelModel.request) as SearchRequest;
	const payload = escapeScriptJson(serialisePanelModel());
	const activeFilterCount = countActiveFilters(request);
	const advancedLabel = activeFilterCount > 0 ? `${t('panel.advancedFilters')} (${activeFilterCount})` : t('panel.advancedFilters');
	return `
		<div class="sw-root">
			<div class="sw-header">
				<div>
					<div class="sw-title">${escapeHtml(t('panel.title'))}</div>
					<div class="sw-subtitle">${escapeHtml(t('panel.subtitle'))}</div>
				</div>
			</div>

			<div class="sw-form">
				<div class="sw-row query-row">
					<input id="queryInput" class="sw-input" type="text" placeholder="${escapeAttribute(t('panel.searchPlaceholder'))}" value="${escapeAttribute(request.query || '')}">
					<button id="searchBtn" class="sw-btn">${escapeHtml(t('button.search'))}</button>
				</div>

				<div class="sw-row action-row">
					<button id="advancedToggleBtn" class="sw-btn secondary">${escapeHtml(advancedLabel)}</button>
					<button id="resetFiltersBtn" class="sw-btn secondary">${escapeHtml(t('button.resetFilters'))}</button>
					<button id="clearAllBtn" class="sw-btn secondary">${escapeHtml(t('button.clearAll'))}</button>
					<button id="refreshIndexBtn" class="sw-btn secondary">${escapeHtml(t('button.rebuildIndex'))}</button>
				</div>

				<div class="sw-advanced ${panelModel.meta.advancedOpen ? 'open' : 'collapsed'}">
					<div class="sw-row compact-grid">
						<label><span>${escapeHtml(t('field.mode'))}</span><select id="modeSelect" class="sw-select">
							<option value="smart"${selected(request.mode, 'smart')}>${escapeHtml(t('option.mode.smart'))}</option>
							<option value="literal"${selected(request.mode, 'literal')}>${escapeHtml(t('option.mode.literal'))}</option>
							<option value="regex"${selected(request.mode, 'regex')}>${escapeHtml(t('option.mode.regex'))}</option>
						</select></label>
						<label><span>${escapeHtml(t('field.scope'))}</span><select id="scopeSelect" class="sw-select">
							<option value="all"${selected(request.scope, 'all')}>${escapeHtml(t('option.scope.all'))}</option>
							<option value="title"${selected(request.scope, 'title')}>${escapeHtml(t('option.scope.title'))}</option>
							<option value="body"${selected(request.scope, 'body')}>${escapeHtml(t('option.scope.body'))}</option>
						</select></label>
						<label><span>${escapeHtml(t('field.sortBy'))}</span><select id="sortBySelect" class="sw-select">
							<option value="relevance"${selected(request.sortBy, 'relevance')}>${escapeHtml(t('option.sortBy.relevance'))}</option>
							<option value="updated"${selected(request.sortBy, 'updated')}>${escapeHtml(t('option.sortBy.updated'))}</option>
							<option value="created"${selected(request.sortBy, 'created')}>${escapeHtml(t('option.sortBy.created'))}</option>
							<option value="lastViewed"${selected(request.sortBy, 'lastViewed')}>${escapeHtml(t('option.sortBy.lastViewed'))}</option>
							<option value="usageCount"${selected(request.sortBy, 'usageCount')}>${escapeHtml(t('option.sortBy.usageCount'))}</option>
							<option value="title"${selected(request.sortBy, 'title')}>${escapeHtml(t('option.sortBy.title'))}</option>
							<option value="bodyLength"${selected(request.sortBy, 'bodyLength')}>${escapeHtml(t('option.sortBy.bodyLength'))}</option>
						</select></label>
						<label><span>${escapeHtml(t('field.sortDir'))}</span><select id="sortDirSelect" class="sw-select">
							<option value="desc"${selected(request.sortDir, 'desc')}>${escapeHtml(t('option.sortDir.desc'))}</option>
							<option value="asc"${selected(request.sortDir, 'asc')}>${escapeHtml(t('option.sortDir.asc'))}</option>
						</select></label>
						<label><span>${escapeHtml(t('field.groupBy'))}</span><select id="groupBySelect" class="sw-select">
							<option value="none"${selected(request.groupBy, 'none')}>${escapeHtml(t('option.groupBy.none'))}</option>
							<option value="folder"${selected(request.groupBy, 'folder')}>${escapeHtml(t('option.groupBy.folder'))}</option>
							<option value="updatedMonth"${selected(request.groupBy, 'updatedMonth')}>${escapeHtml(t('option.groupBy.updatedMonth'))}</option>
							<option value="noteType"${selected(request.groupBy, 'noteType')}>${escapeHtml(t('option.groupBy.noteType'))}</option>
						</select></label>
					</div>

					<div class="sw-row compact-grid">
						<label><span>${escapeHtml(t('field.notebookQuery'))}</span><input id="notebookInput" class="sw-input" type="text" placeholder="${escapeAttribute(t('panel.notebookPlaceholder'))}" value="${escapeAttribute(request.notebookQuery || '')}"></label>
						<label><span>${escapeHtml(t('field.noteType'))}</span><select id="noteTypeSelect" class="sw-select">
							<option value="all"${selected(request.noteType, 'all')}>${escapeHtml(t('option.noteType.all'))}</option>
							<option value="note"${selected(request.noteType, 'note')}>${escapeHtml(t('option.noteType.note'))}</option>
							<option value="todo"${selected(request.noteType, 'todo')}>${escapeHtml(t('option.noteType.todo'))}</option>
						</select></label>
						<label><span>${escapeHtml(t('field.dateField'))}</span><select id="dateFieldSelect" class="sw-select">
							<option value="updated"${selected(request.dateField, 'updated')}>${escapeHtml(t('option.dateField.updated'))}</option>
							<option value="created"${selected(request.dateField, 'created')}>${escapeHtml(t('option.dateField.created'))}</option>
							<option value="lastViewed"${selected(request.dateField, 'lastViewed')}>${escapeHtml(t('option.dateField.lastViewed'))}</option>
						</select></label>
						<label><span>${escapeHtml(t('field.dateFrom'))}</span><input id="dateFromInput" class="sw-input" type="date" value="${escapeAttribute(request.dateFrom || '')}"></label>
						<label><span>${escapeHtml(t('field.dateTo'))}</span><input id="dateToInput" class="sw-input" type="date" value="${escapeAttribute(request.dateTo || '')}"></label>
					</div>

					<div class="sw-row check-row">
						<label class="check-item"><input id="caseSensitiveInput" type="checkbox"${checked(!!request.caseSensitive)}> ${escapeHtml(t('field.caseSensitive'))}</label>
					</div>
				</div>
			</div>

			${renderStatusHtml()}
			${renderRuntimeCardsHtml()}
			${renderResultsHtml()}
		</div>
		<script id="initialState" type="application/json">${payload}</script>
	`;
}

async function showToast(message: string) {
	await joplin.views.dialogs.showToast({ message, type: ToastType.Info });
}

async function renderPanelShell() {
	if (!panelHandle) return;
	await joplin.views.panels.setHtml(panelHandle, createPanelHtml());
}

async function flushPanelRender() {
	if (!panelHandle || panelRenderRunning) return;
	panelRenderRunning = true;
	try {
		do {
			panelRenderRequested = false;
			await renderPanelShell();
		} while (panelRenderRequested);
	} finally {
		panelRenderRunning = false;
	}
}

function schedulePanelRender() {
	panelRenderRequested = true;
	void flushPanelRender();
}

function updatePanelModel(patch: PanelModelPatch, options: { render?: boolean } = {}) {
	panelModel = {
		...panelModel,
		...patch,
		request: patch.request ? (cloneRequest(patch.request) as SearchRequest) : panelModel.request,
		runtimes: patch.runtimes ? { ...panelModel.runtimes, ...patch.runtimes } : panelModel.runtimes,
		meta: {
			...panelModel.meta,
			...(patch.meta || {}),
			revision: panelModel.meta.revision + 1,
		},
	};
	if (options.render !== false) schedulePanelRender();
}

function setRuntime(kind: RuntimeKind, runtime: any) {
	updatePanelModel({
		runtimes: { [kind]: runtime } as Record<RuntimeKind, any>,
		meta: { lastAction: runtime?.statusText || panelModel.meta.lastAction },
	});
}

function buildStaleIndexRuntime(reasonKey: string) {
	const knownCount = cachedNotes.length;
	return makeTaskProgress({
		kind: 'index',
		phase: 'stale',
		state: 'warning',
		statusText: t('index.stale'),
		detail: t('index.staleDetail', { reason: reasonLabel(reasonKey) }),
		processed: knownCount,
		total: knownCount || 0,
	});
}

function markIndexDirty(reasonKey = 'contentChanged') {
	cacheDirty = true;
	updatePanelModel({
		runtimes: { index: buildStaleIndexRuntime(reasonKey) } as Record<RuntimeKind, any>,
		meta: {
			indexDirty: true,
			lastAction: `index-dirty:${reasonKey}`,
		},
	});
}

function buildFolderPaths(folders: Array<{ id: string; title: string; parent_id?: string }>): CachedFolder[] {
	const byId = new Map<string, { id: string; title: string; parent_id?: string }>();
	for (const folder of folders) byId.set(folder.id, folder);

	const cache = new Map<string, string>();
	const folderPath = (folderId: string): string => {
		if (!folderId) return t('folder.uncategorized');
		if (cache.has(folderId)) return cache.get(folderId) as string;
		const folder = byId.get(folderId);
		if (!folder) return t('group.unknownFolder');
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

async function countAllNotes(reasonKey: string, errors: RuntimeErrorEntry[]): Promise<number> {
	let page = 1;
	let total = 0;
	while (true) {
		let response: any;
		try {
			response = await joplin.data.get(['notes'], { fields: ['id', 'title'], limit: PAGE_SIZE, page });
		} catch (error) {
			pushRuntimeError(errors, 'count-notes', `page:${page}`, error);
			throw new Error(t('index.countFailed', { page, error: toErrorMessage(error) }));
		}

		const items = Array.isArray(response) ? response : (response?.items || []);
		total += items.length;
		const lastItem = items.length ? items[items.length - 1] : null;
		setRuntime('index', makeTaskProgress({
			kind: 'index',
			phase: 'count',
			state: 'running',
			statusText: t('index.counting', { reason: reasonLabel(reasonKey) }),
			detail: t('index.scannedPreview', { count: total }),
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

async function rebuildIndex(reasonKey = 'manualRefresh') {
	if (currentIndexPromise) return currentIndexPromise;

	const previousFolders = cachedFolders;
	const previousNotes = cachedNotes;
	currentIndexPromise = (async () => {
		const errors: RuntimeErrorEntry[] = [];

		try {
			updatePanelModel({ meta: { indexDirty: true, lastAction: `rebuild-index:${reasonKey}` } });
			setRuntime('index', makeTaskProgress({
				kind: 'index',
				phase: 'start',
				state: 'running',
				statusText: t('index.preparingRebuild', { reason: reasonLabel(reasonKey) }),
				detail: t('index.startCounting'),
				processed: 0,
				total: 0,
				errors,
			}));

			const totalNotes = await countAllNotes(reasonKey, errors);
			setRuntime('index', makeTaskProgress({
				kind: 'index',
				phase: 'folders',
				state: 'running',
				statusText: t('index.readingFolders', { reason: reasonLabel(reasonKey) }),
				detail: totalNotes ? t('index.preparingBuild', { count: totalNotes }) : t('index.noNotesFound'),
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
					throw new Error(t('index.fetchPageFailed', { page, error: toErrorMessage(error) }));
				}

				const items = Array.isArray(response) ? response : (response?.items || []);
				for (const note of items) {
					try {
						const body = normaliseNewlines(note.body || '');
						const parsed = buildLineMeta(body, uslug);
						builtNotes.push({
							id: note.id,
							title: note.title || t('common.untitled'),
							body,
							parent_id: note.parent_id || '',
							updated_time: note.updated_time || 0,
							created_time: note.created_time || 0,
							is_todo: note.is_todo || 0,
							todo_completed: note.todo_completed || 0,
							folderPath: folderMap.get(note.parent_id) || t('group.unknownFolder'),
							lines: parsed.lines,
							lineMeta: parsed.lineMeta,
							bodyLength: body.length,
						});
					} catch (error) {
						pushRuntimeError(errors, 'parse-note', note.title || note.id || t('common.unknownError'), error);
					}

					processed += 1;
					if (processed === 1 || processed % 10 === 0 || processed === totalNotes) {
						setRuntime('index', makeTaskProgress({
							kind: 'index',
							phase: 'notes',
							state: 'running',
							statusText: t('index.rebuilding', { reason: reasonLabel(reasonKey) }),
							detail: totalNotes ? t('index.buildProgress', { processed, total: totalNotes }) : t('index.buildProgressNoTotal', { processed }),
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
			updatePanelModel({ meta: { indexDirty: false, lastAction: `index-ready:${reasonKey}` } });
			setRuntime('index', makeTaskProgress({
				kind: 'index',
				phase: 'done',
				state: errors.length ? 'warning' : 'done',
				statusText: t('index.ready', { count: builtNotes.length }),
				detail: errors.length ? t('index.completeWithIssues', { count: errors.length }) : t('index.complete'),
				processed: totalNotes || builtNotes.length,
				total: totalNotes || builtNotes.length,
				errors,
			}));
		} catch (error) {
			cachedFolders = previousFolders;
			cachedNotes = previousNotes;
			cacheDirty = true;
			pushRuntimeError(errors, 'index', reasonKey, error);
			updatePanelModel({ meta: { indexDirty: true, lastAction: `index-failed:${reasonKey}` } });
			setRuntime('index', makeTaskProgress({
				kind: 'index',
				phase: 'error',
				state: 'error',
				statusText: t('index.failed'),
				detail: toErrorMessage(error),
				processed: 0,
				total: 0,
				errors,
			}));
			throw error;
		} finally {
			currentIndexPromise = null;
		}
	})();

	return currentIndexPromise;
}

async function ensureIndexReady() {
	if (currentIndexPromise) {
		await currentIndexPromise;
		return;
	}
	if (cacheDirty || !cachedNotes.length) {
		const rebuildReason = cachedNotes.length ? 'autoUpdate' : 'firstBuild';
		await rebuildIndex(rebuildReason);
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
		await showToast(t('toast.openResultFailed'));
		return;
	}

	await showToast(line > 0 ? t('toast.openResultNearby', { line }) : t('toast.openResult'));
}

async function runSearch(requestInput: SearchRequest) {
	const request = cloneRequest(requestInput) as SearchRequest;
	const currentRunId = ++searchRunId;
	updatePanelModel({
		request,
		meta: { lastAction: `search:${request.query || t('common.empty')}` },
	});

	try {
		if (currentIndexPromise) {
			setRuntime('search', makeTaskProgress({
				kind: 'search',
				phase: 'wait-index',
				state: 'running',
				statusText: t('search.waitIndex'),
				detail: t('search.waitIndexDetail'),
				processed: 0,
				total: 0,
			}));
		}
		await ensureIndexReady();
	} catch (error) {
		if (currentRunId !== searchRunId) return;
		const message = t('search.beforeIndexFailed', { error: toErrorMessage(error) });
		setRuntime('search', makeTaskProgress({
			kind: 'search',
			phase: 'error',
			state: 'error',
			statusText: message,
			detail: t('search.fixIndexFirst'),
			processed: 0,
			total: 0,
		}));
		updatePanelModel({
			response: {
				request,
				statusText: message,
				resultCount: 0,
				groups: [],
			},
			meta: { lastAction: 'search-failed' },
		});
		return;
	}

	const outcome = await searchNotesWithProgress(cachedNotes, noteStats, request, {
		maxResults: MAX_RESULTS,
		progressEvery: 20,
		ui,
		shouldCancel: () => currentRunId !== searchRunId,
		onProgress: async (progress: any) => {
			if (currentRunId !== searchRunId) return;
			setRuntime('search', progress);
		},
	});

	if (currentRunId !== searchRunId || outcome?.cancelled) return;
	updatePanelModel({
		response: outcome.response,
		meta: { lastAction: 'search-done' },
	});
	setRuntime('search', outcome.progress);
}

async function refreshIndexFromUser(reasonKey: string) {
	cacheDirty = true;
	updatePanelModel({ meta: { indexDirty: true, lastAction: `refresh-index:${reasonKey}` } });
	try {
		await rebuildIndex(reasonKey);
		if (panelModel.request.query.trim()) await runSearch(panelModel.request);
	} catch (_error) {
		// Runtime state already shows the error.
	}
}

function resetFiltersState(preserveQuery = true) {
	const nextRequest = createDefaultRequest();
	if (preserveQuery) nextRequest.query = panelModel.request.query || '';
	updatePanelModel({
		request: nextRequest,
		response: null,
		runtimes: { search: null } as Partial<Record<RuntimeKind, any>>,
		meta: { lastAction: preserveQuery ? 'reset-filters' : 'clear-all' },
	});
}

function toggleAdvancedFilters() {
	updatePanelModel({
		meta: { advancedOpen: !panelModel.meta.advancedOpen, lastAction: 'toggle-advanced' },
	});
}

joplin.plugins.register({
	onStart: async function() {
		ui = createUi('auto', Intl.DateTimeFormat().resolvedOptions().locale);

		await joplin.settings.registerSection(SETTINGS_SECTION, {
			label: t('settings.sectionLabel'),
			iconName: 'fas fa-search',
			description: t('settings.sectionDescription'),
		});

		await joplin.settings.registerSettings({
			[SETTINGS_STATS]: {
				value: {},
				type: SettingItemType.Object,
				public: false,
				section: SETTINGS_SECTION,
				storage: SettingStorage.File,
				label: t('settings.statsLabel'),
			},
			[SETTINGS_UI_LANGUAGE]: {
				value: 'auto',
				type: SettingItemType.String,
				public: true,
				isEnum: true,
				section: SETTINGS_SECTION,
				label: t('settings.languageLabel'),
				description: t('settings.languageDescription'),
				options: {
					auto: t('settings.language.auto'),
					'zh-CN': t('settings.language.zh-CN'),
					en: t('settings.language.en'),
				},
			},
		});

		await reloadUi();
		await loadStats();
		panelHandle = await joplin.views.panels.create(PANEL_ID);
		await renderPanelShell();
		await joplin.views.panels.addScript(panelHandle, './webview.css');
		await joplin.views.panels.addScript(panelHandle, './panelClientState.js');
		await joplin.views.panels.addScript(panelHandle, './webview.js');

		await joplin.views.panels.onMessage(panelHandle, async (message: any) => {
			try {
				if (message?.name === 'ready') {
					return { accepted: true };
				}
				if (message?.name === 'draftUpdate') {
					updatePanelModel({
						request: cloneRequest(message.payload || createDefaultRequest()) as SearchRequest,
						meta: { lastAction: 'draft-update' },
					}, { render: false });
					return { accepted: true };
				}
				if (message?.name === 'search') {
					void runSearch(message.payload || createDefaultRequest());
					return { accepted: true };
				}
				if (message?.name === 'refreshIndex') {
					void refreshIndexFromUser('manualRefresh');
					return { accepted: true };
				}
				if (message?.name === 'resetFilters') {
					resetFiltersState(true);
					return { accepted: true };
				}
				if (message?.name === 'clearAll') {
					resetFiltersState(false);
					return { accepted: true };
				}
				if (message?.name === 'toggleAdvanced') {
					toggleAdvancedFilters();
					return { accepted: true };
				}
				if (message?.name === 'openResult') {
					void openResult(message.payload.noteId, message.payload.sectionSlug, message.payload.line);
					return { accepted: true };
				}
				return { accepted: false, message: t('common.unknownCommand') };
			} catch (error) {
				setRuntime('index', makeTaskProgress({
					kind: 'index',
					phase: 'panel-message-error',
					state: 'error',
					statusText: t('index.phaseError'),
					detail: toErrorMessage(error),
					processed: 0,
					total: 0,
					errors: [{ stage: 'panel-message', item: message?.name || 'unknown', message: toErrorMessage(error) }],
				}));
				return { accepted: false, message: toErrorMessage(error) };
			}
		});

		await joplin.commands.register({
			name: 'searchWorkbench.togglePanel',
			label: t('command.togglePanel'),
			iconName: 'fas fa-search',
			execute: async () => {
				const visible = await joplin.views.panels.visible(panelHandle);
				await joplin.views.panels.show(panelHandle, !visible);
			},
		});

		await joplin.commands.register({
			name: 'searchWorkbench.refreshIndex',
			label: t('command.rebuildIndex'),
			iconName: 'fas fa-rotate',
			execute: async () => {
				await refreshIndexFromUser('commandTriggered');
			},
		});

		await joplin.views.toolbarButtons.create('searchWorkbenchToggleButton', 'searchWorkbench.togglePanel', ToolbarButtonLocation.NoteToolbar);
		await joplin.views.menuItems.create('searchWorkbenchToggleMenu', 'searchWorkbench.togglePanel', MenuItemLocation.Tools);
		await joplin.views.menuItems.create('searchWorkbenchRefreshMenu', 'searchWorkbench.refreshIndex', MenuItemLocation.Tools);

		await joplin.workspace.onNoteSelectionChange(async () => {
			await recordSelectedNoteUsage();
		});

		await joplin.workspace.onNoteChange(async () => {
			markIndexDirty('contentChanged');
		});

		await joplin.workspace.onSyncComplete(async () => {
			markIndexDirty('syncCompleted');
		});

		await joplin.settings.onChange(async () => {
			const previousLocale = ui.locale;
			await reloadUi();
			if (previousLocale !== ui.locale) schedulePanelRender();
		});

		try {
			await rebuildIndex('initial');
		} catch (_error) {
			// Runtime state already shows the error.
		}
		await recordSelectedNoteUsage();
		await joplin.views.panels.show(panelHandle, true);
	},
});
