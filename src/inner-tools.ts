/**
 * Read-only inner tools for the sub-model: path jail, output caps, report schema. (M2)
 *
 * Built-ins from create*ToolDefinition are executed directly (not via ctx.executeTool).
 * Context.tools only get { name, description, parameters }.
 */
import { realpath, lstat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Default / max line limits for the read tool (PLAN §6.1). */
export const READ_DEFAULT_LIMIT = 200;
export const READ_MAX_LIMIT = 400;

export const reportParametersSchema = Type.Object({
	results: Type.Array(
		Type.Object({
			path: Type.String(),
			startLine: Type.Number(),
			endLine: Type.Number(),
			reason: Type.String(),
		}),
	),
	notes: Type.Optional(Type.String()),
});

export type ReportParams = Static<typeof reportParametersSchema>;

export interface ReportResultItem {
	path: string;
	startLine: number;
	endLine: number;
	reason: string;
}

const REPORT_DESCRIPTION =
	"Submit final code locations for the query. Call this when done searching. " +
	"Line numbers must come from grep/read output. Use an empty results array if nothing relevant was found.";

export function createReportTool(): Tool {
	return {
		name: "report",
		description: REPORT_DESCRIPTION,
		parameters: reportParametersSchema,
	};
}

export interface InnerToolsOptions {
	cwd: string;
	/** Already-validated absolute paths under cwd; when set, tool access is limited to these roots. */
	allowedPaths?: string[];
	innerToolMaxBytes: number;
}

export type PathCheckOk = { ok: true; resolved: string };
export type PathCheckErr = { ok: false; error: string };
export type PathCheckResult = PathCheckOk | PathCheckErr;

/**
 * Resolve allowed roots: cwd, or each entry in `paths` (must stay under cwd).
 * Strips a leading `@` from path entries (PLAN §5.2).
 */
export async function resolveAllowedRoots(
	cwd: string,
	paths?: string[],
): Promise<{ roots: string[]; error?: string }> {
	const cwdReal = await realpathSafe(cwd);
	if (!paths || paths.length === 0) {
		return { roots: [cwdReal] };
	}
	const roots: string[] = [];
	for (const raw of paths) {
		const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
		const abs = resolve(cwd, stripped);
		const check = await checkPathUnderRoots(abs, [cwdReal], { mustExist: false });
		if (!check.ok) {
			return { roots: [], error: `paths entry out of scope: ${raw}` };
		}
		roots.push(check.resolved);
	}
	return { roots };
}

async function realpathSafe(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		return resolve(p);
	}
}

/**
 * Whether `candidate` (absolute, preferably realpath'd) is inside any root.
 * Uses path.relative boundary check (rejects `..` escapes).
 */
export function isInsideRoot(candidate: string, roots: string[]): boolean {
	const normalizedCandidate = normalize(candidate);
	for (const root of roots) {
		const normalizedRoot = normalize(root);
		if (normalizedCandidate === normalizedRoot) return true;
		const rel = relative(normalizedRoot, normalizedCandidate);
		if (rel === "") return true;
		if (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) {
			return true;
		}
	}
	return false;
}

/**
 * Resolve a user-supplied path against cwd and ensure it stays inside roots.
 * Follows symlinks via realpath when the path exists (blocks symlink escape).
 */
export async function checkPathUnderRoots(
	rawPath: string,
	roots: string[],
	opts: { mustExist?: boolean; cwd?: string } = {},
): Promise<PathCheckResult> {
	const cwd = opts.cwd ?? roots[0]!;
	const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);

	// Reject obvious escapes before touching the filesystem.
	const asResolved = normalize(abs);
	if (!isInsideRoot(asResolved, roots.map((r) => normalize(r)))) {
		// Still try realpath in case roots are realpath'd and abs isn't — but if the
		// non-real path already escapes, fail fast unless it might be a symlink *inside*.
		// For non-existing paths, resolve-only check is enough:
		try {
			await lstat(asResolved);
		} catch {
			return { ok: false, error: `path out of scope: ${rawPath}` };
		}
	}

	let resolved: string;
	try {
		resolved = await realpath(asResolved);
	} catch {
		if (opts.mustExist) {
			return { ok: false, error: `path not found: ${rawPath}` };
		}
		// Parent may exist; realpath the deepest existing prefix for jail check.
		resolved = await realpathExistingPrefix(asResolved);
		if (!isInsideRoot(resolved, roots) && !isInsideRoot(asResolved, roots)) {
			return { ok: false, error: `path out of scope: ${rawPath}` };
		}
		// For non-existent leaf under an allowed prefix, use normalized abs if under roots.
		if (isInsideRoot(asResolved, roots) || isInsideRoot(resolved, roots)) {
			return { ok: true, resolved: asResolved };
		}
		return { ok: false, error: `path out of scope: ${rawPath}` };
	}

	if (!isInsideRoot(resolved, roots)) {
		return { ok: false, error: `path out of scope: ${rawPath}` };
	}
	return { ok: true, resolved };
}

