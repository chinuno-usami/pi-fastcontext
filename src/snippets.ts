/**
 * Read and merge reported snippets under length budget (PLAN §7). (M2)
 */
import { open, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { truncateLine } from "@earendil-works/pi-coding-agent";
import { formatEntry, formatHeader, formatNotes, utf8Bytes } from "./format.ts";
import { checkPathUnderRoots } from "./inner-tools.ts";
import type { ReportResultItem } from "./inner-tools.ts";

/** Gap of at most 3 lines between ranges → merge (PLAN §7.1). */
const MERGE_GAP_LINES = 3;

export interface SnippetEntry {
	path: string;
	startLine: number;
	endLine: number;
	reason: string;
	/** Numbered body lines (no fences). Absent when omitted for budget / binary. */
	snippet?: string;
	/** True when snippet omitted because of maxOutputBytes. */
	omittedForBudget?: boolean;
	/** True when file looked binary (NUL in first 8KB). */
	binarySkipped?: boolean;
}

export interface BuildSnippetsOptions {
	cwd: string;
	results: ReportResultItem[];
	maxLinesPerSnippet: number;
	maxOutputBytes: number;
	query: string;
	notes?: string;
	/** Optional path roots for jail (defaults to [cwd]). */
	roots?: string[];
}

export interface BuildSnippetsResult {
	entries: SnippetEntry[];
	truncated: boolean;
}

type Tagged = ReportResultItem & { ord: number };

/**
 * Merge overlapping or nearby (<= 3 lines apart) ranges per file,
 * preserving first-occurrence order from the sub-model report.
 */
export function mergeResultRanges(results: ReportResultItem[]): ReportResultItem[] {
	const tagged: Tagged[] = results.map((r, ord) => ({ ...r, ord }));
	const byPath = new Map<string, Tagged[]>();
	for (const item of tagged) {
		const list = byPath.get(item.path);
		if (list) list.push(item);
		else byPath.set(item.path, [item]);
	}

	const merged: Tagged[] = [];
	for (const group of byPath.values()) {
		group.sort((a, b) => a.startLine - b.startLine || a.ord - b.ord);
		const acc: Tagged[] = [];
		for (const item of group) {
			const last = acc[acc.length - 1];
			if (last && item.startLine <= last.endLine + MERGE_GAP_LINES + 1) {
				last.endLine = Math.max(last.endLine, item.endLine);
				last.startLine = Math.min(last.startLine, item.startLine);
				if (item.ord < last.ord) {
					last.reason = item.reason;
					last.ord = item.ord;
				}
			} else {
				acc.push({ ...item });
			}
		}
		merged.push(...acc);
	}

	merged.sort((a, b) => a.ord - b.ord);
	return merged.map(({ path, startLine, endLine, reason }) => ({
		path,
		startLine,
		endLine,
		reason,
	}));
}

/** True if the first 8KB of the file contains a NUL byte. */
export async function isBinaryFile(absPath: string): Promise<boolean> {
	const file = await open(absPath, "r");
	try {
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await file.read(buf, 0, 8192, 0);
		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		await file.close();
	}
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split(/\r?\n/);
	if (text.endsWith("\n") || text.endsWith("\r\n")) {
		lines.pop();
	}
	return lines;
}

/**
 * Format snippet body with line-number prefixes; apply maxLinesPerSnippet
 * and per-line truncateLine. Full start-end is kept on the entry.
 */
export function formatSnippetBody(options: {
	lines: string[];
	startLine: number;
	endLine: number;
	maxLinesPerSnippet: number;
}): { body: string; linesTruncated: boolean; rangeLineCount: number } {
	const { lines, startLine, endLine, maxLinesPerSnippet } = options;
	const fileLineCount = lines.length;
	const clippedStart = Math.max(1, Math.min(startLine, Math.max(fileLineCount, 1)));
	const clippedEnd = Math.max(clippedStart, Math.min(endLine, Math.max(fileLineCount, 1)));
	const rangeLineCount = clippedEnd - clippedStart + 1;
	const take = Math.min(maxLinesPerSnippet, rangeLineCount);
	const width = String(clippedEnd).length;
	const out: string[] = [];
	for (let i = 0; i < take; i++) {
		const lineNo = clippedStart + i;
		const raw = lines[lineNo - 1] ?? "";
		const { text } = truncateLine(raw);
		out.push(`${String(lineNo).padStart(width, " ")}|${text}`);
	}
	const linesTruncated = rangeLineCount > maxLinesPerSnippet;
	if (linesTruncated) {
		out.push(
			`… (共 ${rangeLineCount} 行，用 read offset=${clippedStart} limit=${rangeLineCount} 查看)`,
		);
	}
	return { body: out.join("\n"), linesTruncated, rangeLineCount };
}

function estimateTotalBytes(
	query: string,
	entries: SnippetEntry[],
	notes: string | undefined,
): number {
	const parts: string[] = [formatHeader(query, entries.length), ""];
	for (let i = 0; i < entries.length; i++) {
		parts.push(formatEntry(i + 1, entries[i]!));
		parts.push("");
	}
	const notesLine = formatNotes(notes);
	if (notesLine) parts.push(notesLine);
	while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return utf8Bytes(parts.join("\n") + "\n");
}

/**
 * Merge ranges, read files, build numbered snippets, enforce maxOutputBytes.
 * Over-budget items keep only path:start-end — reason (no fence).
 */
export async function buildSnippets(options: BuildSnippetsOptions): Promise<BuildSnippetsResult> {
	const { cwd, maxLinesPerSnippet, maxOutputBytes, query, notes } = options;
	const roots = options.roots ?? [cwd];
	const merged = mergeResultRanges(options.results);

	const withSnippets: SnippetEntry[] = [];
	for (const item of merged) {
		const check = await checkPathUnderRoots(item.path, roots, {
			cwd,
			mustExist: true,
		});
		if (!check.ok) {
			withSnippets.push({
				path: item.path,
				startLine: item.startLine,
				endLine: item.endLine,
				reason: item.reason,
			});
			continue;
		}

		const rel = relative(cwd, check.resolved);
		const path = rel && !rel.startsWith("..") ? rel : item.path;

		let binary = false;
		try {
			binary = await isBinaryFile(check.resolved);
		} catch {
			withSnippets.push({
				path,
				startLine: item.startLine,
				endLine: item.endLine,
				reason: item.reason,
			});
			continue;
		}

		if (binary) {
			withSnippets.push({
				path,
				startLine: item.startLine,
				endLine: item.endLine,
				reason: item.reason,
				binarySkipped: true,
			});
			continue;
		}

		let text: string;
		try {
			text = await readFile(check.resolved, "utf8");
		} catch {
			withSnippets.push({
				path,
				startLine: item.startLine,
				endLine: item.endLine,
				reason: item.reason,
			});
			continue;
		}

		const lines = splitLines(text);
		const { body } = formatSnippetBody({
			lines,
			startLine: item.startLine,
			endLine: item.endLine,
			maxLinesPerSnippet,
		});

		withSnippets.push({
			path,
			startLine: item.startLine,
			endLine: item.endLine,
			reason: item.reason,
			snippet: body,
		});
	}

	// Enforce byte budget in report order: drop fences from the end until under budget.
	let truncated = false;
	const entries = withSnippets.map((e) => ({ ...e }));

	for (let i = entries.length - 1; i >= 0; i--) {
		if (estimateTotalBytes(query, entries, notes) <= maxOutputBytes) {
			break;
		}
		const entry = entries[i]!;
		if (entry.snippet !== undefined) {
			entry.snippet = undefined;
			entry.omittedForBudget = true;
			truncated = true;
		}
	}

	// If still over budget with all snippets stripped, keep path-only entries as-is
	// (header + path lines are the minimum useful payload).
	if (estimateTotalBytes(query, entries, notes) > maxOutputBytes) {
		truncated = true;
	}

	return { entries, truncated };
}
