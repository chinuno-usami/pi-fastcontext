/**
 * Configuration defaults, merge/validate, and global/project load/save. (M1)
 * Paths use getAgentDir() and CONFIG_DIR_NAME — never hardcode ".pi".
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface FastContextConfig {
	model?: string;
	reasoning: ReasoningLevel;
	maxTurns: number;
	maxParallelCalls: number;
	maxResults: number;
	maxOutputBytes: number;
	maxLinesPerSnippet: number;
	innerToolMaxBytes: number;
	timeoutMs: number;
	nudgeBroadSearch: boolean;
}

/** Partial overlay as stored in fastcontext.json (all fields optional). */
export type FastContextConfigFile = Partial<FastContextConfig>;

export const DEFAULT_CONFIG: FastContextConfig = {
	reasoning: "low",
	maxTurns: 4,
	maxParallelCalls: 8,
	maxResults: 12,
	maxOutputBytes: 12_000,
	maxLinesPerSnippet: 40,
	innerToolMaxBytes: 16_000,
	timeoutMs: 90_000,
	nudgeBroadSearch: false,
};

const REASONING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high"]);

export type NotifyFn = (message: string, level?: "info" | "warning" | "error") => void;

export function globalConfigPath(override?: string): string {
	return override ?? join(getAgentDir(), "fastcontext.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "fastcontext.json");
}

function isPositiveInt(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 1;
}

function isPositiveNumber(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Merge raw overlays onto defaults. Invalid fields fall back to the default
 * for that field. Returns the resolved config and whether any field was invalid.
 */
export function mergeConfig(
	...overlays: Array<FastContextConfigFile | null | undefined>
): { config: FastContextConfig; hadInvalid: boolean; invalidKeys: string[] } {
	const invalidKeys: string[] = [];
	const out: FastContextConfig = { ...DEFAULT_CONFIG };

	const apply = (raw: FastContextConfigFile) => {
		if ("model" in raw) {
			const m = raw.model;
			if (m === undefined || m === null) {
				delete out.model;
			} else if (typeof m === "string" && m.trim().length > 0) {
				out.model = m.trim();
			} else {
				invalidKeys.push("model");
				delete out.model;
			}
		}

		if ("reasoning" in raw && raw.reasoning !== undefined) {
			if (typeof raw.reasoning === "string" && REASONING_LEVELS.has(raw.reasoning)) {
				out.reasoning = raw.reasoning as ReasoningLevel;
			} else {
				invalidKeys.push("reasoning");
				out.reasoning = DEFAULT_CONFIG.reasoning;
			}
		}

		const intFields = [
			"maxTurns",
			"maxParallelCalls",
			"maxResults",
			"maxLinesPerSnippet",
		] as const;
		for (const key of intFields) {
			if (key in raw && raw[key] !== undefined) {
				if (isPositiveInt(raw[key])) {
					out[key] = raw[key];
				} else {
					invalidKeys.push(key);
					out[key] = DEFAULT_CONFIG[key];
				}
			}
		}

		const numFields = ["maxOutputBytes", "innerToolMaxBytes", "timeoutMs"] as const;
		for (const key of numFields) {
			if (key in raw && raw[key] !== undefined) {
				const v = raw[key];
				if (isPositiveNumber(v) && Number.isInteger(v)) {
					out[key] = v;
				} else {
					invalidKeys.push(key);
					out[key] = DEFAULT_CONFIG[key];
				}
			}
		}

		if ("nudgeBroadSearch" in raw && raw.nudgeBroadSearch !== undefined) {
			if (typeof raw.nudgeBroadSearch === "boolean") {
				out.nudgeBroadSearch = raw.nudgeBroadSearch;
			} else {
				invalidKeys.push("nudgeBroadSearch");
				out.nudgeBroadSearch = DEFAULT_CONFIG.nudgeBroadSearch;
			}
		}
	};

	for (const overlay of overlays) {
		if (overlay && typeof overlay === "object") {
			apply(overlay);
		}
	}

	return {
		config: out,
		hadInvalid: invalidKeys.length > 0,
		invalidKeys: [...new Set(invalidKeys)],
	};
}

async function readJsonFile(path: string): Promise<{
	data: FastContextConfigFile | null;
	parseError: boolean;
	missing: boolean;
}> {
	try {
		const text = await readFile(path, "utf8");
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { data: null, parseError: true, missing: false };
			}
			return { data: parsed as FastContextConfigFile, parseError: false, missing: false };
		} catch {
			return { data: null, parseError: true, missing: false };
		}
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") {
			return { data: null, parseError: false, missing: true };
		}
		return { data: null, parseError: true, missing: false };
	}
}

export type LoadConfigOptions = {
	cwd: string;
	isProjectTrusted: boolean;
	notify?: NotifyFn;
	/** Test override for global config path */
	globalPath?: string;
};

export type LoadConfigResult = {
	config: FastContextConfig;
	globalPath: string;
	projectPath: string;
	projectRead: boolean;
};

/**
 * Load global then (if trusted) project config. Project overrides global.
 * Illegal values fall back to defaults; notify once if anything was invalid.
 */
export async function loadConfig(opts: LoadConfigOptions): Promise<LoadConfigResult> {
	const gPath = globalConfigPath(opts.globalPath);
	const pPath = projectConfigPath(opts.cwd);

	const globalFile = await readJsonFile(gPath);
	let projectFile: Awaited<ReturnType<typeof readJsonFile>> = {
		data: null,
		parseError: false,
		missing: true,
	};
	let projectRead = false;

	if (opts.isProjectTrusted) {
		projectFile = await readJsonFile(pPath);
		projectRead = !projectFile.missing;
	}

	const overlays: FastContextConfigFile[] = [];
	if (globalFile.data) overlays.push(globalFile.data);
	if (opts.isProjectTrusted && projectFile.data) overlays.push(projectFile.data);

	const { config, hadInvalid, invalidKeys } = mergeConfig(...overlays);

	const parseProblems =
		globalFile.parseError || (opts.isProjectTrusted && projectFile.parseError);

	if ((hadInvalid || parseProblems) && opts.notify) {
		const parts: string[] = [];
		if (parseProblems) parts.push("invalid JSON in fastcontext.json");
		if (hadInvalid) parts.push(`invalid fields: ${invalidKeys.join(", ")}`);
		opts.notify(
			`fastcontext: ${parts.join("; ")} — falling back to defaults for those values`,
			"warning",
		);
	}

	return { config, globalPath: gPath, projectPath: pPath, projectRead };
}

export type SaveConfigOptions = {
	scope: "global" | "project";
	cwd?: string;
	/** Test override for global config path */
	globalPath?: string;
	/** When true, remove `model` from the stored file */
	clearModel?: boolean;
};

/**
 * Merge a patch into the existing config file on disk and write it back.
 * Only configuration files are written (extension remains otherwise read-only).
 */
export async function saveConfig(
	patch: FastContextConfigFile,
	opts: SaveConfigOptions,
): Promise<string> {
	let path: string;
	if (opts.scope === "global") {
		path = globalConfigPath(opts.globalPath);
	} else {
		if (!opts.cwd) {
			throw new Error("saveConfig(project) requires cwd");
		}
		path = projectConfigPath(opts.cwd);
	}

	const existing = await readJsonFile(path);
	const base: FastContextConfigFile =
		existing.data && !existing.parseError ? { ...existing.data } : {};

	const next: FastContextConfigFile = { ...base, ...patch };
	if (opts.clearModel || ("model" in patch && !patch.model)) {
		delete next.model;
	}

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return path;
}
