/**
 * Sub-model resolution, /fastcontext-model command, --fastcontext-model flag, status. (M1)
 */
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
	ScopedModel,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig, type FastContextConfig } from "./config.ts";

export const FLAG_NAME = "fastcontext-model";
export const COMMAND_NAME = "fastcontext-model";
export const STATUS_KEY = "fastcontext";

export type ModelRefSource = "flag" | "config";

export type ResolveSubModelOk = {
	ok: true;
	model: Model<string>;
	ref: string;
	source: ModelRefSource;
	sameAsMain: boolean;
};

export type ResolveSubModelErr = {
	ok: false;
	code: "unset" | "not_found" | "no_auth";
	error: string;
	ref?: string;
};

export type ResolveSubModelResult = ResolveSubModelOk | ResolveSubModelErr;

export type ModelRegistryView = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "getAvailable">;

/** Split `provider/id` on the first `/` (id may itself contain `/`). */
export function parseProviderModel(ref: string): { provider: string; id: string } | null {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) {
		return null;
	}
	return {
		provider: trimmed.slice(0, slash),
		id: trimmed.slice(slash + 1),
	};
}

export function modelRef(model: Pick<Model<string>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function formatStatus(ref: string | undefined): string {
	return ref ? `fc: ${ref}` : "fc: (未设置)";
}

/** Label for select UI; appends input/output cost when present. */
export function formatModelSelectLabel(model: Model<string>): string {
	const base = modelRef(model);
	const cost = model.cost;
	if (
		cost &&
		typeof cost.input === "number" &&
		typeof cost.output === "number" &&
		Number.isFinite(cost.input) &&
		Number.isFinite(cost.output)
	) {
		return `${base}  (in $${cost.input}/M · out $${cost.output}/M)`;
	}
	return base;
}

/**
 * Candidates: scoped models first (if any), then remaining from getAvailable().
 * Deduped by provider/id, stable order.
 */
export function listCandidateModels(
	scopedModels: readonly ScopedModel[],
	available: readonly Model<string>[],
): Model<string>[] {
	const seen = new Set<string>();
	const out: Model<string>[] = [];

	const push = (m: Model<string>) => {
		const key = modelRef(m);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(m);
	};

	for (const s of scopedModels) {
		push(s.model);
	}
	for (const m of available) {
		push(m);
	}
	return out;
}

export function buildSelectItems(models: readonly Model<string>[]): string[] {
	return models.map(formatModelSelectLabel);
}

/** Recover provider/id from a select label that may include cost suffix. */
export function refFromSelectLabel(label: string): string {
	const cut = label.indexOf("  (");
	return (cut >= 0 ? label.slice(0, cut) : label).trim();
}

export type ParsedCommandArgs = {
	project: boolean;
	clear: boolean;
	/** Raw provider/id when setting directly */
	modelRef?: string;
};

export function parseCommandArgs(args: string): ParsedCommandArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let project = false;
	const rest: string[] = [];
	for (const t of tokens) {
		if (t === "--project") {
			project = true;
		} else {
			rest.push(t);
		}
	}
	if (rest.length === 0) {
		return { project, clear: false };
	}
	if (rest[0] === "clear") {
		return { project, clear: true };
	}
	return { project, clear: false, modelRef: rest.join(" ") };
}

export function getArgumentCompletions(
	argumentPrefix: string,
	candidates: readonly string[],
): AutocompleteItem[] | null {
	const prefix = argumentPrefix.trim();
	const staticOpts = ["clear", "--project", "--project clear"];
	const pool = [...staticOpts, ...candidates];
	const filtered = pool
		.filter((v) => v.startsWith(prefix) || (prefix.length > 0 && v.includes(prefix)))
		.map((v) => ({ value: v, label: v }));
	return filtered.length > 0 ? filtered : null;
}

export type ResolveSubModelOptions = {
	registry: ModelRegistryView;
	/** From --fastcontext-model */
	flagModel?: string;
	/** Merged config.model */
	configModel?: string;
	mainModel?: Pick<Model<string>, "provider" | "id">;
};

/**
 * Resolve order: flag → config.model. Validates find + hasConfiguredAuth.
 * Skips supportsTools (Model has no such field; see README §14).
 */
export function resolveSubModel(opts: ResolveSubModelOptions): ResolveSubModelResult {
	const raw = opts.flagModel?.trim() || opts.configModel?.trim() || undefined;
	if (!raw) {
		return {
			ok: false,
			code: "unset",
			error:
				"No fastcontext model configured. Run /fastcontext-model or pass --fastcontext-model provider/id.",
		};
	}

	const parsed = parseProviderModel(raw);
	if (!parsed) {
		return {
			ok: false,
			code: "not_found",
			ref: raw,
			error: `Invalid model ref "${raw}" (expected provider/id).`,
		};
	}

	const model = opts.registry.find(parsed.provider, parsed.id);
	if (!model) {
		return {
			ok: false,
			code: "not_found",
			ref: raw,
			error: `Model not found: ${parsed.provider}/${parsed.id}. Run /fastcontext-model to pick one.`,
		};
	}

	if (!opts.registry.hasConfiguredAuth(model)) {
		return {
			ok: false,
			code: "no_auth",
			ref: modelRef(model),
			error: `Provider "${model.provider}" has no configured auth for ${modelRef(model)}.`,
		};
	}

	const sameAsMain = Boolean(
		opts.mainModel &&
			opts.mainModel.provider === model.provider &&
			opts.mainModel.id === model.id,
	);

	return {
		ok: true,
		model,
		ref: modelRef(model),
		source: opts.flagModel?.trim() ? "flag" : "config",
		sameAsMain,
	};
}

