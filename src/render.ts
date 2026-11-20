/**
 * Custom Call/Result rendering for fast_context (PLAN §8 / M3).
 */
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	Theme,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TurnCallSummary } from "./loop.ts";

export interface FastContextRenderDetails {
	model?: string;
	turns?: number;
	maxTurns?: number;
	searches?: number;
	turnHistory?: Array<{ turn: number; calls: TurnCallSummary[] }>;
	usage?: { cost?: { total?: number } };
	durationMs?: number;
	errorMessage?: string;
	kind?: string;
	truncated?: boolean;
	warnings?: string[];
}

export interface FastContextResultItem {
	path: string;
	startLine: number;
	endLine: number;
	reason: string;
}

const QUERY_PREVIEW = 80;

/** Tip appended when nudgeBroadSearch is on (PLAN §10). */
export const NUDGE_TIP = "Tip: fast_context can locate code with a cheaper model.";

export function truncateQuery(query: string, max = QUERY_PREVIEW): string {
	if (query.length <= max) return query;
	return query.slice(0, max);
}

export function formatCost(total: number | undefined): string {
	if (total === undefined || !Number.isFinite(total)) return "$0";
	if (total === 0) return "$0";
	if (total < 0.01) return `$${total.toFixed(4)}`;
	return `$${total.toFixed(2)}`;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "0s";
	const sec = ms / 1000;
	if (sec < 10) return `${sec.toFixed(1)}s`;
	return `${Math.round(sec)}s`;
}

export function rangeLabel(item: { path: string; startLine: number; endLine: number }): string {
	return `${item.path}:${item.startLine}-${item.endLine}`;
}

/** Whether a bash command looks like a broad search (PLAN §10). */
export function isBroadBashCommand(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const cmd = command.trim();
	return /^(rg\b|grep\s+-r\b|find\b)/.test(cmd);
}

/** Whether this tool_result is a broad search the tip should target. */
export function isBroadSearchToolResult(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "grep" || toolName === "find") return true;
	if (toolName === "bash") return isBroadBashCommand(input.command);
	return false;
}

function asDetails(raw: unknown): FastContextRenderDetails {
	if (!raw || typeof raw !== "object") return {};
	return raw as FastContextRenderDetails;
}

function resultsFromStructured(structured: unknown): FastContextResultItem[] {
	if (!structured || typeof structured !== "object") return [];
	const results = (structured as { results?: unknown }).results;
	if (!Array.isArray(results)) return [];
	const out: FastContextResultItem[] = [];
	for (const r of results) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		if (
			typeof o.path === "string" &&
			typeof o.startLine === "number" &&
			typeof o.endLine === "number" &&
			typeof o.reason === "string"
		) {
			out.push({
				path: o.path,
				startLine: o.startLine,
				endLine: o.endLine,
				reason: o.reason,
			});
		}
	}
	return out;
}

function firstText(result: AgentToolResult<unknown>): string {
	const block = result.content.find((c) => c.type === "text");
	return block && block.type === "text" ? block.text : "";
}

function formatCallArgsSummary(name: string, args: Record<string, unknown>): string {
	if (name === "grep") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		const path = typeof args.path === "string" ? args.path : "";
		const p = pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern;
		return path ? `grep ${JSON.stringify(p)} in ${path}` : `grep ${JSON.stringify(p)}`;
	}
	if (name === "find") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		return `find ${JSON.stringify(pattern)}`;
	}
	if (name === "read") {
		const path = typeof args.path === "string" ? args.path : "?";
		return `read ${path}`;
	}
	if (name === "report") {
		const n = Array.isArray(args.results) ? args.results.length : 0;
		return `report (${n})`;
	}
	return name;
}

/**
 * renderCall: `fast_context "<query 前 80 字符>"`，有 paths 时附上。
 */
export function renderCall(
	args: { query?: string; paths?: string[] },
	theme: Theme,
): Text {
	const q = truncateQuery(typeof args.query === "string" ? args.query : "");
	let text =
		theme.fg("toolTitle", theme.bold("fast_context ")) +
		theme.fg("accent", JSON.stringify(q));
	if (Array.isArray(args.paths) && args.paths.length > 0) {
		text += theme.fg("muted", ` paths=${args.paths.join(",")}`);
	}
	return new Text(text, 0, 0);
}

/**
 * renderResult: partial / collapsed / expanded (PLAN §8).
 * Safe for print/json modes as long as a Theme is provided (no interactive APIs).
 */
export function renderResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text {
	const details = asDetails(result.details);
	const model = details.model || "?";
	const turns = details.turns ?? 0;
	const maxTurns = details.maxTurns ?? 0;
	const searches = details.searches ?? 0;

	if (options.isPartial) {
		const text = theme.fg(
			"warning",
			`turn ${turns}/${maxTurns} · ${searches} searches · ${model}`,
		);
		return new Text(text, 0, 0);
	}

	if (result.isError) {
		const msg = firstText(result).trim() || details.errorMessage || "error";
		const line = msg.split("\n")[0] ?? msg;
		return new Text(theme.fg("error", line), 0, 0);
	}

	const items = resultsFromStructured(result.structuredContent);
	const n = items.length;
	const cost = formatCost(details.usage?.cost?.total);
	const dur = formatDuration(details.durationMs);
	let text = theme.fg(
		"success",
		`${n} results · ${turns} turns · ${model} · ${cost} · ${dur}`,
	);

	if (!options.expanded) {
		for (const item of items.slice(0, 3)) {
			text += `\n  ${theme.fg("dim", rangeLabel(item))}`;
		}
		if (items.length > 3) {
			text += `\n  ${theme.fg("muted", `… +${items.length - 3} more`)}`;
		}
		return new Text(text, 0, 0);
	}

	for (const item of items) {
		text += `\n  ${theme.fg("accent", rangeLabel(item))}${theme.fg("muted", ` — ${item.reason}`)}`;
	}
	if (items.length === 0) {
		text += `\n  ${theme.fg("muted", "(no results)")}`;
	}

	const history = details.turnHistory ?? [];
	if (history.length > 0) {
		text += `\n${theme.fg("muted", "turns:")}`;
		for (const t of history) {
			text += `\n  ${theme.fg("dim", `turn ${t.turn}:`)}`;
			for (const c of t.calls) {
				const skip = c.skipped ? theme.fg("warning", " [skipped]") : "";
				const err = c.isError ? theme.fg("error", " [error]") : "";
				text += `\n    ${theme.fg("toolOutput", formatCallArgsSummary(c.name, c.arguments))}${skip}${err}`;
			}
		}
	}

	if (details.warnings && details.warnings.length > 0) {
		text += `\n${theme.fg("warning", `warnings: ${details.warnings.join("; ")}`)}`;
	}

	return new Text(text, 0, 0);
}

/** Append §10 tip while preserving details / structuredContent (required when replacing content). */
export function appendNudgeTip(event: {
	content: (TextContent | ImageContent)[];
	details: unknown;
	structuredContent?: unknown;
}): ToolResultEventResult {
	const content: (TextContent | ImageContent)[] = [
		...event.content,
		{ type: "text", text: `\n${NUDGE_TIP}` },
	];
	const out: ToolResultEventResult = {
		content,
		details: event.details,
	};
	if (event.structuredContent !== undefined) {
		out.structuredContent = event.structuredContent as ToolResultEventResult["structuredContent"];
	}
	return out;
}
