/**
 * Sub-model system prompt and report tool re-export. (M2)
 * Prompt is English, short (~600 tokens max per PLAN §6.2).
 */
import { readdir } from "node:fs/promises";
import { createReportTool, type ReportParams } from "./inner-tools.ts";

export { createReportTool, reportParametersSchema } from "./inner-tools.ts";
export type { ReportParams };

export interface SystemPromptOptions {
	cwd: string;
	/** Relative or display paths shown in the prompt (search scope). */
	paths?: string[];
	maxTurns: number;
	maxResults: number;
	/** Precomputed top-level listing; if omitted, built via listTopLevel. */
	topLevelListing?: string;
}

const TOP_LEVEL_CAP = 60;

/**
 * List top-level entries under cwd (names only), capped at ~60 items.
 */
export async function listTopLevel(cwd: string, cap = TOP_LEVEL_CAP): Promise<string> {
	try {
		const entries = await readdir(cwd);
		entries.sort((a, b) => a.localeCompare(b));
		const shown = entries.slice(0, cap);
		const extra = entries.length > cap ? `\n… (${entries.length - cap} more)` : "";
		return shown.join("\n") + extra;
	} catch {
		return "(unable to list directory)";
	}
}

/**
 * Build the English system prompt for the locator sub-model.
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
	const { cwd, maxTurns, maxResults } = opts;
	const pathsBlock =
		opts.paths && opts.paths.length > 0
			? `Search scope (stay inside these paths): ${opts.paths.join(", ")}`
			: "Search scope: entire workspace (cwd).";
	const listing = opts.topLevelListing ?? "(not provided)";

	return [
		"You are a code locator. Find code locations relevant to the query.",
		"Do NOT answer the question, explain, or write code — only locate.",
		"",
		"Strategy:",
		"- Each turn, fire multiple searches in parallel (different keywords, synonyms, symbol names, filenames).",
		`- You have at most ${maxTurns} turns. On the last turn you MUST call report.`,
		`- report line numbers must come from grep/read output you actually saw. Prefer tight ranges (function/class). Sort by relevance. At most ${maxResults} results.`,
		"- If nothing fits, call report with an empty results array and explain what you tried in notes.",
		"",
		"Tools: grep, find, ls, read, report. No shell, write, or edit.",
		"",
		`cwd: ${cwd}`,
		pathsBlock,
		"Top-level entries:",
		listing,
	].join("\n");
}

/**
 * Convenience: build prompt and include a fresh top-level listing.
 */
export async function buildSystemPromptWithListing(
	opts: Omit<SystemPromptOptions, "topLevelListing">,
): Promise<string> {
	const topLevelListing = await listTopLevel(opts.cwd);
	return buildSystemPrompt({ ...opts, topLevelListing });
}

/** User message is only the query (no main-session history). */
export function buildUserMessage(query: string): string {
	return query;
}

/** Nudge when the model returns no tool calls. */
export const NUDGE_REPORT_MESSAGE = "Please call the report tool with your findings.";
