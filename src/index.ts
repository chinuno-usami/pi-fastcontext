/**
 * Extension entry: register /fastcontext-model and fast_context (M1–M3).
 */
import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type FastContextConfig } from "./config.ts";
import { formatFastContextContent } from "./format.ts";
import {
	emptyUsage,
	runSearchLoop,
	type LoopResult,
	type TurnCallSummary,
} from "./loop.ts";
import {
	FLAG_NAME,
	resolveSubModel,
	registerModelSelect,
} from "./model-select.ts";
import {
	appendNudgeTip,
	isBroadSearchToolResult,
	renderCall,
	renderResult,
} from "./render.ts";
import { buildSnippets } from "./snippets.ts";

const FastContextParams = Type.Object({
	query: Type.String({
		description:
			"要找的内容，用自然语言描述，可附带已知的符号名、文件名、报错信息",
	}),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "限定搜索的子目录或文件，相对 cwd",
		}),
	),
	maxResults: Type.Optional(
		Type.Number({ description: "返回条目上限，默认取配置" }),
	),
});

const FastContextOutput = Type.Object({
	results: Type.Array(
		Type.Object({
			path: Type.String(),
			startLine: Type.Number(),
			endLine: Type.Number(),
			reason: Type.String(),
		}),
	),
	notes: Type.Optional(Type.String()),
	truncated: Type.Boolean(),
});

type FastContextParamsT = Static<typeof FastContextParams>;
type FastContextOutputT = Static<typeof FastContextOutput>;

/** details shape shared by success, partial onUpdate, and error paths (PLAN §5.3 / §9). */
export interface FastContextDetails {
	model: string;
	turns: number;
	maxTurns: number;
	searches: number;
	turnHistory: Array<{ turn: number; calls: TurnCallSummary[] }>;
	warnings: string[];
	usage: Usage;
	durationMs: number;
	truncated: boolean;
	kind?: LoopResult["kind"];
	errorMessage?: string;
}

/** Clip tool `maxResults` to `[1, configMax]` (PLAN §5.2). Exported for unit tests. */
export function clipMaxResults(raw: number | undefined, configMax: number): number {
	if (raw === undefined || !Number.isFinite(raw)) return configMax;
	return Math.min(configMax, Math.max(1, Math.floor(raw)));
}

/** Optional overrides for tests (avoid reading real agent-dir config). */
export type ExecuteFastContextOptions = {
	/** When set, skip disk load and use this config as-is. */
	config?: FastContextConfig;
	/** Passed to loadConfig when `config` is omitted. */
	globalPath?: string;
};

function searchesFromHistory(
	turnHistory: Array<{ turn: number; calls: TurnCallSummary[] }>,
): number {
	let n = 0;
	for (const t of turnHistory) {
		for (const c of t.calls) {
			if (!c.skipped && c.name !== "report") n++;
		}
	}
	return n;
}

function baseDetails(partial?: Partial<FastContextDetails>): FastContextDetails {
	return {
		model: "",
		turns: 0,
		maxTurns: 0,
		searches: 0,
		turnHistory: [],
		warnings: [],
		usage: emptyUsage(),
		durationMs: 0,
		truncated: false,
		...partial,
	};
}

function modelResolveErrorText(code: "unset" | "not_found" | "no_auth", error: string): string {
	const hint =
		" You can continue with grep/find/read on your own if needed. " +
		"Configure a sub-model with /fastcontext-model (or --fastcontext-model provider/id).";
	if (code === "unset") {
		return (
			"fast_context: no sub-model configured." + hint
		);
	}
	if (code === "not_found") {
		return `fast_context: ${error}` + hint;
	}
	return `fast_context: ${error}` + hint;
}

function resultFromLoopError(
	loop: LoopResult,
	started: number,
): AgentToolResult<FastContextDetails> {
	const details = baseDetails({
		model: loop.modelRef,
		turns: loop.turns,
		searches: searchesFromHistory(loop.turnHistory),
		turnHistory: loop.turnHistory,
		warnings: loop.warnings,
		usage: loop.usage,
		durationMs: Date.now() - started,
		truncated: loop.truncated,
		kind: loop.kind,
		errorMessage: loop.errorMessage,
	});
	const text =
		loop.kind === "cancelled"
			? "fast_context: Cancelled."
			: `fast_context: ${loop.errorMessage ?? "error"}. You can continue with grep/find/read.`;
	return {
		content: [{ type: "text", text }],
		details,
		usage: loop.usage,
		isError: true,
		structuredContent: {
			results: [],
			truncated: loop.truncated,
		} satisfies FastContextOutputT,
	};
}

/**
 * Core `fast_context` execute path. Exported so unit tests can drive it with a
 * fake modelRegistry and injected config (no network / no real agent dir).
 */
