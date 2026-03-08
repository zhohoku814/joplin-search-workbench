const PANEL_ID = 'searchWorkbench.panel';
const SETTINGS_SECTION = 'searchWorkbench';
const SETTINGS_STATS = 'searchWorkbench.noteStats';
const PAGE_SIZE = 100;
const BODY_PAGE_SIZE = 20;
const MAX_RESULTS = 200;
const SETTING_TYPE_OBJECT = 5;
const SETTING_STORAGE_FILE = 2;

let panelHandle = null;
let folderCache = [];
let folderPathMap = new Map();
let noteMetaCache = [];
let noteStats = {};
let lastSearchRequest = defaultSearchRequest();
let lastSelectedNoteId = '';
let saveStatsTimer = null;
let refreshPromise = null;
let searchToken = 0;

function defaultSearchRequest() {
	return {
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
}

function normaliseNewlines(text) {
	return String(text || '').replace(/\r\n/g, '\n');
}

function slugifyHeading(text) {
	return String(text || '')
		.toLowerCase()
		.trim()
		.replace(/[\u0000-\u001f]/g, '')
		.replace(/[`~!@#$%^&*()+=\[\]{}|\\:;"'<>,.?/，。；：？！、】【（）【】《》、]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function toComparable(text, caseSensitive) {
	return caseSensitive ? String(text || '') : String(text || '').toLowerCase();
}

function literalOccurrences(text, needle, caseSensitive) {
	if (!needle) return 0;
	const haystack = toComparable(text, caseSensitive);
	const target = toComparable(needle, caseSensitive);
	let count = 0;
	let index = 0;
	while (true) {
		const found = haystack.indexOf(target, index);
		if (found < 0) break;
		count += 1;
		index = found + Math.max(1, target.length);
	}
	return count;
}

function parseSmartTokens(query) {
	const tokens = [];
	const phrases = [];
	const regex = /"([^"]+)"|(\S+)/g;
	let match = null;
	while ((match = regex.exec(query)) !== null) {
		const value = (match[1] || match[2] || '').trim();
		if (!value) continue;
		tokens.push(value);
		if (match[1]) phrases.push(value);
	}
	return { tokens, phrases };
}

function safeRegex(query, caseSensitive) {
	try {
		return new RegExp(query, caseSensitive ? 'g' : 'gi');
	} catch (_error) {
		return null;
	}
}

function matchText(text, request) {
	const query = String(request.query || '').trim();
	if (!query) return { matched: false, hits: 0, highlights: [] };

	if (request.mode === 'regex') {
		const regex = safeRegex(query, request.caseSensitive);
		if (!regex) return { matched: false, hits: 0, highlights: [] };
		const matches = String(text || '').match(regex) || [];
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

function buildLineMeta(body) {
	const lines = normaliseNewlines(body).split('\n');
	const lineMeta = [];
	let inCodeFence = false;
	let sectionText = '';
	let sectionSlug = '';
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] || '';
		const headingMatch = !inCodeFence ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
		if (headingMatch) {
			sectionText = headingMatch[2].trim();
			sectionSlug = slugifyHeading(sectionText);
		}
		lineMeta.push({ lineNumber: i + 1, sectionText, sectionSlug, inCodeFence });
		if (/^```/.test(line.trim())) inCodeFence = !inCodeFence;
	}
	return { lines, lineMeta };
}

function detectBlockType(lines, meta, index) {
	const line = lines[index] || '';
	const trimmed = line.trim();
	if (index === 0 && trimmed.length && !/^#{1,6}\s/.test(trimmed)) return 'paragraph';
	if (/^(#{1,6})\s+/.test(trimmed)) return 'heading';
	if ((meta[index] && meta[index].inCodeFence) || /^```/.test(trimmed)) return 'code';
	if (/^>\s?/.test(trimmed)) return 'quote';
	if (/^[-*+]\s+\[[ xX]\]/.test(trimmed) || /^\d+\.\s+\[[ xX]\]/.test(trimmed)) return 'task';
	if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) return 'list';
	if (/^\|.*\|$/.test(trimmed)) return 'table';
	return 'paragraph';
}

function extractSnippets(note, request, body) {
	const snippets = [];
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
	const parsed = buildLineMeta(body || '');
	const seenLines = new Set();
	for (let i = 0; i < parsed.lines.length && snippets.length < 4; i += 1) {
		const line = parsed.lines[i] || '';
		const lineMatch = matchText(line, request);
		if (!lineMatch.matched || seenLines.has(i)) continue;
		seenLines.add(i);
		const parts = [parsed.lines[i - 1], parsed.lines[i], parsed.lines[i + 1]].filter(Boolean).map(s => String(s || '').trim()).filter(Boolean);
		snippets.push({
			text: parts.join(' ⏎ '),
			line: i + 1,
			blockType: detectBlockType(parsed.lines, parsed.lineMeta, i),
			sectionText: parsed.lineMeta[i] ? parsed.lineMeta[i].sectionText : '',
			sectionSlug: parsed.lineMeta[i] ? parsed.lineMeta[i].sectionSlug : '',
			highlights: lineMatch.highlights,
		});
	}
	return snippets;
}

function scoreResult(note, request, snippets, body) {
	const titleMatch = matchText(note.title, request);
	const bodyMatch = request.scope === 'title' ? { matched: false, hits: 0 } : matchText(body || '', request);
	let score = 0;
	if (titleMatch.matched) score += 120 + titleMatch.hits * 18;
	if (bodyMatch.matched) score += 40 + bodyMatch.hits * 6;
	if (request.mode === 'literal' && request.query && literalOccurrences(note.title, request.query, request.caseSensitive)) score += 50;
	if (request.mode === 'smart') {
		const phrases = parseSmartTokens(request.query).phrases;
		for (const phrase of phrases) {
			score += literalOccurrences(note.title, phrase, request.caseSensitive) * 30;
			score += literalOccurrences(body || '', phrase, request.caseSensitive) * 10;
		}
	}
	if (snippets.length) score += Math.max(0, 20 - snippets[0].line);
	return score;
}

function withinDateRange(value, from, to) {
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

function noteMatchesFilters(note, request) {
	if (request.noteType === 'note' && note.is_todo) return false;
	if (request.noteType === 'todo' && !note.is_todo) return false;
	if (request.notebookQuery && request.notebookQuery.trim()) {
		const haystack = String(note.folderPath || '').toLowerCase();
		if (!haystack.includes(request.notebookQuery.trim().toLowerCase())) return false;
	}
	let dateValue = 0;
	if (request.dateField === 'created') dateValue = note.created_time || 0;
	else if (request.dateField === 'lastViewed') dateValue = (noteStats[note.id] && noteStats[note.id].lastViewed) || 0;
	else dateValue = note.updated_time || 0;
	return withinDateRange(dateValue, request.dateFrom, request.dateTo);
}

function compareResults(a, b, sortBy, sortDir) {
	const direction = sortDir === 'asc' ? 1 : -1;
	let left = 0;
	let right = 0;
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
		left = String(a.title || '').toLowerCase();
		right = String(b.title || '').toLowerCase();
	}
	if (left < right) return -1 * direction;
	if (left > right) return 1 * direction;
	return b.score - a.score;
}

function groupLabel(result, groupBy) {
	if (groupBy === 'folder') return { key: result.folderPath || '未知笔记本', label: result.folderPath || '未知笔记本' };
	if (groupBy === 'noteType') return { key: result.noteType, label: result.noteType === 'todo' ? '待办笔记' : '普通笔记' };
	if (groupBy === 'updatedMonth') {
		const date = result.updatedTime ? new Date(result.updatedTime) : null;
		const key = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : '未修改';
		return { key, label: key };
	}
	return { key: 'all', label: '搜索结果' };
}

function postPanelMessage(message) {
	if (!panelHandle) return;
	try {
		joplin.views.panels.postMessage(panelHandle, message);
	} catch (_error) {
	}
}

async function postStatus(text) {
	postPanelMessage({ type: 'status', text });
}

async function showToast(message) {
	try {
		await joplin.views.dialogs.showToast({ message, type: 'info' });
	} catch (_error) {
	}
}

async function fetchPage(path, params) {
	const response = await joplin.data.get(path, params || {});
	if (Array.isArray(response)) return { items: response, has_more: false };
	return { items: (response && response.items) || [], has_more: !!(response && response.has_more) };
}

async function fetchAllPaged(path, params, statusPrefix) {
	let page = 1;
	const out = [];
	while (true) {
		if (statusPrefix) await postStatus(`${statusPrefix}（第 ${page} 页）...`);
		const current = await fetchPage(path, Object.assign({}, params || {}, { page, limit: PAGE_SIZE }));
		out.push.apply(out, current.items || []);
		if (!current.has_more) break;
		page += 1;
	}
	return out;
}

function buildFolderPaths(folders) {
	const byId = new Map();
	for (const folder of folders) byId.set(folder.id, folder);
	const cache = new Map();
	function folderPath(folderId) {
		if (!folderId) return '未分类';
		if (cache.has(folderId)) return cache.get(folderId);
		const folder = byId.get(folderId);
		if (!folder) return '未知笔记本';
		const parentPath = folder.parent_id ? folderPath(folder.parent_id) : '';
		const value = parentPath ? `${parentPath} / ${folder.title}` : folder.title;
		cache.set(folderId, value);
		return value;
	}
	return folders.map(folder => ({ id: folder.id, title: folder.title, parent_id: folder.parent_id, path: folderPath(folder.id) }));
}

async function loadStats() {
	const stored = await joplin.settings.value(SETTINGS_STATS);
	noteStats = stored && typeof stored === 'object' ? stored : {};
}

function scheduleSaveStats() {
	if (saveStatsTimer) clearTimeout(saveStatsTimer);
	saveStatsTimer = setTimeout(async () => {
		try {
			await joplin.settings.setValue(SETTINGS_STATS, noteStats);
		} catch (_error) {
		}
	}, 500);
}

async function recordSelectedNoteUsage() {
	const note = await joplin.workspace.selectedNote();
	if (!note || !note.id || note.id === lastSelectedNoteId) return;
	lastSelectedNoteId = note.id;
	const current = noteStats[note.id] || { usageCount: 0, lastViewed: 0 };
	noteStats[note.id] = { usageCount: current.usageCount + 1, lastViewed: Date.now() };
	scheduleSaveStats();
}

async function refreshBaseCache(reason) {
	if (refreshPromise) return refreshPromise;
	refreshPromise = (async () => {
		await postStatus(`正在刷新索引（${reason || '手动'}）...`);
		const folders = await fetchAllPaged(['folders'], { fields: ['id', 'title', 'parent_id'] }, '读取笔记本');
		folderCache = buildFolderPaths(folders);
		folderPathMap = new Map(folderCache.map(folder => [folder.id, folder.path]));
		const notes = await fetchAllPaged(['notes'], { fields: ['id', 'title', 'parent_id', 'updated_time', 'created_time', 'is_todo', 'todo_completed'] }, '读取笔记元数据');
		noteMetaCache = notes.map(note => ({
			id: note.id,
			title: note.title || '(无标题)',
			parent_id: note.parent_id || '',
			updated_time: note.updated_time || 0,
			created_time: note.created_time || 0,
			is_todo: note.is_todo || 0,
			todo_completed: note.todo_completed || 0,
			folderPath: folderPathMap.get(note.parent_id) || '未知笔记本',
		}));
		await postStatus(`索引已就绪：${folderCache.length} 个笔记本，${noteMetaCache.length} 篇笔记。`);
	})().finally(() => {
		refreshPromise = null;
	});
	return refreshPromise;
}

async function ensureBaseCache() {
	if (!noteMetaCache.length || !folderCache.length) {
		await refreshBaseCache('初始化');
	}
}

function buildResponse(request, results) {
	results.sort((a, b) => compareResults(a, b, request.sortBy, request.sortDir));
	const limited = results.slice(0, MAX_RESULTS);
	const groupedMap = new Map();
	for (const result of limited) {
		const group = groupLabel(result, request.groupBy);
		if (!groupedMap.has(group.key)) groupedMap.set(group.key, { key: group.key, label: group.label, items: [] });
		groupedMap.get(group.key).items.push(result);
	}
	return {
		request,
		statusText: results.length > MAX_RESULTS ? `命中 ${results.length} 条，已显示前 ${MAX_RESULTS} 条。` : `命中 ${results.length} 条。`,
		resultCount: results.length,
		groups: Array.from(groupedMap.values()),
	};
}

function makeResultFromTitleOnly(note, request) {
	const titleMatch = matchText(note.title, request);
	if (!titleMatch.matched) return null;
	const snippets = [{ text: note.title, line: 0, blockType: 'title', sectionText: '', sectionSlug: '', highlights: titleMatch.highlights }];
	const stats = noteStats[note.id] || { usageCount: 0, lastViewed: 0 };
	return {
		noteId: note.id,
		title: note.title,
		folderPath: note.folderPath,
		noteType: note.is_todo ? 'todo' : 'note',
		updatedTime: note.updated_time,
		createdTime: note.created_time,
		lastViewed: stats.lastViewed || 0,
		usageCount: stats.usageCount || 0,
		bodyLength: 0,
		score: scoreResult(note, request, snippets, ''),
		snippets,
	};
}

async function runTitleOnlySearch(request, token) {
	await ensureBaseCache();
	const pool = noteMetaCache.filter(note => noteMatchesFilters(note, request));
	await postStatus(`正在搜索标题（${pool.length} 篇）...`);
	const results = [];
	for (let i = 0; i < pool.length; i += 1) {
		if (token !== searchToken) return null;
		if (i % 200 === 0 && i > 0) await postStatus(`正在搜索标题（${i}/${pool.length}）...`);
		const result = makeResultFromTitleOnly(pool[i], request);
		if (result) results.push(result);
	}
	return buildResponse(request, results);
}

async function runFullScanSearch(request, token) {
	await ensureBaseCache();
	let page = 1;
	const results = [];
	let scanned = 0;
	while (true) {
		if (token !== searchToken) return null;
		await postStatus(`正在扫描正文（第 ${page} 页，已扫 ${scanned} 篇）...`);
		const current = await fetchPage(['notes'], {
			fields: ['id', 'title', 'body', 'parent_id', 'updated_time', 'created_time', 'is_todo', 'todo_completed'],
			page,
			limit: BODY_PAGE_SIZE,
		});
		const items = current.items || [];
		if (!items.length) break;
		for (const raw of items) {
			if (token !== searchToken) return null;
			scanned += 1;
			const note = {
				id: raw.id,
				title: raw.title || '(无标题)',
				parent_id: raw.parent_id || '',
				updated_time: raw.updated_time || 0,
				created_time: raw.created_time || 0,
				is_todo: raw.is_todo || 0,
				todo_completed: raw.todo_completed || 0,
				folderPath: folderPathMap.get(raw.parent_id) || '未知笔记本',
			};
			if (!noteMatchesFilters(note, request)) continue;
			const body = String(raw.body || '');
			const titleMatched = request.scope !== 'body' ? matchText(note.title, request) : { matched: false, hits: 0, highlights: [] };
			const bodyMatched = request.scope !== 'title' ? matchText(body, request) : { matched: false, hits: 0, highlights: [] };
			if (!titleMatched.matched && !bodyMatched.matched) continue;
			const snippets = extractSnippets(note, request, body);
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
				bodyLength: body.length,
				score: scoreResult(note, request, snippets, body),
				snippets,
			});
		}
		if (!current.has_more) break;
		page += 1;
	}
	return buildResponse(request, results);
}

async function runSearch(request) {
	lastSearchRequest = Object.assign(defaultSearchRequest(), request || {});
	const token = ++searchToken;
	const query = String(lastSearchRequest.query || '').trim();
	if (!query) {
		postPanelMessage({ type: 'results', payload: { request: lastSearchRequest, statusText: '请输入搜索词。支持智能 / 精确文本 / 正则。', resultCount: 0, groups: [] } });
		return;
	}
	if (lastSearchRequest.mode === 'regex' && !safeRegex(query, lastSearchRequest.caseSensitive)) {
		postPanelMessage({ type: 'results', payload: { request: lastSearchRequest, statusText: '正则表达式无效，请检查写法。', resultCount: 0, groups: [] } });
		return;
	}

	let response = null;
	if (lastSearchRequest.scope === 'title') response = await runTitleOnlySearch(lastSearchRequest, token);
		else response = await runFullScanSearch(lastSearchRequest, token);
	if (!response || token !== searchToken) return;
	postPanelMessage({ type: 'results', payload: response });
}

async function openResult(noteId, sectionSlug, line) {
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
		await new Promise(resolve => setTimeout(resolve, 120));
		try {
			await joplin.commands.execute('scrollToHash', sectionSlug);
		} catch (_error) {
		}
	}
	if (!opened) {
		await showToast('没有成功打开目标笔记。');
		return;
	}
	await showToast(line > 0 ? `已打开，命中在第 ${line} 行附近` : '已打开目标笔记');
}

function createPanelHtml() {
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
				type: SETTING_TYPE_OBJECT,
				public: false,
				section: SETTINGS_SECTION,
				storage: SETTING_STORAGE_FILE,
				label: 'Note stats cache',
			},
		});

		await loadStats();

		panelHandle = await joplin.views.panels.create(PANEL_ID);
		await joplin.views.panels.onMessage(panelHandle, async message => {
			if (message && message.type === 'ready') {
				postPanelMessage({ type: 'init', payload: { request: lastSearchRequest } });
				refreshBaseCache('初始化').catch(() => {});
				return;
			}
			if (message && message.type === 'refreshIndex') {
				await refreshBaseCache('手动刷新');
				if (String(lastSearchRequest.query || '').trim()) await runSearch(lastSearchRequest);
				return;
			}
			if (message && message.type === 'search') {
				await runSearch(Object.assign({}, lastSearchRequest, message.payload || {}));
				return;
			}
			if (message && message.type === 'openResult' && message.payload) {
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
				await refreshBaseCache('命令触发');
				if (String(lastSearchRequest.query || '').trim()) await runSearch(lastSearchRequest);
			},
		});

		await joplin.views.toolbarButtons.create('searchWorkbenchToggleButton', 'searchWorkbench.togglePanel', 'noteToolbar');
		await joplin.views.menuItems.create('searchWorkbenchToggleMenu', 'searchWorkbench.togglePanel', 'tools');
		await joplin.views.menuItems.create('searchWorkbenchRefreshMenu', 'searchWorkbench.refreshIndex', 'tools');

		await joplin.workspace.onNoteSelectionChange(async () => {
			await recordSelectedNoteUsage();
		});

		await joplin.workspace.onNoteChange(async () => {
			refreshBaseCache('笔记变化').catch(() => {});
		});

		await joplin.workspace.onSyncComplete(async () => {
			refreshBaseCache('同步完成').catch(() => {});
		});

		await recordSelectedNoteUsage();
		await joplin.views.panels.show(panelHandle, true);
		refreshBaseCache('启动预热').catch(() => {});
	},
});
