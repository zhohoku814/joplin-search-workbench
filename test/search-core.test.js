const test = require('node:test');
const assert = require('node:assert/strict');
const {
	buildLineMeta,
	makeTaskProgress,
	matchText,
	parseSmartTokens,
	searchNotesWithProgress,
} = require('../src/searchCore');

function sampleNotes() {
	const bodyA = '# Alpha Heading\nhello world\n```js\nconst token = 1;\n```\nsecond line';
	const bodyB = '# Beta Heading\nworld only\n- [ ] todo item';
	const parsedA = buildLineMeta(bodyA, text => text.toLowerCase().replace(/\s+/g, '-'));
	const parsedB = buildLineMeta(bodyB, text => text.toLowerCase().replace(/\s+/g, '-'));
	return [
		{
			id: 'a',
			title: 'Alpha note',
			body: bodyA,
			parent_id: 'folder-a',
			updated_time: 100,
			created_time: 50,
			is_todo: 0,
			todo_completed: 0,
			folderPath: 'Work / Alpha',
			lines: parsedA.lines,
			lineMeta: parsedA.lineMeta,
			bodyLength: bodyA.length,
		},
		{
			id: 'b',
			title: 'Beta task',
			body: bodyB,
			parent_id: 'folder-b',
			updated_time: 200,
			created_time: 150,
			is_todo: 1,
			todo_completed: 0,
			folderPath: 'Inbox / Beta',
			lines: parsedB.lines,
			lineMeta: parsedB.lineMeta,
			bodyLength: bodyB.length,
		},
	];
}

function baseRequest() {
	return {
		query: 'hello world',
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

test('parseSmartTokens keeps quoted phrases together', () => {
	const parsed = parseSmartTokens('alpha "two words" beta');
	assert.deepEqual(parsed.tokens, ['alpha', 'two words', 'beta']);
	assert.deepEqual(parsed.phrases, ['two words']);
});

test('matchText supports literal and regex modes', () => {
	assert.equal(matchText('Hello hello', { query: 'hello', mode: 'literal', caseSensitive: false }).hits, 2);
	assert.equal(matchText('abc-123', { query: '[a-z]+-\\d+', mode: 'regex', caseSensitive: false }).matched, true);
	assert.equal(matchText('abc-123', { query: '(', mode: 'regex', caseSensitive: false }).matched, false);
});

test('searchNotesWithProgress returns hits and emits progress', async () => {
	const notes = sampleNotes();
	const progressEvents = [];
	const result = await searchNotesWithProgress(notes, {}, baseRequest(), {
		progressEvery: 1,
		onProgress: async progress => {
			progressEvents.push(progress);
		},
	});

	assert.equal(result.cancelled, false);
	assert.equal(result.response.resultCount, 1);
	assert.equal(result.response.groups[0].items[0].noteId, 'a');
	assert.ok(progressEvents.some(event => event.kind === 'search' && event.phase === 'scan'));
	assert.equal(result.progress.percent, 100);
	assert.match(result.response.statusText, /命中 1 条/);
});

test('searchNotesWithProgress respects notebook and note type filters', async () => {
	const notes = sampleNotes();
	const request = {
		...baseRequest(),
		query: 'todo',
		noteType: 'todo',
		notebookQuery: 'Inbox',
	};
	const result = await searchNotesWithProgress(notes, {}, request);
	assert.equal(result.response.resultCount, 1);
	assert.equal(result.response.groups[0].items[0].noteId, 'b');
});

test('makeTaskProgress computes bounded percent', () => {
	assert.equal(makeTaskProgress({ kind: 'index', processed: 40, total: 50 }).percent, 80);
	assert.equal(makeTaskProgress({ kind: 'index', processed: 120, total: 100 }).percent, 100);
	assert.equal(makeTaskProgress({ kind: 'index', processed: 3, total: 0 }).percent, null);
});