export async function updateFastContextStatus(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	configOverride?: FastContextConfig,
): Promise<string | undefined> {
	const flag = (pi.getFlag(FLAG_NAME) as string | undefined)?.trim() || undefined;
	let configModel = configOverride?.model;
	if (configModel === undefined && !configOverride) {
		const loaded = await loadConfig({
			cwd: ctx.cwd,
			isProjectTrusted: ctx.isProjectTrusted(),
			notify: (msg, level) => ctx.ui.notify(msg, level),
		});
		configModel = loaded.config.model;
	}
	const resolved = resolveSubModel({
		registry: ctx.modelRegistry,
		flagModel: flag,
		configModel,
		mainModel: ctx.model,
	});
	const ref = resolved.ok ? resolved.ref : undefined;
	ctx.ui.setStatus(STATUS_KEY, formatStatus(ref));
	return ref;
}

async function applyModelChoice(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	ref: string,
	project: boolean,
): Promise<void> {
	const parsed = parseProviderModel(ref);
	if (!parsed) {
		ctx.ui.notify(`Invalid model ref "${ref}" (expected provider/id)`, "error");
		return;
	}

	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		ctx.ui.notify(`Model not found: ${ref}`, "error");
		return;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		ctx.ui.notify(`No auth configured for ${ref}`, "error");
		return;
	}

	if (project) {
		if (!ctx.isProjectTrusted()) {
			ctx.ui.notify("Project is not trusted; cannot write project fastcontext.json", "error");
			return;
		}
		await saveConfig({ model: modelRef(model) }, { scope: "project", cwd: ctx.cwd });
		ctx.ui.notify(`fastcontext model (project): ${modelRef(model)}`, "info");
	} else {
		await saveConfig({ model: modelRef(model) }, { scope: "global" });
		ctx.ui.notify(`fastcontext model: ${modelRef(model)}`, "info");
	}

	await updateFastContextStatus(ctx, pi);
}

async function clearModel(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	project: boolean,
): Promise<void> {
	if (project) {
		if (!ctx.isProjectTrusted()) {
			ctx.ui.notify("Project is not trusted; cannot clear project fastcontext.json", "error");
			return;
		}
		await saveConfig({}, { scope: "project", cwd: ctx.cwd, clearModel: true });
		ctx.ui.notify("Cleared fastcontext model from project config", "info");
	} else {
		await saveConfig({}, { scope: "global", clearModel: true });
		ctx.ui.notify("Cleared fastcontext model from global config", "info");
	}
	await updateFastContextStatus(ctx, pi);
}

async function openSelector(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	project: boolean,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"No UI available. Use /fastcontext-model provider/id or --fastcontext-model provider/id",
			"error",
		);
		return;
	}

	const candidates = listCandidateModels(ctx.scopedModels, ctx.modelRegistry.getAvailable());
	if (candidates.length === 0) {
		ctx.ui.notify("No available models in modelRegistry", "error");
		return;
	}

	const items = buildSelectItems(candidates);
	const title = project
		? "Select fastcontext model (project config)"
		: "Select fastcontext model";
	const chosen = await ctx.ui.select(title, items);
	if (!chosen) {
		return;
	}
	await applyModelChoice(ctx, pi, refFromSelectLabel(chosen), project);
}

export async function handleFastContextModelCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const parsed = parseCommandArgs(args);
	if (parsed.clear) {
		await clearModel(ctx, pi, parsed.project);
		return;
	}
	if (parsed.modelRef) {
		await applyModelChoice(ctx, pi, parsed.modelRef, parsed.project);
		return;
	}
	await openSelector(ctx, pi, parsed.project);
}

/** Register flag, command, and status updates for M1. */
export function registerModelSelect(pi: ExtensionAPI): void {
	/** Cached provider/id refs for argument completions (refreshed on session_start). */
	let completionRefs: string[] = [];

	pi.registerFlag(FLAG_NAME, {
		description: "Sub-model for fast_context (provider/id); overrides config for this session",
		type: "string",
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Select or clear the fast_context sub-model",
		getArgumentCompletions: (argumentPrefix) => {
			return getArgumentCompletions(argumentPrefix, completionRefs);
		},
		handler: async (args, ctx) => {
			await handleFastContextModelCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		completionRefs = listCandidateModels(
			ctx.scopedModels,
			ctx.modelRegistry.getAvailable(),
		).map(modelRef);
		await updateFastContextStatus(ctx, pi);
	});

	// Refresh display if user changes main model (status still shows sub-model; cheap re-resolve).
	pi.on("model_select", async (_event, ctx) => {
		await updateFastContextStatus(ctx, pi);
	});
}
