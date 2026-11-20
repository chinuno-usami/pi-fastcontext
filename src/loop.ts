/**
 * Sub-model search loop: turns, parallel tools, budget, abort, usage, degrade. (M2)
 *
 * Uses modelRegistry.streamSimple + await stream.result() (PLAN §14 / README).
 */
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { FastContextConfig, ReasoningLevel } from "./config.ts";
import {
	checkPathUnderRoots,
	createInnerTools,
	resolveAllowedRoots,
	type InnerToolBundle,
	type ReportParams,
	type ReportResultItem,
} from "./inner-tools.ts";
import { buildSystemPromptWithListing, NUDGE_REPORT_MESSAGE } from "./prompt.ts";

const MAX_TOKENS = 4096;
const SKIPPED_PARALLEL_MSG = "Skipped: exceeded maxParallelCalls limit for this turn.";

export type StreamSimpleRegistry = Pick<ModelRegistry, "streamSimple">;

export interface TurnCallSummary {
	name: string;
	arguments: Record<string, unknown>;
	skipped?: boolean;
	isError?: boolean;
}

export interface LoopPartialUpdate {
	content: Array<{ type: "text"; text: string }>;
	details: LoopProgressDetails;
}

export interface LoopProgressDetails {
	model: string;
	turns: number;
	maxTurns: number;
	searches: number;
	turnCalls: TurnCallSummary[];
	warnings: string[];
	usage: Usage;
}

export type LoopOutcomeKind = "report" | "degraded" | "error" | "cancelled";

export interface LoopResult {
	kind: LoopOutcomeKind;
	results: ReportResultItem[];
	notes?: string;
	truncated: boolean;
	warnings: string[];
	usage: Usage;
	turns: number;
	/** Per-turn tool call summaries (name + args, no outputs). */
	turnHistory: Array<{ turn: number; calls: TurnCallSummary[] }>;
	errorMessage?: string;
	durationMs: number;
	sessionId: string;
	modelRef: string;
}

export interface RunSearchLoopOptions {
	model: Model<Api>;
	modelRegistry: StreamSimpleRegistry;
	config: FastContextConfig;
	query: string;
	cwd: string;
	/** Raw paths from the tool (leading @ stripped later by resolveAllowedRoots). */
	paths?: string[];
	/** Cap for report entries; already clipped to [1, config.maxResults] by caller when set. */
	maxResults?: number;
	signal?: AbortSignal;
	onUpdate?: (update: LoopPartialUpdate) => void;
	/** Override session id (tests). */
	sessionId?: string;
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(acc: Usage, next: Usage | undefined): Usage {
	if (!next) return acc;
	const reasoning =
		acc.reasoning !== undefined || next.reasoning !== undefined
			? (acc.reasoning ?? 0) + (next.reasoning ?? 0)
			: undefined;
	return {
		input: acc.input + next.input,
		output: acc.output + next.output,
		cacheRead: acc.cacheRead + next.cacheRead,
		cacheWrite: acc.cacheWrite + next.cacheWrite,
		cacheWrite1h:
			acc.cacheWrite1h !== undefined || next.cacheWrite1h !== undefined
				? (acc.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0)
				: undefined,
		reasoning,
		totalTokens: acc.totalTokens + next.totalTokens,
		cost: {
			input: acc.cost.input + next.cost.input,
			output: acc.cost.output + next.cost.output,
			cacheRead: acc.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: acc.cost.cacheWrite + next.cost.cacheWrite,
			total: acc.cost.total + next.cost.total,
		},
	};
}

/** Merge outer signal with timeoutMs (AbortSignal.any). */
export function combineSignals(
	outer: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; timeout: AbortSignal } {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!outer) {
		return { signal: timeout, timeout };
	}
	return { signal: AbortSignal.any([outer, timeout]), timeout };
}

function modelRefOf(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function reasoningOption(
	level: ReasoningLevel,
	model: Model<Api>,
): ThinkingLevel | undefined {
	if (level === "off" || model.reasoning === false) return undefined;
	return level;
}

function textFromAgentResult(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function toToolResultMessage(
	toolCallId: string,
	toolName: string,
	result: AgentToolResult<unknown>,
): ToolResultMessage {
	const content = result.content.filter(
		(c): c is { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } =>
			c.type === "text" || c.type === "image",
	);
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: content.length > 0 ? content : [{ type: "text", text: "" }],
		isError: result.isError === true,
		timestamp: Date.now(),
	};
}

function errorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: undefined,
		isError: true,
	};
}

