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

let searchTimer = null;

function $(id) {
	return document.getElementById(id);
}

function debounceSearch() {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(() => {
		webviewApi.postMessage({ type: 'search', payload: { ...state.request } });
	}, 180);
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
	const unique = Array.from(new Set((highlights || []).filter(Boolean))).sort((a, b) => b.length - a.length).slice(0, 12);
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
	const meta = $('metaText');
	const response = state.response;
	if (!response) {
		root.innerHTML = '<div class="empty">还没有结果。</div>';
		meta.textContent = '';
		return;
	}

	meta.textContent = `分组 ${response.groups.length} · 结果 ${response.resultCount}`;
	if (!response.groups.length) {
		root.innerHTML = '<div class="empty">没有匹配结果。</div>';
		return;
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
										<div class="result-title">${highlightText(item.title, item.snippets?.[0]?.highlights || [])}</div>
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
}

function applyRequestToForm(request) {
	$('queryInput').value = request.query || '';
	$('modeSelect').value = request.mode || 'smart';
	$('scopeSelect').value = request.scope || 'all';
	$('sortBySelect').value = request.sortBy || 'relevance';
	$('sortDirSelect').value = request.sortDir || 'desc';
	$('groupBySelect').value = request.groupBy || 'none';
	$('notebookInput').value = request.notebookQuery || '';
	$('noteTypeSelect').value = request.noteType || 'all';
	$('dateFieldSelect').value = request.dateField || 'updated';
	$('dateFromInput').value = request.dateFrom || '';
	$('dateToInput').value = request.dateTo || '';
	$('caseSensitiveInput').checked = !!request.caseSensitive;
}

function updateRequestFromForm() {
	state.request = {
		query: $('queryInput').value,
		mode: $('modeSelect').value,
		scope: $('scopeSelect').value,
		caseSensitive: $('caseSensitiveInput').checked,
		noteType: $('noteTypeSelect').value,
		notebookQuery: $('notebookInput').value,
		dateField: $('dateFieldSelect').value,
		dateFrom: $('dateFromInput').value,
		dateTo: $('dateToInput').value,
		sortBy: $('sortBySelect').value,
		sortDir: $('sortDirSelect').value,
		groupBy: $('groupBySelect').value,
	};
}

function bindForm() {
	['queryInput','modeSelect','scopeSelect','sortBySelect','sortDirSelect','groupBySelect','notebookInput','noteTypeSelect','dateFieldSelect','dateFromInput','dateToInput','caseSensitiveInput']
		.forEach(id => {
			$(id).addEventListener('input', () => {
				updateRequestFromForm();
				debounceSearch();
			});
			$(id).addEventListener('change', () => {
				updateRequestFromForm();
				debounceSearch();
			});
		});

	$('refreshIndexBtn').addEventListener('click', () => {
		webviewApi.postMessage({ type: 'refreshIndex' });
	});

	document.addEventListener('click', event => {
		const button = event.target.closest('.snippet-item');
		if (!button) return;
		webviewApi.postMessage({
			type: 'openResult',
			payload: {
				noteId: button.dataset.noteId,
				sectionSlug: button.dataset.sectionSlug || '',
				line: Number(button.dataset.line || '0'),
			},
		});
	});
}

webviewApi.onMessage(message => {
	if (message.type === 'init') {
		state.request = { ...state.request, ...(message.payload?.request || {}) };
		applyRequestToForm(state.request);
		return;
	}
	if (message.type === 'status') {
		$('statusText').textContent = message.text || '准备就绪';
		return;
	}
	if (message.type === 'results') {
		state.response = message.payload;
		$('statusText').textContent = message.payload?.statusText || '完成';
		renderResults();
	}
});

document.addEventListener('DOMContentLoaded', () => {
	bindForm();
	renderResults();
	webviewApi.postMessage({ type: 'ready' });
});