async function realpathExistingPrefix(absPath: string): Promise<string> {
	let current = absPath;
	for (;;) {
		try {
			return await realpath(current);
		} catch {
			const parent = resolve(current, "..");
			if (parent === current) return absPath;
			current = parent;
		}
	}
}

function textFromResult(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function withText(result: AgentToolResult<unknown>, text: string): AgentToolResult<unknown> {
	return {
		...result,
		content: [{ type: "text", text }],
	};
}

function errorResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: undefined,
		isError: true,
	};
}

function applyOutputCap(
	result: AgentToolResult<unknown>,
	maxBytes: number,
): AgentToolResult<unknown> {
	const text = textFromResult(result);
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return result;
	const truncated = truncateHead(text, { maxBytes });
	const note = `\n\n… [truncated: showing ${truncated.outputBytes}/${truncated.totalBytes} bytes, ${truncated.outputLines}/${truncated.totalLines} lines]`;
	return withText(result, truncated.content + note);
}

const PATH_PARAM_TOOLS = new Set(["grep", "find", "ls", "read"]);

export interface InnerToolBundle {
	/** grep / find / ls / read definitions for Context.tools */
	searchTools: Tool[];
	reportTool: Tool;
	/** search + report */
	allTools: Tool[];
	/** last-turn: report only */
	reportOnlyTools: Tool[];
	roots: string[];
	execute(
		name: string,
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>>;
}

/**
 * Build inner tool definitions and a sandboxed executor.
 */
export function createInnerTools(options: InnerToolsOptions): InnerToolBundle {
	const { cwd, innerToolMaxBytes } = options;
	const roots = options.allowedPaths?.length
		? options.allowedPaths.map((p) => normalize(p))
		: [normalize(cwd)];

	const grepDef = createGrepToolDefinition(cwd);
	const findDef = createFindToolDefinition(cwd);
	const lsDef = createLsToolDefinition(cwd);
	const readDef = createReadToolDefinition(cwd);

	const toTool = (def: {
		name: string;
		description: string;
		parameters: object;
	}): Tool => ({
		name: def.name,
		description: def.description,
		parameters: def.parameters,
	});

	const searchTools = [toTool(grepDef), toTool(findDef), toTool(lsDef), toTool(readDef)];
	const reportTool = createReportTool();
	const allTools = [...searchTools, reportTool];
	const reportOnlyTools = [reportTool];

	// Built-in execute types require ExtensionToolContext; runtime only needs ctx?.cwd || cwd (§14).
	const builtins: Record<string, { execute: (...args: any[]) => Promise<AgentToolResult<unknown>> }> = {
		grep: grepDef,
		find: findDef,
		ls: lsDef,
		read: readDef,
	};

	async function execute(
		name: string,
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>> {
		if (name === "report") {
			return {
				content: [{ type: "text", text: "Report received." }],
				details: params,
			};
		}

		const builtin = builtins[name];
		if (!builtin) {
			return errorResult(`Unknown tool: ${name}`);
		}

		const nextParams: Record<string, unknown> = { ...params };

		if (PATH_PARAM_TOOLS.has(name)) {
			const rawPath = nextParams.path;
			if (typeof rawPath === "string" && rawPath.length > 0) {
				const check = await checkPathUnderRoots(rawPath, roots, {
					cwd,
					mustExist: name === "read",
				});
				if (!check.ok) {
					return errorResult(check.error);
				}
				// Pass a path relative to cwd when possible so the built-in stays consistent.
				const rel = relative(cwd, check.resolved);
				nextParams.path = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : check.resolved;
			} else if (options.allowedPaths?.length) {
				// No path given but scoped: pin to first allowed root (relative to cwd).
				const pinned = relative(cwd, roots[0]!);
				nextParams.path = pinned === "" ? "." : pinned;
			} else if (name !== "read") {
				// default: cwd — already allowed
			} else {
				return errorResult("read requires path");
			}
		}

		if (name === "read") {
			let limit =
				typeof nextParams.limit === "number" && Number.isFinite(nextParams.limit)
					? Math.floor(nextParams.limit)
					: READ_DEFAULT_LIMIT;
			if (limit < 1) limit = READ_DEFAULT_LIMIT;
			if (limit > READ_MAX_LIMIT) limit = READ_MAX_LIMIT;
			nextParams.limit = limit;
		}

		try {
			const result = await builtin.execute(toolCallId, nextParams, signal, undefined, {
				cwd,
			});
			return applyOutputCap(result, innerToolMaxBytes);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return errorResult(msg);
		}
	}

	return {
		searchTools,
		reportTool,
		allTools,
		reportOnlyTools,
		roots,
		execute,
	};
}

