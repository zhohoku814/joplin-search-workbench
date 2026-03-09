const test = require('node:test');
const assert = require('node:assert/strict');
const {
	createClientState,
	createDefaultRequest,
	receiveServerState,
	updateDraftRequest,
} = require('../src/panelClientState');

test('client state keeps draft separate from server state', () => {
	const initial = createClientState({
		request: { ...createDefaultRequest(), query: 'old' },
		response: null,
		runtimes: { index: null, search: null },
		meta: {},
	});
	const withDraft = updateDraftRequest(initial, { query: 'draft text' });
	const next = receiveServerState(withDraft, {
		name: 'state',
		syncForm: false,
		payload: {
			request: { ...createDefaultRequest(), query: 'server text' },
			response: { resultCount: 1, groups: [] },
			runtimes: { index: { state: 'done' }, search: null },
			meta: { revision: 2 },
		},
	});

	assert.equal(next.draftRequest.query, 'draft text');
	assert.equal(next.server.request.query, 'server text');
	assert.equal(next.server.response.resultCount, 1);
});

test('syncForm updates draft from authoritative server request', () => {
	const initial = createClientState({
		request: { ...createDefaultRequest(), query: 'old' },
		response: null,
		runtimes: { index: null, search: null },
		meta: {},
	});
	const withDraft = updateDraftRequest(initial, { query: 'draft text', scope: 'title' });
	const next = receiveServerState(withDraft, {
		name: 'state',
		syncForm: true,
		payload: {
			request: { ...createDefaultRequest(), query: 'server text', scope: 'body' },
			response: null,
			runtimes: { index: null, search: { state: 'running' } },
			meta: { revision: 3 },
		},
	});

	assert.equal(next.draftRequest.query, 'server text');
	assert.equal(next.draftRequest.scope, 'body');
});
