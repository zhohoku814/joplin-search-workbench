const state = {
	request: {
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
	},
	response: null,
};

const watchedFieldIds = new Set([
	'queryInput',
	'modeSelect',
	'scopeSelect',
	'sortBySelect',
	'sortDirSelect',
	'groupBySelect',
	'notebookInput',
	'noteTypeSelect',
	'dateFieldSelect',
	'dateFromInput',
	'dateToInput',
	'caseSensitiveInput',
]);

let searchTimer = null;
let readyPingTimer = null;
let readyAcked = false;
let booted = false;

function $(id) {
	return document.getElementById(id);
}

function hasCoreDom() {
	return !!$('queryInput') && !!$('resultsRoot') && !!$('statusText');
}

function setStatusText(text) {
	const node = $('statusText');
	if (node) node.textContent = text;
}

function setMetaText(text) {
	const node = $('metaText');
	if (node) node.textContent = text;
}

function safeClosest(target, selector) {
	if (!target || !target.closest) return null;
	return target.closest(selector);
}

function safePostMessage(message) {
	try {
		return webviewApi.postMessage(message);
	} catch (_error) {
		setStatusText('消息桥发送失败');
		return Promise.resolve(null);
	}
}

function stopReadyPings() {
	if (readyPingTimer) clearInterval(readyPingTimer);
	readyPingTimer = null;
}

function startReadyPings() {
	stopReadyPings();
	let count = 0;
	readyPingTimer = setInterval(() => {
		count += 1;
		safePostMessage({ type: 'ready' });
		if (readyAcked || count >= 20) stopReadyPings();
	}, 500);
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

function renderResults() {
	const root = $('resultsRoot');
	if (!root) return false;

	const response = state.response;
	if (!response) {
		root.innerHTML = '<div class="empty">还没有结果。</div>';
		setMetaText('');
		return true;
	}

	setMetaText(`分组 ${response.groups.length} · 结果 ${response.resultCount}`);
	if (!response.groups.length) {
		root.innerHTML = '<div class="empty">没有匹配结果。</div>';
		return true;
	}

	root.innerHTML = response.groups.map(group => {
		return `
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
		`;
	}).join('');

	return true;
}

function applyRequestToForm(request) {
	const queryInput = $('queryInput');
	const modeSelect = $('modeSelect');
	const scopeSelect = $('scopeSelect');
	const sortBySelect = $('sortBySelect');
	const sortDirSelect = $('sortDirSelect');
	const groupBySelect = $('groupBySelect');
	const notebookInput = $('notebookInput');
	const noteTypeSelect = $('noteTypeSelect');
	const dateFieldSelect = $('dateFieldSelect');
	const dateFromInput = $('dateFromInput');
	const dateToInput = $('dateToInput');
	const caseSensitiveInput = $('caseSensitiveInput');

	if (!queryInput || !modeSelect || !scopeSelect || !sortBySelect || !sortDirSelect || !groupBySelect || !notebookInput || !noteTypeSelect || !dateFieldSelect || !dateFromInput || !dateToInput || !caseSensitiveInput) {
		return false;
	}

	queryInput.value = request.query || '';
	modeSelect.value = request.mode || 'smart';
	scopeSelect.value = request.scope || 'all';
	sortBySelect.value = request.sortBy || 'relevance';
	sortDirSelect.value = request.sortDir || 'desc';
	groupBySelect.value = request.groupBy || 'none';
	notebookInput.value = request.notebookQuery || '';
	noteTypeSelect.value = request.noteType || 'all';
	dateFieldSelect.value = request.dateField || 'updated';
	dateFromInput.value = request.dateFrom || '';
	dateToInput.value = request.dateTo || '';
	caseSensitiveInput.checked = !!request.caseSensitive;
	return true;
}

function updateRequestFromForm() {
	state.request = {
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

function sendSearch(immediate) {
	updateRequestFromForm();
	clearTimeout(searchTimer);
	const run = () => {
		setStatusText(state.request.query.trim() ? '正在搜索...' : '请输入搜索词。');
		safePostMessage({ type: 'search', payload: { ...state.request } });
	};
	if (immediate) {
		run();
	} else {
		searchTimer = setTimeout(run, 180);
	}
}

function bindEventsOnce() {
	if (bindEventsOnce.done) return;
	bindEventsOnce.done = true;

	document.addEventListener('input', event => {
		const target = event.target;
		if (!target || !target.id || !watchedFieldIds.has(target.id)) return;
		sendSearch(false);
	}, true);

	document.addEventListener('change', event => {
		const target = event.target;
		if (!target || !target.id || !watchedFieldIds.has(target.id)) return;
		sendSearch(false);
	}, true);

	document.addEventListener('keydown', event => {
		const target = event.target;
		if (!target || target.id !== 'queryInput') return;
		if (event.key !== 'Enter') return;
		event.preventDefault();
		sendSearch(true);
	}, true);

	document.addEventListener('click', event => {
		const searchButton = safeClosest(event.target, '#searchBtn');
		if (searchButton) {
			event.preventDefault();
			sendSearch(true);
			return;
		}

		const refreshButton = safeClosest(event.target, '#refreshIndexBtn');
		if (refreshButton) {
			event.preventDefault();
			setStatusText('正在请求重建索引...');
			safePostMessage({ type: 'refreshIndex' });
			return;
		}

		const snippetButton = safeClosest(event.target, '.snippet-item');
		if (!snippetButton) return;
		safePostMessage({
			type: 'openResult',
			payload: {
				noteId: snippetButton.dataset.noteId,
				sectionSlug: snippetButton.dataset.sectionSlug || '',
				line: Number(snippetButton.dataset.line || '0'),
			},
		});
	}, true);
}

bindEventsOnce.done = false;

function boot(attempt) {
	if (booted) return;
	if (!hasCoreDom()) {
		if (attempt < 60) setTimeout(() => boot(attempt + 1), 100);
		return;
	}

	booted = true;
	bindEventsOnce();
	renderResults();
	setStatusText('准备就绪');
	startReadyPings();
	safePostMessage({ type: 'ready' });
}

webviewApi.onMessage(message => {
	if (!message) return;

	if (message.type === 'init') {
		readyAcked = true;
		stopReadyPings();
		state.request = { ...state.request, ...((message.payload && message.payload.request) || {}) };
		if (!applyRequestToForm(state.request)) {
			setTimeout(() => applyRequestToForm(state.request), 100);
		}
		return;
	}

	if (message.type === 'status') {
		readyAcked = true;
		setStatusText(message.text || '准备就绪');
		return;
	}

	if (message.type === 'results') {
		readyAcked = true;
		state.response = message.payload || null;
		setStatusText((message.payload && message.payload.statusText) || '完成');
		if (!renderResults()) {
			setTimeout(renderResults, 100);
		}
	}
});

boot(0);
