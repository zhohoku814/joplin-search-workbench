function $(id) {
	return document.getElementById(id);
}

function createDefaultRequest() {
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

function readInitialState() {
	const node = $('initialState');
	if (!node) {
		return {
			request: createDefaultRequest(),
			response: null,
			runtimes: { index: null, search: null },
			meta: {},
		};
	}

	try {
		const parsed = JSON.parse(node.textContent || '{}');
		return {
			request: { ...createDefaultRequest(), ...(parsed.request || {}) },
			response: Object.prototype.hasOwnProperty.call(parsed, 'response') ? parsed.response : null,
			runtimes: parsed.runtimes || { index: null, search: null },
			meta: parsed.meta || {},
		};
	} catch (_error) {
		return {
			request: createDefaultRequest(),
			response: null,
			runtimes: { index: null, search: null },
			meta: {},
		};
	}
}

const state = readInitialState();
let draftRequest = { ...createDefaultRequest(), ...(state.request || {}) };
let draftTimer = null;

function setStatusText(text) {
	const node = $('statusText');
	if (node) node.textContent = text;
}

function setStatusDetail(text) {
	const node = $('statusDetail');
	if (node) node.textContent = text || '';
}

function setMetaText(text) {
	const node = $('metaText');
	if (node) node.textContent = text || '';
}

function safeClosest(target, selector) {
	if (!target || !target.closest) return null;
	return target.closest(selector);
}

async function postCommand(message) {
	try {
		return await webviewApi.postMessage(message);
	} catch (_error) {
		setStatusText('消息发送失败');
		setStatusDetail('webviewApi.postMessage 调用失败');
		return null;
	}
}

function escapeHtml(text) {
	return String(text || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function escapeRegExp(text) {
	return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(text, highlights) {
	let html = escapeHtml(text || '');
	const unique = Array.from(new Set((highlights || []).filter(Boolean)))
		.sort((a, b) => b.length - a.length)
		.slice(0, 12);
	for (const item of unique) {
		html = html.replace(new RegExp(escapeRegExp(escapeHtml(item)), 'gi'), match => `<mark>${match}</mark>`);
	}
	return html;
}

function formatTime(ts) {
	if (!ts) return '—';
	return new Date(ts).toLocaleString();
}

function runtimePriority(runtime) {
	if (!runtime) return 0;
	if (runtime.state === 'running') return 5;
	if (runtime.state === 'error') return 4;
	if (runtime.state === 'warning') return 3;
	if (runtime.state === 'done') return 2;
	return 1;
}

function getPrimaryRuntime() {
	const runtimes = state.runtimes || { index: null, search: null };
	const candidates = [runtimes.search, runtimes.index].filter(Boolean);
	candidates.sort((a, b) => runtimePriority(b) - runtimePriority(a));
	return candidates[0] || null;
}

function renderHeaderStatus() {
	const primary = getPrimaryRuntime();
	if (primary) {
		setStatusText(primary.statusText || '准备就绪');
		setStatusDetail(primary.detail || '');
	} else if (state.response && state.response.statusText) {
		setStatusText(state.response.statusText);
		setStatusDetail('');
	} else {
		setStatusText('准备就绪');
		setStatusDetail('');
	}

	if (state.response) {
		setMetaText(`分组 ${state.response.groups.length} · 结果 ${state.response.resultCount}`);
	} else {
		setMetaText('');
	}
}

function renderRuntimeCards() {
	const root = $('runtimeRoot');
	if (!root) return;
	const order = ['index', 'search'];
	const cards = order
		.map(kind => (state.runtimes || {})[kind])
		.filter(Boolean)
		.map(runtime => {
			const percentText = runtime.percent == null ? '—' : `${runtime.percent}%`;
			const progressWidth = runtime.percent == null ? 0 : Math.max(0, Math.min(100, runtime.percent));
			const errors = Array.isArray(runtime.errors) ? runtime.errors : [];
			return `
				<section class="runtime-card ${escapeHtml(runtime.state || 'idle')}">
					<div class="runtime-head">
						<div class="runtime-kind">${runtime.kind === 'index' ? '索引状态' : '搜索状态'}</div>
						<div class="runtime-phase">${escapeHtml(runtime.phase || '')}</div>
					</div>
					<div class="runtime-main">
						<div class="runtime-line"><span>${escapeHtml(runtime.statusText || '—')}</span><strong>${escapeHtml(percentText)}</strong></div>
						<div class="runtime-progress ${runtime.percent == null ? 'indeterminate' : ''}">
							<div class="runtime-progress-fill" style="width:${progressWidth}%"></div>
						</div>
						<div class="runtime-detail">${escapeHtml(runtime.detail || '') || '—'}</div>
						<div class="runtime-stats">已处理 ${escapeHtml(String(runtime.processed || 0))}${runtime.total ? ` / ${escapeHtml(String(runtime.total))}` : ''}</div>
						${runtime.currentLabel ? `<div class="runtime-current">当前：${escapeHtml(runtime.currentLabel)}</div>` : ''}
						${errors.length ? `<div class="runtime-errors">${errors.map(item => `<div class="runtime-error-item"><span>${escapeHtml(item.stage || 'error')}</span><strong>${escapeHtml(item.item || '')}</strong><em>${escapeHtml(item.message || '')}</em></div>`).join('')}</div>` : ''}
					</div>
				</section>
			`;
		});
	root.innerHTML = cards.length ? cards.join('') : '';
}

function renderResults() {
	const root = $('resultsRoot');
	if (!root) return;
	if (!state.response) {
		root.innerHTML = '<div class="empty">还没有结果。</div>';
		renderHeaderStatus();
		return;
	}
	if (!state.response.groups.length) {
		root.innerHTML = '<div class="empty">没有匹配结果。</div>';
		renderHeaderStatus();
		return;
	}

	root.innerHTML = state.response.groups.map(group => `
		<section class="result-group">
			<div class="group-title">${escapeHtml(group.label)} <span>${group.items.length}</span></div>
			<div class="group-list">
				${group.items.map(item => {
					const snippets = (item.snippets || []).map(snippet => `
						<button class="snippet-item" data-note-id="${item.noteId}" data-section-slug="${snippet.sectionSlug || ''}" data-line="${snippet.line || 0}">
							<div class="snippet-meta">
								<span class="badge">${escapeHtml(snippet.blockType)}</span>
								<span>行 ${snippet.line || '标题'}</span>
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
									<div class="result-path">${escapeHtml(item.folderPath)} · ${item.noteType === 'todo' ? '待办' : '笔记'}</div>
								</div>
								<div class="result-side">
									<div>分数 ${Math.round(item.score)}</div>
									<div>使用 ${item.usageCount || 0}</div>
								</div>
							</div>
							<div class="result-times">
								<span>改：${escapeHtml(formatTime(item.updatedTime))}</span>
								<span>建：${escapeHtml(formatTime(item.createdTime))}</span>
								<span>看：${escapeHtml(formatTime(item.lastViewed))}</span>
							</div>
							<div class="snippet-list">${snippets}</div>
						</article>
					`;
				}).join('')}
			</div>
		</section>
	`).join('');
	renderHeaderStatus();
}

function applyDraftToForm() {
	if (!$('queryInput')) return;
	$('queryInput').value = draftRequest.query || '';
	$('modeSelect').value = draftRequest.mode || 'smart';
	$('scopeSelect').value = draftRequest.scope || 'all';
	$('sortBySelect').value = draftRequest.sortBy || 'relevance';
	$('sortDirSelect').value = draftRequest.sortDir || 'desc';
	$('groupBySelect').value = draftRequest.groupBy || 'none';
	$('notebookInput').value = draftRequest.notebookQuery || '';
	$('noteTypeSelect').value = draftRequest.noteType || 'all';
	$('dateFieldSelect').value = draftRequest.dateField || 'updated';
	$('dateFromInput').value = draftRequest.dateFrom || '';
	$('dateToInput').value = draftRequest.dateTo || '';
	$('caseSensitiveInput').checked = !!draftRequest.caseSensitive;
}

function updateDraftFromForm() {
	draftRequest = {
		query: $('queryInput') ? $('queryInput').value : '',
		mode: $('modeSelect') ? $('modeSelect').value : 'smart',
		scope: $('scopeSelect') ? $('scopeSelect').value : 'all',
		caseSensitive: $('caseSensitiveInput') ? !!$('caseSensitiveInput').checked : false,
		noteType: $('noteTypeSelect') ? $('noteTypeSelect').value : 'all',
		notebookQuery: $('notebookInput') ? $('notebookInput').value : '',
		dateField: $('dateFieldSelect') ? $('dateFieldSelect').value : 'updated',
		dateFrom: $('dateFromInput') ? $('dateFromInput').value : '',
		dateTo: $('dateToInput') ? $('dateToInput').value : '',
		sortBy: $('sortBySelect') ? $('sortBySelect').value : 'relevance',
		sortDir: $('sortDirSelect') ? $('sortDirSelect').value : 'desc',
		groupBy: $('groupBySelect') ? $('groupBySelect').value : 'none',
	};
}

function scheduleDraftSync() {
	updateDraftFromForm();
	clearTimeout(draftTimer);
	draftTimer = setTimeout(() => {
		void postCommand({ name: 'draftUpdate', payload: { ...draftRequest } });
	}, 60);
}

async function sendSearch() {
	updateDraftFromForm();
	if (!draftRequest.query.trim()) {
		setStatusText('请输入搜索词。');
		setStatusDetail('');
		return;
	}
	setStatusText('正在发起搜索...');
	setStatusDetail('请求已经发给插件主线程，等待结果返回');
	await postCommand({ name: 'search', payload: { ...draftRequest } });
}

async function sendRefreshIndex() {
	updateDraftFromForm();
	await postCommand({ name: 'draftUpdate', payload: { ...draftRequest } });
	setStatusText('正在请求重建索引...');
	setStatusDetail('请求已经发给插件主线程，等待状态更新');
	await postCommand({ name: 'refreshIndex' });
}

document.addEventListener('keydown', event => {
	const target = event.target;
	if (!target || target.id !== 'queryInput') return;
	if (event.key !== 'Enter') return;
	event.preventDefault();
	void sendSearch();
}, true);

document.addEventListener('input', event => {
	const target = event.target;
	if (!target || !target.id) return;
	if (![
		'queryInput',
		'notebookInput',
		'dateFromInput',
		'dateToInput',
	].includes(target.id)) return;
	scheduleDraftSync();
}, true);

document.addEventListener('change', event => {
	const target = event.target;
	if (!target || !target.id) return;
	if (![
		'modeSelect',
		'scopeSelect',
		'sortBySelect',
		'sortDirSelect',
		'groupBySelect',
		'noteTypeSelect',
		'dateFieldSelect',
		'caseSensitiveInput',
		'dateFromInput',
		'dateToInput',
	].includes(target.id)) return;
	scheduleDraftSync();
}, true);

document.addEventListener('click', event => {
	const searchButton = safeClosest(event.target, '#searchBtn');
	if (searchButton) {
		event.preventDefault();
		void sendSearch();
		return;
	}

	const refreshButton = safeClosest(event.target, '#refreshIndexBtn');
	if (refreshButton) {
		event.preventDefault();
		void sendRefreshIndex();
		return;
	}

	const snippetButton = safeClosest(event.target, '.snippet-item');
	if (!snippetButton) return;
	void postCommand({
		name: 'openResult',
		payload: {
			noteId: snippetButton.dataset.noteId,
			sectionSlug: snippetButton.dataset.sectionSlug || '',
			line: Number(snippetButton.dataset.line || '0'),
		},
	});
}, true);

applyDraftToForm();
renderRuntimeCards();
renderResults();
renderHeaderStatus();
void postCommand({ name: 'ready' });
