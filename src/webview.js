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
			defaultRequest: createDefaultRequest(),
			response: null,
			runtimes: { index: null, search: null },
			meta: {},
			dictionary: {},
			messages: {},
		};
	}

	try {
		const parsed = JSON.parse(node.textContent || '{}');
		return {
			request: { ...createDefaultRequest(), ...(parsed.request || {}) },
			defaultRequest: { ...createDefaultRequest(), ...(parsed.defaultRequest || {}) },
			response: Object.prototype.hasOwnProperty.call(parsed, 'response') ? parsed.response : null,
			runtimes: parsed.runtimes || { index: null, search: null },
			meta: parsed.meta || {},
			dictionary: parsed.dictionary || {},
			messages: parsed.messages || {},
		};
	} catch (_error) {
		return {
			request: createDefaultRequest(),
			defaultRequest: createDefaultRequest(),
			response: null,
			runtimes: { index: null, search: null },
			meta: {},
			dictionary: {},
			messages: {},
		};
	}
}

function format(template, vars) {
	return String(template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
		if (!vars || !Object.prototype.hasOwnProperty.call(vars, key)) return '';
		return String(vars[key]);
	});
}

const state = readInitialState();
const dictionary = state.dictionary || {};
let defaultRequest = { ...createDefaultRequest(), ...(state.defaultRequest || {}) };
let draftRequest = { ...defaultRequest, ...(state.request || {}) };
let draftTimer = null;

function t(key, vars) {
	return format(Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key, vars);
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

async function postCommand(message) {
	try {
		return await webviewApi.postMessage(message);
	} catch (_error) {
		setStatusText(state.messages.messageSendFailed || t('status.messageSendFailed'));
		setStatusDetail(state.messages.postMessageFailed || t('status.postMessageFailed'));
		return null;
	}
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

function applyDraftToForm() {
	if (!$('queryInput')) return;
	$('queryInput').value = draftRequest.query || '';
	if ($('modeSelect')) $('modeSelect').value = draftRequest.mode || 'smart';
	if ($('scopeSelect')) $('scopeSelect').value = draftRequest.scope || 'all';
	if ($('sortBySelect')) $('sortBySelect').value = draftRequest.sortBy || 'relevance';
	if ($('sortDirSelect')) $('sortDirSelect').value = draftRequest.sortDir || 'desc';
	if ($('groupBySelect')) $('groupBySelect').value = draftRequest.groupBy || 'none';
	if ($('notebookInput')) $('notebookInput').value = draftRequest.notebookQuery || '';
	if ($('noteTypeSelect')) $('noteTypeSelect').value = draftRequest.noteType || 'all';
	if ($('dateFieldSelect')) $('dateFieldSelect').value = draftRequest.dateField || 'updated';
	if ($('dateFromInput')) $('dateFromInput').value = draftRequest.dateFrom || '';
	if ($('dateToInput')) $('dateToInput').value = draftRequest.dateTo || '';
	if ($('caseSensitiveInput')) $('caseSensitiveInput').checked = !!draftRequest.caseSensitive;
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
		setStatusText(state.messages.pleaseEnterQuery || t('status.pleaseEnterQuery'));
		setStatusDetail('');
		return;
	}
	setStatusText(t('status.searchingRequest'));
	setStatusDetail(state.messages.searchRequestSent || t('status.searchRequestSent'));
	await postCommand({ name: 'search', payload: { ...draftRequest } });
}

async function sendRefreshIndex() {
	updateDraftFromForm();
	await postCommand({ name: 'draftUpdate', payload: { ...draftRequest } });
	setStatusText(t('status.reindexingRequest'));
	setStatusDetail(state.messages.reindexRequestSent || t('status.reindexRequestSent'));
	await postCommand({ name: 'refreshIndex' });
}

async function sendResetFilters() {
	updateDraftFromForm();
	draftRequest = { ...defaultRequest, query: draftRequest.query || '' };
	applyDraftToForm();
	setStatusText(t('button.resetFilters'));
	setStatusDetail('');
	await postCommand({ name: 'resetFilters' });
}

async function sendClearAll() {
	draftRequest = { ...defaultRequest };
	applyDraftToForm();
	setStatusText(t('button.clearAll'));
	setStatusDetail('');
	await postCommand({ name: 'clearAll' });
}

async function sendToggleAdvanced() {
	await postCommand({ name: 'toggleAdvanced' });
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

	const advancedButton = safeClosest(event.target, '#advancedToggleBtn');
	if (advancedButton) {
		event.preventDefault();
		void sendToggleAdvanced();
		return;
	}

	const resetButton = safeClosest(event.target, '#resetFiltersBtn');
	if (resetButton) {
		event.preventDefault();
		void sendResetFilters();
		return;
	}

	const clearButton = safeClosest(event.target, '#clearAllBtn');
	if (clearButton) {
		event.preventDefault();
		void sendClearAll();
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
void postCommand({ name: 'ready' });
