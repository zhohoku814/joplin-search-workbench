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
	runtimes: {
		index: null,
		search: null,
	},
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
let bridgeTimeoutTimer = null;
let readyAcked = false;
let booted = false;

function $(id) {
	return document.getElementById(id);
}

function hasCoreDom() {
	return !!$('queryInput') && !!$('resultsRoot') && !!$('statusText') && !!$('runtimeRoot');
}

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

function clearBridgeTimeout() {
	if (bridgeTimeoutTimer) clearTimeout(bridgeTimeoutTimer);
	bridgeTimeoutTimer = null;
}

function armBridgeTimeout(actionLabel) {
	clearBridgeTimeout();
	bridgeTimeoutTimer = setTimeout(() => {
		setStatusText(`${actionLabel}没有收到插件回执`);
		setStatusDetail('不是正常等待，大概率是旧版本仍在运行，或插件主线程启动失败。请重装最新版插件并重启 Joplin。');
		state.runtimes.index = {
			kind: 'index',
			phase: 'bridge-timeout',
			state: 'error',
			statusText: `${actionLabel}没有收到插件回执`,
			detail: '前端发出消息后，主线程没有任何 init / ack / runtime / results 返回。',
			processed: 0,
			total: 0,
			errors: [{ stage: 'bridge', item: actionLabel, message: '未收到主线程回执' }],
		};
		renderRuntimeCards();
		renderHeaderStatus();
	}, 2500);
}

function safePostMessage(message) {
	try {
		return Promise.resolve(webviewApi.postMessage(message));
	} catch (_error) {
		setStatusText('消息桥发送失败');
		setStatusDetail('webviewApi.postMessage 调用失败');
		return Promise.resolve({ ok: false, action: 'post-exception' });
	}
}

function sendCommand(message, actionLabel, waitingText, waitingDetail) {
	setStatusText(waitingText);
	setStatusDetail(waitingDetail);
	armBridgeTimeout(actionLabel);
	return safePostMessage(message).then(response => {
		if (response && response.ok) {
			clearBridgeTimeout();
			return response;
		}
		clearBridgeTimeout();
		const errorText = response && response.error ? response.error : '主线程没有确认接单';
		setStatusText(`${actionLabel}未被主线程确认`);
		setStatusDetail(errorText);
		state.runtimes.index = {
			kind: 'index',
			phase: 'command-rejected',
			state: 'error',
			statusText: `${actionLabel}未被主线程确认`,
			detail: errorText,
			processed: 0,
			total: 0,
			errors: [{ stage: 'command', item: actionLabel, message: errorText }],
		};
		renderRuntimeCards();
		renderHeaderStatus();
		return response;
	}).catch(error => {
		clearBridgeTimeout();
		setStatusText(`${actionLabel}消息发送失败`);
		setStatusDetail(String(error && error.message ? error.message : error));
		return { ok: false, action: 'promise-rejected', error: String(error && error.message ? error.message : error) };
	});
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

function runtimePriority(runtime) {
	if (!runtime) return 0;
	if (runtime.state === 'running') return 5;
	if (runtime.state === 'error') return 4;
	if (runtime.state === 'warning') return 3;
	if (runtime.state === 'done') return 2;
	return 1;
}

function getPrimaryRuntime() {
	const candidates = [state.runtimes.search, state.runtimes.index].filter(Boolean);
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
	if (!root) return false;

	const order = ['index', 'search'];
	const cards = order
		.map(kind => state.runtimes[kind])
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
	return true;
}

function renderResults() {
	const root = $('resultsRoot');
	if (!root) return false;

	const response = state.response;
	if (!response) {
		root.innerHTML = '<div class="empty">还没有结果。</div>';
		renderHeaderStatus();
		return true;
	}

	renderHeaderStatus();
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
		if (!state.request.query.trim()) {
			setStatusText('请输入搜索词。');
			setStatusDetail('');
			return;
		}
		void sendCommand(
			{ type: 'search', payload: { ...state.request } },
			'搜索',
			'正在发起搜索...',
			'等待插件主线程接手搜索请求',
		);
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
			void sendCommand(
				{ type: 'refreshIndex' },
				'重建索引',
				'正在请求重建索引...',
				'等待插件主线程接手索引任务',
			);
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
	renderRuntimeCards();
	renderResults();
	renderHeaderStatus();
	startReadyPings();
	void sendCommand(
		{ type: 'ready' },
		'初始化握手',
		'正在连接插件主线程...',
		'等待主线程返回初始化状态',
	);
}

webviewApi.onMessage(message => {
	if (!message) return;
	clearBridgeTimeout();

	if (message.type === 'ack') {
		readyAcked = true;
		return;
	}

	if (message.type === 'init') {
		readyAcked = true;
		stopReadyPings();
		state.request = { ...state.request, ...((message.payload && message.payload.request) || {}) };
		state.runtimes = { ...state.runtimes, ...((message.payload && message.payload.runtimes) || {}) };
		if (!applyRequestToForm(state.request)) {
			setTimeout(() => applyRequestToForm(state.request), 100);
		}
		renderRuntimeCards();
		renderHeaderStatus();
		return;
	}

	if (message.type === 'runtime') {
		readyAcked = true;
		if (message.payload && message.payload.kind) {
			state.runtimes[message.payload.kind] = message.payload;
			renderRuntimeCards();
			renderHeaderStatus();
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
		if (!renderResults()) {
			setTimeout(renderResults, 100);
		}
	}
});

boot(0);
