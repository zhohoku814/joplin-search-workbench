(function(root, factory) {
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = factory();
		return;
	}
	root.SearchWorkbenchPanelState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
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

	function cloneRequest(input) {
		return {
			...createDefaultRequest(),
			...(input || {}),
		};
	}

	function cloneServerState(input) {
		const source = input || {};
		return {
			request: cloneRequest(source.request),
			response: Object.prototype.hasOwnProperty.call(source, 'response') ? source.response : null,
			runtimes: {
				index: source.runtimes && Object.prototype.hasOwnProperty.call(source.runtimes, 'index') ? source.runtimes.index : null,
				search: source.runtimes && Object.prototype.hasOwnProperty.call(source.runtimes, 'search') ? source.runtimes.search : null,
			},
			meta: source.meta && typeof source.meta === 'object' ? { ...source.meta } : {},
		};
	}

	function createClientState(initialServerState) {
		const server = cloneServerState(initialServerState);
		return {
			server,
			draftRequest: cloneRequest(server.request),
		};
	}

	function receiveServerState(state, message) {
		if (!message || message.name !== 'state') return state;
		const nextServer = cloneServerState(message.payload);
		const nextState = {
			...state,
			server: nextServer,
		};
		if (message.syncForm) {
			nextState.draftRequest = cloneRequest(nextServer.request);
		}
		return nextState;
	}

	function updateDraftRequest(state, patch) {
		return {
			...state,
			draftRequest: {
				...cloneRequest(state && state.draftRequest),
				...(patch || {}),
			},
		};
	}

	return {
		createDefaultRequest,
		cloneRequest,
		cloneServerState,
		createClientState,
		receiveServerState,
		updateDraftRequest,
	};
});
