'use strict';

const { createUi } = require('./i18n');

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_PROGRESS_EVERY = 25;

function pause(ms = 0) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function normaliseNewlines(text) {
	return String(text || '').replace(/\r\n/g, '\n');
}

function parseSmartTokens(query) {
	const tokens = [];
	const phrases = [];
	const regex = /"([^"]+)"|(\S+)/g;
	let match = null;
	while ((match = regex.exec(String(query || ''))) !== null) {
		const value = String(match[1] || match[2] || '').trim();
		if (!value) continue;
		tokens.push(value);
		if (match[1]) phrases.push(value);
	}
	return { tokens, phrases };
}

function toComparable(text, caseSensitive) {
	const value = String(text || '');
	return caseSensitive ? value : value.toLowerCase();
}

function literalOccurrences(text, needle, caseSensitive) {
	if (!needle) return 0;
	const haystack = toComparable(text, caseSensitive);
	const target = toComparable(needle, caseSensitive);
	let count = 0;
	let position = 0;
	while (true) {
		const found = haystack.indexOf(target, position);
		if (found < 0) break;
		count += 1;
		position = found + Math.max(1, target.length);
	}
	return count;
}

function safeRegex(query, caseSensitive) {
	try {
		return new RegExp(String(query || ''), caseSensitive ? 'g' : 'gi');
	} catch (_error) {
		return null;
	}
}

function matchText(text, request) {
	const query = String(request?.query || '').trim();
	if (!query) return { matched: false, hits: 0, highlights: [] };

	if (request.mode === 'regex') {
		const regex = safeRegex(query, request.caseSensitive);
		if (!regex) return { matched: false, hits: 0, highlights: [] };
		const matches = String(text || '').match(regex) || [];
		return {
			matched: matches.length > 0,
			hits: matches.length,
			highlights: Array.from(new Set(matches)).slice(0, 10),
		};
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

function buildLineMeta(body, slugify) {
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
			sectionSlug = slugify ? slugify(sectionText) : sectionText;
		}
		lineMeta.push({
			lineNumber: i + 1,
			sectionText,
			sectionSlug,
			inCodeFence,
		});
		if (/^```/.test(line.trim())) inCodeFence = !inCodeFence;
	}

	return { lines, lineMeta };
}

function detectBlockType(lines, meta, index) {
	const line = lines[index] || '';
	const trimmed = line.trim();
	if (index === 0 && trimmed.length && !/^#{1,6}\s/.test(trimmed)) return 'paragraph';
	if (/^(#{1,6})\s+/.test(trimmed)) return 'heading';
	if (meta[index]?.inCodeFence || /^```/.test(trimmed)) return 'code';
	if (/^>\s?/.test(trimmed)) return 'quote';
	if (/^[-*+]\s+\[[ xX]\]/.test(trimmed) || /^\d+\.\s+\[[ xX]\]/.test(trimmed)) return 'task';
	if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) return 'list';
	if (/^\|.*\|$/.test(trimmed)) return 'table';
	return 'paragraph';
}