function extractToolCalls(msg: AssistantMessage): ToolCall[] {
	return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

/**
 * Weak parse of path:line hits from tool output (grep-style). Used when the
 * sub-model never calls report (PLAN §6.3 degrade path).
 */
export function weakParseGrepHits(
	texts: string[],
	maxResults: number,
): ReportResultItem[] {
	const seen = new Set<string>();
	const out: ReportResultItem[] = [];
	// ripgrep / many tools: path:line:… or path:line-line
	const re = /(?:^|[\s`])([^\s:`]+):(\d+)(?::-?(\d+))?(?=\s|:|$)/gm;
	for (const text of texts) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const path = m[1]!;
			const startLine = Number(m[2]);
			const endLine = m[3] ? Number(m[3]) : startLine;
			if (!Number.isFinite(startLine) || startLine < 1) continue;
			const key = `${path}:${startLine}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				path,
				startLine,
				endLine: Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine,
				reason: "degraded: inferred from tool output (no report)",
			});
			if (out.length >= maxResults) return out;
		}
	}
	return out;
}

export interface ValidateReportOptions {
	cwd: string;
	roots: string[];
	maxResults: number;
}

export interface ValidateReportResult {
	results: ReportResultItem[];
	notes?: string;
	warnings: string[];
	/** True when every submitted entry was dropped. */
	allInvalid: boolean;
}

/**
 * Validate report params: path under roots, line order, clip to file length.
 * Illegal entries are dropped with warnings (PLAN §6.3).
 */
export async function validateReportParams(
	params: unknown,
	opts: ValidateReportOptions,
): Promise<ValidateReportResult> {
	const warnings: string[] = [];
	if (!params || typeof params !== "object") {
		return { results: [], warnings: ["report: arguments are not an object"], allInvalid: true };
	}
	const raw = params as ReportParams;
	const notes =
		typeof raw.notes === "string"
			? raw.notes.length > 300
				? raw.notes.slice(0, 300)
				: raw.notes
			: undefined;

	if (!Array.isArray(raw.results)) {
		return {
			results: [],
			notes,
			warnings: ["report: results must be an array"],
			allInvalid: true,
		};
	}

	const out: ReportResultItem[] = [];
	let submitted = 0;
	for (const item of raw.results) {
		submitted++;
		if (!item || typeof item !== "object") {
			warnings.push("report: skipped non-object result entry");
			continue;
		}
		const path = typeof item.path === "string" ? item.path : "";
		const startLine = typeof item.startLine === "number" ? Math.floor(item.startLine) : NaN;
		let endLine = typeof item.endLine === "number" ? Math.floor(item.endLine) : NaN;
		const reason = typeof item.reason === "string" ? item.reason : "";

		if (!path) {
			warnings.push("report: skipped entry with empty path");
			continue;
		}
		if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
			warnings.push(`report: skipped ${path} (invalid line numbers)`);
			continue;
		}
		if (startLine < 1 || endLine < startLine) {
			warnings.push(`report: skipped ${path} (require 1 <= startLine <= endLine)`);
			continue;
		}

		const check = await checkPathUnderRoots(path, opts.roots, {
			cwd: opts.cwd,
			mustExist: true,
		});
		if (!check.ok) {
			warnings.push(`report: skipped ${path} (${check.error})`);
			continue;
		}

		let lineCount: number | undefined;
		try {
			const text = await readFile(check.resolved, "utf8");
			lineCount = text.split(/\r?\n/).length;
			// trailing empty from final newline still counts as last line content-wise;
			// if file ends with \n, split yields an extra empty — clamp to non-empty lines.
			if (text.endsWith("\n") && lineCount > 0) lineCount -= 1;
			if (lineCount < 1) lineCount = 1;
		} catch {
			warnings.push(`report: skipped ${path} (unreadable)`);
			continue;
		}

		if (startLine > lineCount) {
			warnings.push(`report: skipped ${path} (startLine ${startLine} past EOF ${lineCount})`);
			continue;
		}
		if (endLine > lineCount) {
			warnings.push(`report: clipped ${path} endLine ${endLine} → ${lineCount}`);
			endLine = lineCount;
		}

		const rel = relative(opts.cwd, check.resolved);
		out.push({
			path: rel && !rel.startsWith("..") ? rel : path,
			startLine,
			endLine,
			reason: reason || "relevant",
		});

		if (out.length >= opts.maxResults) {
			if (submitted < raw.results.length || raw.results.length > opts.maxResults) {
				warnings.push(`report: truncated to maxResults=${opts.maxResults}`);
			}
			break;
		}
	}

	return {
		results: out,
		notes,
		warnings,
		allInvalid: submitted > 0 && out.length === 0,
	};
}

async function executeCalls(options: {
	calls: ToolCall[];
	maxParallel: number;
	bundle: InnerToolBundle;
	signal: AbortSignal;
	grepOutputs: string[];
}): Promise<{ results: ToolResultMessage[]; summaries: TurnCallSummary[] }> {
	const { calls, maxParallel, bundle, signal, grepOutputs } = options;
	const summaries: TurnCallSummary[] = [];
	const results: ToolResultMessage[] = [];

	const runnable = calls.slice(0, maxParallel);
	const skipped = calls.slice(maxParallel);

	const settled = await Promise.all(
		runnable.map(async (call) => {
			const args =
				call.arguments && typeof call.arguments === "object"
					? (call.arguments as Record<string, unknown>)
					: {};
			const agentResult = await bundle.execute(call.name, call.id, args, signal);
			if (call.name === "grep" || call.name === "find") {
				const text = textFromAgentResult(agentResult);
				if (text) grepOutputs.push(text);
			}
			return {
				call,
				args,
				agentResult,
			};
		}),
	);

	for (const item of settled) {
		summaries.push({
			name: item.call.name,
			arguments: item.args,
			isError: item.agentResult.isError === true,
		});
		results.push(toToolResultMessage(item.call.id, item.call.name, item.agentResult));
	}

	for (const call of skipped) {
		const args =
			call.arguments && typeof call.arguments === "object"
				? (call.arguments as Record<string, unknown>)
				: {};
		summaries.push({ name: call.name, arguments: args, skipped: true, isError: true });
		results.push(
			toToolResultMessage(call.id, call.name, errorToolResult(SKIPPED_PARALLEL_MSG)),
		);
	}

	return { results, summaries };
}

const RESCUE_EVIDENCE_MAX_CHARS = 24_000;

/**
 * Fresh, history-free context for the final report-only attempt: the query plus
 * successful tool outputs seen so far (newest kept when over budget).
 */
export function buildRescueContext(
	query: string,
	messages: readonly Message[],
	maxResults: number,
	tools: Tool[],
): Context {
	const blocks: string[] = [];
	let total = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || m.isError) continue;
		const text = m.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		if (!text) continue;
		const block = `--- ${m.toolName} output ---\n${text}`;
		if (total + block.length > RESCUE_EVIDENCE_MAX_CHARS) break;
		blocks.unshift(block);
		total += block.length;
	}

	const content = [
		`Query: ${query}`,
		"",
		"Search output collected so far:",
		blocks.length > 0 ? blocks.join("\n\n") : "(none)",
		"",
		`Call the report tool now with up to ${maxResults} locations from the output above.`,
	].join("\n");

	return {
		systemPrompt:
			"You are a code locator. Searching is over; the only available tool is report. " +
			"Respond with exactly one report call. Line numbers must come from the provided output. " +
			"Use an empty results array if nothing is relevant.",
		messages: [{ role: "user", content, timestamp: Date.now() }],
		tools,
	};
}

/**
 * Run the bounded read-only search loop with a sub-model.
 */
export async function runSearchLoop(options: RunSearchLoopOptions): Promise<LoopResult> {
	const started = Date.now();
	const { model, modelRegistry, config, query, cwd, signal: outerSignal } = options;
	const modelRef = modelRefOf(model);
	const sessionId = options.sessionId ?? uuidv7();
	const maxResults = options.maxResults ?? config.maxResults;
	const warnings: string[] = [];
	const turnHistory: Array<{ turn: number; calls: TurnCallSummary[] }> = [];
	const grepOutputs: string[] = [];
	let usage = emptyUsage();
	let turns = 0;

	const finish = (partial: Omit<LoopResult, "durationMs" | "sessionId" | "modelRef">): LoopResult => ({
		...partial,
		durationMs: Date.now() - started,
		sessionId,
		modelRef,
	});

	const allowed = await resolveAllowedRoots(cwd, options.paths);
	if (allowed.error) {
		return finish({
			kind: "error",
			results: [],
			truncated: false,
			warnings,
			usage,
			turns: 0,
			turnHistory,
			errorMessage: allowed.error,
		});
	}

	const bundle = createInnerTools({
		cwd,
		allowedPaths: allowed.roots,
		innerToolMaxBytes: config.innerToolMaxBytes,
	});

	const systemPrompt = await buildSystemPromptWithListing({
		cwd,
		paths: options.paths,
		maxTurns: config.maxTurns,
		maxResults,
	});

	const { signal, timeout } = combineSignals(outerSignal, config.timeoutMs);

	/** PLAN §9: timeout behaves like request failure (degrade if grep hits); user abort → cancelled. */
	const finishDueToAbort = (): LoopResult => {
		const isTimeout = timeout.aborted && !outerSignal?.aborted;
		if (isTimeout) {
			const degraded = weakParseGrepHits(grepOutputs, maxResults);
			if (degraded.length > 0) {
				warnings.push("Timed out; returning degraded hits from prior grep output");
				return finish({
					kind: "degraded",
					results: degraded,
					notes: "Degraded results after timeout",
					truncated: true,
					warnings,
					usage,
					turns,
					turnHistory,
					errorMessage: "Timed out",
				});
			}
			return finish({
				kind: "error",
				results: [],
				truncated: false,
				warnings,
				usage,
				turns,
				turnHistory,
				errorMessage: "Timed out",
			});
		}
		return finish({
			kind: "cancelled",
			results: [],
			truncated: false,
			warnings,
			usage,
			turns,
			turnHistory,
			errorMessage: "Cancelled",
		});
	};

	const messages: Message[] = [
		{
			role: "user",
			content: query,
			timestamp: Date.now(),
		},
	];

	const emitProgress = (turn: number, searches: number, turnCalls: TurnCallSummary[]) => {
		options.onUpdate?.({
			content: [{ type: "text", text: `turn ${turn}: ${searches} searches` }],
			details: {
				model: modelRef,
				turns: turn,
				maxTurns: config.maxTurns,
				searches,
				turnCalls,
				warnings: [...warnings],
				usage,
			},
		});
	};

	try {
		// One extra report-only rescue turn if the last regular turn ends without report.
		for (let turn = 1; turn <= config.maxTurns + 1; turn++) {
			if (signal.aborted) {
				return finishDueToAbort();
			}

			turns = turn;
			const toolsForTurn: Tool[] =
				turn >= config.maxTurns ? bundle.reportOnlyTools : bundle.allTools;

			const isRescue = turn > config.maxTurns;
			const context: Context = isRescue
				? buildRescueContext(query, messages, maxResults, bundle.reportOnlyTools)
				: {
						systemPrompt,
						messages,
						tools: toolsForTurn,
					};

			const streamOpts: {
				signal: AbortSignal;
				maxTokens: number;
				cacheRetention: "short";
				sessionId: string;
				reasoning?: ThinkingLevel;
			} = {
				signal,
				maxTokens: MAX_TOKENS,
				cacheRetention: "short",
				sessionId: isRescue ? uuidv7() : sessionId,
			};
			const reasoning = reasoningOption(config.reasoning, model);
			if (reasoning) streamOpts.reasoning = reasoning;

			const stream = modelRegistry.streamSimple(model, context, streamOpts);
			const resp = await stream.result();
			usage = addUsage(usage, resp.usage);

			if (resp.stopReason === "aborted") {
				return finishDueToAbort();
			}

			if (resp.stopReason === "error") {
				const degraded = weakParseGrepHits(grepOutputs, maxResults);
				if (degraded.length > 0) {
					warnings.push(
						`sub-model error: ${resp.errorMessage ?? "unknown"}; returning degraded hits`,
					);
					return finish({
						kind: "degraded",
						results: degraded,
						notes: "Degraded results after sub-model error",
						truncated: true,
						warnings,
						usage,
						turns,
						turnHistory,
						errorMessage: resp.errorMessage,
					});
				}
				return finish({
					kind: "error",
					results: [],
					truncated: false,
					warnings,
					usage,
					turns,
					turnHistory,
					errorMessage: resp.errorMessage ?? "Sub-model request failed",
				});
			}

			// E1: push AssistantMessage as-is
			messages.push(resp);

			const calls = extractToolCalls(resp);
			const reportCall = calls.find((c) => c.name === "report");

			// Same-turn report ends the loop; do not execute sibling tools (§14.5).
			if (reportCall) {
				const validated = await validateReportParams(reportCall.arguments, {
					cwd,
					roots: bundle.roots,
					maxResults,
				});
				warnings.push(...validated.warnings);

				if (validated.allInvalid && turn < config.maxTurns) {
					const retryMsg =
						"report was invalid: " +
						(validated.warnings.join("; ") || "no valid results") +
						". Fix paths/line ranges and call report again.";
					messages.push(
						toToolResultMessage(
							reportCall.id,
							"report",
							errorToolResult(retryMsg),
						),
					);
					turnHistory.push({
						turn,
						calls: [
							{
								name: "report",
								arguments: (reportCall.arguments ?? {}) as Record<string, unknown>,
								isError: true,
							},
						],
					});
					emitProgress(turn, 0, turnHistory[turnHistory.length - 1]!.calls);
					continue;
				}

				turnHistory.push({
					turn,
					calls: [
						{
							name: "report",
							arguments: (reportCall.arguments ?? {}) as Record<string, unknown>,
						},
					],
				});
				emitProgress(turn, 0, turnHistory[turnHistory.length - 1]!.calls);

				return finish({
					kind: "report",
					results: validated.results,
					notes: validated.notes,
					truncated: false,
					warnings,
					usage,
					turns,
					turnHistory,
				});
			}

			if (turn >= config.maxTurns) {
				if (turn > config.maxTurns) break;
				const summaries: TurnCallSummary[] = calls.map((c) => ({
					name: c.name,
					arguments: (c.arguments ?? {}) as Record<string, unknown>,
					skipped: true,
					isError: true,
				}));
				for (const c of calls) {
					messages.push(
						toToolResultMessage(
							c.id,
							c.name,
							errorToolResult("No more searches allowed. Call report now."),
						),
					);
				}
				if (calls.length === 0) {
					messages.push({
						role: "user",
						content: NUDGE_REPORT_MESSAGE,
						timestamp: Date.now(),
					});
				}
				warnings.push("No report on final turn; retrying once with report only");
				turnHistory.push({ turn, calls: summaries });
				emitProgress(turn, 0, summaries);
				continue;
			}

			if (calls.length === 0) {
				messages.push({
					role: "user",
					content: NUDGE_REPORT_MESSAGE,
					timestamp: Date.now(),
				});
				turnHistory.push({ turn, calls: [] });
				emitProgress(turn, 0, []);
				continue;
			}

			const { results, summaries } = await executeCalls({
				calls,
				maxParallel: config.maxParallelCalls,
				bundle,
				signal,
				grepOutputs,
			});
			turnHistory.push({ turn, calls: summaries });
			messages.push(...results);
			emitProgress(
				turn,
				summaries.filter((s) => !s.skipped && s.name !== "report").length,
				summaries,
			);
		}

		// No report after maxTurns → degrade
		const degraded = weakParseGrepHits(grepOutputs, maxResults);
		warnings.push("Reached maxTurns without report; using degraded results");
		return finish({
			kind: "degraded",
			results: degraded,
			notes: "No report from sub-model within maxTurns",
			truncated: true,
			warnings,
			usage,
			turns,
			turnHistory,
		});
	} catch (err) {
		if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
			return finishDueToAbort();
		}
		const msg = err instanceof Error ? err.message : String(err);
		const degraded = weakParseGrepHits(grepOutputs, maxResults);
		if (degraded.length > 0) {
			warnings.push(`loop exception: ${msg}; returning degraded hits`);
			return finish({
				kind: "degraded",
				results: degraded,
				notes: "Degraded results after loop exception",
				truncated: true,
				warnings,
				usage,
				turns,
				turnHistory,
				errorMessage: msg,
			});
		}
		return finish({
			kind: "error",
			results: [],
			truncated: false,
			warnings,
			usage,
			turns,
			turnHistory,
			errorMessage: msg,
		});
	}
}

/** Resolve absolute path under cwd for tests/helpers (no jail). */
export function resolveUnderCwd(cwd: string, rel: string): string {
	return resolve(cwd, rel);
}