export async function executeFastContext(
	pi: ExtensionAPI,
	_toolCallId: string,
	params: FastContextParamsT,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<FastContextDetails> | undefined,
	ctx: ExtensionToolContext,
	options?: ExecuteFastContextOptions,
): Promise<AgentToolResult<FastContextDetails>> {
	const started = Date.now();

	const config =
		options?.config ??
		(
			await loadConfig({
				cwd: ctx.cwd,
				isProjectTrusted: ctx.isProjectTrusted(),
				globalPath: options?.globalPath,
				notify: (msg, level) => ctx.ui.notify(msg, level),
			})
		).config;
	const flagModel = (pi.getFlag(FLAG_NAME) as string | undefined)?.trim() || undefined;

	const resolved = resolveSubModel({
		registry: ctx.modelRegistry,
		flagModel,
		configModel: config.model,
		mainModel: ctx.model,
	});

	if (!resolved.ok) {
		const usage = emptyUsage();
		const details = baseDetails({
			durationMs: Date.now() - started,
			usage,
			maxTurns: config.maxTurns,
			errorMessage: resolved.error,
		});
		return {
			content: [
				{
					type: "text",
					text: modelResolveErrorText(resolved.code, resolved.error),
				},
			],
			details,
			usage,
			isError: true,
			structuredContent: { results: [], truncated: false } satisfies FastContextOutputT,
		};
	}

	const maxResults = clipMaxResults(params.maxResults, config.maxResults);
	const query = params.query;
	const paths = params.paths;
	const sameAsMainWarning = resolved.sameAsMain
		? "Sub-model is the same as the main model; cost may not be reduced (未节省成本)."
		: undefined;

	const loop = await runSearchLoop({
		model: resolved.model,
		modelRegistry: ctx.modelRegistry,
		config,
		query,
		cwd: ctx.cwd,
		paths,
		maxResults,
		signal,
		onUpdate: (update) => {
			const warnings = [...update.details.warnings];
			if (sameAsMainWarning && !warnings.includes(sameAsMainWarning)) {
				warnings.unshift(sameAsMainWarning);
			}
			onUpdate?.({
				content: update.content,
				details: baseDetails({
					model: update.details.model,
					turns: update.details.turns,
					maxTurns: update.details.maxTurns,
					searches: update.details.searches,
					turnHistory: [{ turn: update.details.turns, calls: update.details.turnCalls }],
					warnings,
					usage: update.details.usage,
					durationMs: Date.now() - started,
					truncated: false,
				}),
			});
		},
	});

	if (loop.kind === "error" || loop.kind === "cancelled") {
		const err = resultFromLoopError(loop, started);
		if (sameAsMainWarning) {
			err.details.warnings = [sameAsMainWarning, ...err.details.warnings];
		}
		err.details.maxTurns = config.maxTurns;
		return err;
	}

	const built = await buildSnippets({
		cwd: ctx.cwd,
		results: loop.results,
		maxLinesPerSnippet: config.maxLinesPerSnippet,
		maxOutputBytes: config.maxOutputBytes,
		query,
		notes: loop.notes,
	});

	const truncated = loop.truncated || built.truncated;
	const contentText = formatFastContextContent({
		query,
		entries: built.entries,
		notes: loop.notes,
	});

	const warnings = [...loop.warnings];
	if (sameAsMainWarning) warnings.unshift(sameAsMainWarning);
	if (built.truncated) {
		warnings.push("Output truncated to maxOutputBytes (later entries lack snippets)");
	}

	const details = baseDetails({
		model: loop.modelRef,
		turns: loop.turns,
		maxTurns: config.maxTurns,
		searches: searchesFromHistory(loop.turnHistory),
		turnHistory: loop.turnHistory,
		warnings,
		usage: loop.usage,
		durationMs: Date.now() - started,
		truncated,
		kind: loop.kind,
		errorMessage: loop.errorMessage,
	});

	const structuredContent: FastContextOutputT = {
		results: built.entries.map((e) => ({
			path: e.path,
			startLine: e.startLine,
			endLine: e.endLine,
			reason: e.reason,
		})),
		truncated,
	};
	if (loop.notes) structuredContent.notes = loop.notes;

	return {
		content: [{ type: "text", text: contentText }],
		details,
		usage: loop.usage,
		structuredContent,
	};
}

export function registerFastContextTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fast_context",
		label: "Fast Context",
		description:
			"用低成本模型在当前仓库中定位与问题相关的代码，返回 path:start-end 和短片段。只读。" +
			"适合'X 在哪里实现'、'哪些地方调用了 Y'、'修改 Z 需要看哪些文件'这类问题。",
		promptSnippet: "定位相关代码，返回 path:line 范围和片段（低成本子模型）",
		promptGuidelines: [
			"在不知道代码位置时，先调用 fast_context，不要直接用 grep/find/大范围 read 探索仓库。",
			"fast_context 返回行范围后，只对需要修改或细看的范围调用 read（带 offset/limit）。",
			"已知确切文件和行号时不要调用 fast_context。",
		],
		parameters: FastContextParams,
		outputSchema: FastContextOutput,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			openWorldHint: false,
		},
		renderCall(args, theme) {
			return renderCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderResult(result, options, theme);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return executeFastContext(pi, toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

/**
 * PLAN §10: when nudgeBroadSearch is true, append a one-time tip if the main
 * model uses grep/find (or bash rg/grep -r/find) before calling fast_context.
 */
export function registerNudgeBroadSearch(pi: ExtensionAPI): void {
	let usedFastContext = false;
	let nudgedThisRun = false;

	pi.on("agent_start", () => {
		usedFastContext = false;
		nudgedThisRun = false;
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "fast_context") {
			usedFastContext = true;
		}
	});

	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | void> => {
		if (event.toolName === "fast_context") {
			usedFastContext = true;
			return;
		}
		if (nudgedThisRun || usedFastContext) return;
		if (event.parentToolCallId) return;
		if (!isBroadSearchToolResult(event.toolName, event.input)) return;

		const loaded = await loadConfig({
			cwd: ctx.cwd,
			isProjectTrusted: ctx.isProjectTrusted(),
			notify: (msg, level) => ctx.ui.notify(msg, level),
		});
		if (!loaded.config.nudgeBroadSearch) return;

		nudgedThisRun = true;
		return appendNudgeTip(event);
	});
}

export default function (pi: ExtensionAPI): void {
	registerModelSelect(pi);
	registerFastContextTool(pi);
	registerNudgeBroadSearch(pi);
}