function extractSnippets(note, request) {
	const snippets = [];
	const seenLines = new Set();
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

	for (let i = 0; i < note.lines.length && snippets.length < 4; i += 1) {
		const line = note.lines[i];
		const lineMatch = matchText(line, request);
		if (!lineMatch.matched || seenLines.has(i)) continue;
		seenLines.add(i);
		const parts = [note.lines[i - 1], line, note.lines[i + 1]]
			.filter(Boolean)
			.map(s => String(s || '').trim())
			.filter(Boolean);
		const text = parts.join(' ⏎ ');
		const meta = note.lineMeta[i] || {};
		snippets.push({
			text,
			line: i + 1,
			blockType: detectBlockType(note.lines, note.lineMeta, i),
			sectionText: meta.sectionText || '',
			sectionSlug: meta.sectionSlug || '',
			highlights: lineMatch.highlights,
		});
	}

	return snippets;
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

function noteMatchesFilters(note, request, noteStats) {
	if (request.noteType === 'note' && note.is_todo) return false;
	if (request.noteType === 'todo' && !note.is_todo) return false;
	if (String(request.notebookQuery || '').trim()) {
		const folderHaystack = String(note.folderPath || '').toLowerCase();
		if (!folderHaystack.includes(String(request.notebookQuery || '').trim().toLowerCase())) return false;
	}
	let dateValue = 0;
	if (request.dateField === 'created') dateValue = note.created_time;
	if (request.dateField === 'updated') dateValue = note.updated_time;
	if (request.dateField === 'lastViewed') dateValue = (noteStats[note.id] && noteStats[note.id].lastViewed) || 0;
	if (!withinDateRange(dateValue, request.dateFrom, request.dateTo)) return false;
	return true;
}

function scoreResult(note, request, snippets) {
	const titleMatch = matchText(note.title, request);
	const bodyMatch = matchText(note.body, request);
	let score = 0;
	if (titleMatch.matched) score += 120 + titleMatch.hits * 18;
	if (bodyMatch.matched) score += 40 + bodyMatch.hits * 6;
	if (request.mode === 'literal' && request.query && literalOccurrences(note.title, request.query, request.caseSensitive)) score += 50;
	if (request.mode === 'smart') {
		const phrases = parseSmartTokens(request.query).phrases;
		for (const phrase of phrases) {
			score += literalOccurrences(note.title, phrase, request.caseSensitive) * 30;
			score += literalOccurrences(note.body, phrase, request.caseSensitive) * 10;
		}
	}
	if (snippets.length) score += Math.max(0, 20 - snippets[0].line);
	return score;
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

function groupLabel(result, groupBy, ui) {
	if (groupBy === 'folder') {
		const label = result.folderPath || ui.t('group.unknownFolder');
		return { key: label, label };
	}
	if (groupBy === 'noteType') {
		return { key: result.noteType, label: result.noteType === 'todo' ? ui.t('group.noteType.todo') : ui.t('group.noteType.note') };
	}
	if (groupBy === 'updatedMonth') {
		const date = result.updatedTime ? new Date(result.updatedTime) : null;
		const key = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : ui.t('group.unmodified');
		return { key, label: key };
	}
	return { key: 'all', label: ui.t('group.searchResults') };
}

function makeTaskProgress(input) {
	const processed = Number(input?.processed || 0);
	const total = Number(input?.total || 0);
	const rawPercent = total > 0 ? Math.round((processed / total) * 100) : null;
	const percent = rawPercent == null ? null : Math.max(0, Math.min(100, rawPercent));
	return {
		kind: input?.kind || 'search',
		phase: input?.phase || '',
		state: input?.state || 'running',
		statusText: input?.statusText || '',
		detail: input?.detail || '',
		processed,
		total,
		percent,
		currentLabel: input?.currentLabel || '',
		errors: Array.isArray(input?.errors) ? input.errors.slice(-5) : [],
	};
}

async function searchNotesWithProgress(cachedNotes, noteStats, request, options = {}) {
	const notes = Array.isArray(cachedNotes) ? cachedNotes : [];
	const statsMap = noteStats && typeof noteStats === 'object' ? noteStats : {};
	const maxResults = Number(options.maxResults || DEFAULT_MAX_RESULTS);
	const progressEvery = Number(options.progressEvery || DEFAULT_PROGRESS_EVERY);
	const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false;
	const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
	const ui = options.ui && typeof options.ui.t === 'function' ? options.ui : createUi('en');
	const query = String(request?.query || '').trim();

	if (!query) {
		const response = {
			request,
			statusText: ui.t('search.emptyQuery'),
			resultCount: 0,
			groups: [],
		};
		return {
			cancelled: false,
			response,
			progress: makeTaskProgress({
				kind: 'search',
				phase: 'done',
				state: 'done',
				statusText: response.statusText,
				detail: '',
				processed: 0,
				total: 0,
			}),
		};
	}

	if (request.mode === 'regex' && !safeRegex(query, request.caseSensitive)) {
		const response = {
			request,
			statusText: ui.t('search.invalidRegex'),
			resultCount: 0,
			groups: [],
		};
		return {
			cancelled: false,
			response,
			progress: makeTaskProgress({
				kind: 'search',
				phase: 'done',
				state: 'done',
				statusText: response.statusText,
				processed: 0,
				total: 0,
			}),
		};
	}

	const results = [];
	const total = notes.length;
	await onProgress(makeTaskProgress({
		kind: 'search',
		phase: 'scan',
		state: 'running',
		statusText: ui.t('search.searching'),
		detail: total ? ui.t('search.scanProgress', { processed: 0, total }) : ui.t('search.noSearchableNotes'),
		processed: 0,
		total,
		currentLabel: '',
	}));

	for (let i = 0; i < notes.length; i += 1) {
		if (shouldCancel()) return { cancelled: true };
		const note = notes[i];
		if (!noteMatchesFilters(note, request, statsMap)) {
			if ((i + 1) % progressEvery === 0 || i === notes.length - 1) {
				await onProgress(makeTaskProgress({
					kind: 'search',
					phase: 'scan',
					state: 'running',
					statusText: ui.t('search.searching'),
					detail: ui.t('search.scanProgress', { processed: i + 1, total }),
					processed: i + 1,
					total,
					currentLabel: note.title || note.id || '',
				}));
				await pause(0);
			}
			continue;
		}

		const titleText = request.scope === 'body' ? '' : note.title;
		const bodyText = request.scope === 'title' ? '' : note.body;
		const matched = (titleText && matchText(titleText, request).matched) || (bodyText && matchText(bodyText, request).matched);
		if (matched) {
			const snippets = extractSnippets(note, request);
			if (snippets.length) {
				const stats = statsMap[note.id] || { usageCount: 0, lastViewed: 0 };
				results.push({
					noteId: note.id,
					title: note.title,
					folderPath: note.folderPath,
					noteType: note.is_todo ? 'todo' : 'note',
					updatedTime: note.updated_time,
					createdTime: note.created_time,
					lastViewed: stats.lastViewed || 0,
					usageCount: stats.usageCount || 0,
					bodyLength: note.bodyLength,
					score: scoreResult(note, request, snippets),
					snippets,
				});
			}
		}

		if ((i + 1) % progressEvery === 0 || i === notes.length - 1) {
			await onProgress(makeTaskProgress({
				kind: 'search',
				phase: 'scan',
				state: 'running',
				statusText: ui.t('search.searching'),
				detail: ui.t('search.scanProgress', { processed: i + 1, total }),
				processed: i + 1,
				total,
				currentLabel: note.title || note.id || '',
			}));
			await pause(0);
		}
	}

	results.sort((a, b) => compareResults(a, b, request.sortBy, request.sortDir));
	const limited = results.slice(0, maxResults);
	const groupedMap = new Map();
	for (const result of limited) {
		const group = groupLabel(result, request.groupBy, ui);
		if (!groupedMap.has(group.key)) groupedMap.set(group.key, { key: group.key, label: group.label, items: [] });
		groupedMap.get(group.key).items.push(result);
	}

	const response = {
		request,
		statusText: results.length > maxResults ? ui.t('search.hitCountLimited', { count: results.length, max: maxResults }) : ui.t('search.hitCount', { count: results.length }),
		resultCount: results.length,
		groups: Array.from(groupedMap.values()),
	};

	const progress = makeTaskProgress({
		kind: 'search',
		phase: 'done',
		state: 'done',
		statusText: response.statusText,
		detail: total ? ui.t('search.scanProgress', { processed: total, total }) : '',
		processed: total,
		total,
		currentLabel: '',
	});

	return { cancelled: false, response, progress };
}

module.exports = {
	buildLineMeta,
	detectBlockType,
	extractSnippets,
	literalOccurrences,
	makeTaskProgress,
	matchText,
	normaliseNewlines,
	parseSmartTokens,
	pause,
	safeRegex,
	searchNotesWithProgress,
	withinDateRange,
};
