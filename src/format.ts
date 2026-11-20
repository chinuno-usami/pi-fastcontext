/**
 * Format text returned to the main model (PLAN §5.3). (M2)
 */
import type { SnippetEntry } from "./snippets.ts";

const EXT_LANG: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	mjs: "mjs",
	cjs: "cjs",
	py: "py",
	rb: "rb",
	go: "go",
	rs: "rs",
	java: "java",
	kt: "kt",
	swift: "swift",
	md: "md",
	json: "json",
	yaml: "yaml",
	yml: "yml",
	toml: "toml",
	css: "css",
	scss: "scss",
	html: "html",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	c: "c",
	h: "c",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
};

export function fenceLangForPath(path: string): string {
	const base = path.split(/[/\\]/).pop() ?? path;
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return "";
	const ext = base.slice(dot + 1).toLowerCase();
	return EXT_LANG[ext] ?? "";
}

/** Header line: `fast_context: N results for "query"`. */
export function formatHeader(query: string, count: number): string {
	return `fast_context: ${count} results for ${JSON.stringify(query)}`;
}

/**
 * One numbered entry. When `entry.snippet` is set, include a fenced block;
 * otherwise only `path:start-end — reason` (budget / binary skip).
 */
export function formatEntry(index: number, entry: SnippetEntry): string {
	const head = `${index}. ${entry.path}:${entry.startLine}-${entry.endLine}  — ${entry.reason}`;
	if (entry.snippet === undefined) {
		return head;
	}
	const lang = fenceLangForPath(entry.path);
	const open = lang ? "```" + lang : "```";
	return `${head}\n${open}\n${entry.snippet}\n\`\`\``;
}

export function formatNotes(notes: string | undefined): string {
	if (!notes || !notes.trim()) return "";
	return `notes: ${notes.trim()}`;
}

export function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Assemble the full content string returned to the main model.
 * Entries are already budget-trimmed by snippets.ts.
 */
export function formatFastContextContent(options: {
	query: string;
	entries: SnippetEntry[];
	notes?: string;
}): string {
	const { query, entries, notes } = options;
	const parts: string[] = [formatHeader(query, entries.length), ""];
	for (let i = 0; i < entries.length; i++) {
		parts.push(formatEntry(i + 1, entries[i]!));
		parts.push("");
	}
	const notesLine = formatNotes(notes);
	if (notesLine) {
		parts.push(notesLine);
	}
	// Trim trailing blank lines but keep a single trailing newline for readability.
	while (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}
	return parts.join("\n") + "\n";
}

/**
 * Estimate bytes for the final document if `entries` were formatted as-is.
 * Used by snippets.ts to enforce maxOutputBytes before assembling.
 */
export function estimateFormattedBytes(options: {
	query: string;
	entries: SnippetEntry[];
	notes?: string;
}): number {
	return utf8Bytes(formatFastContextContent(options));
}
