/**
 * Sub-model resolution, /fastcontext-model command, --fastcontext-model flag, status. (M1)
 */
import type { Model } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ModelRegistry,
	type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type AutocompleteItem,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
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

/** SelectList items: value is provider/id; label may include cost. */
export function buildModelSelectItems(models: readonly Model<string>[]): SelectItem[] {
	return models.map((m) => ({
		value: modelRef(m),
		label: formatModelSelectLabel(m),
	}));
}

/**
 * Keyword / fuzzy filter for the model selector (and argument completions).
 * Empty query returns all items in original order.
 */
export function filterModelSelectItems(
	items: readonly SelectItem[],
	query: string,
): SelectItem[] {
	const q = query.trim();
	if (!q) {
		return [...items];
	}
	return fuzzyFilter([...items], q, (item) => `${item.value} ${item.label}`);
}

/** Recover provider/id from a select label that may include cost suffix. */
export function refFromSelectLabel(label: string): string {
	const cut = label.indexOf("  (");
	return (cut >= 0 ? label.slice(0, cut) : label).trim();
}

const MODEL_SELECT_LIST_LAYOUT = {
	minPrimaryColumnWidth: 24,
	maxPrimaryColumnWidth: 96,
};

/**
 * Interactive model pick: TUI uses type-to-search (fuzzy); RPC/other falls back to ui.select.
 * Returns provider/id, or undefined if cancelled.
 */
export async function selectModelInteractively(
	ctx: ExtensionCommandContext,
	title: string,
	items: readonly SelectItem[],
): Promise<string | undefined> {
	if (items.length === 0) {
		return undefined;
	}

	if (ctx.mode === "tui") {
		const chosen = await ctx.ui.custom<string | undefined>(
			(tui, theme, keybindings, done) => {
				const allItems = [...items];
				const searchInput = new Input();
				const listContainer = new Container();
				let selectList: SelectList;

				const listTheme = {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("muted", text),
					noMatch: (text: string) => theme.fg("muted", text),
				};

				const buildList = (filtered: readonly SelectItem[], preselect?: string): SelectList => {
					const list = new SelectList(
						[...filtered],
						Math.min(Math.max(filtered.length, 1), 10),
						listTheme,
						MODEL_SELECT_LIST_LAYOUT,
					);
					if (preselect) {
						const idx = filtered.findIndex((i) => i.value === preselect);
						if (idx >= 0) {
							list.setSelectedIndex(idx);
						}
					}
					list.onSelect = (item) => done(item.value);
					list.onCancel = () => done(undefined);
					return list;
				};

				const applyFilter = (query: string) => {
					const filtered = filterModelSelectItems(allItems, query);
					const prev = selectList.getSelectedItem()?.value;
					selectList = buildList(filtered, prev);
					listContainer.clear();
					listContainer.addChild(selectList);
					tui.requestRender();
				};

				searchInput.onSubmit = () => {
					selectList.handleInput("\r");
				};

				selectList = buildList(allItems);
				listContainer.addChild(selectList);

				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(searchInput);
				container.addChild(new Spacer(1));
				container.addChild(listContainer);
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							"  Type to filter · ↑↓ navigate · Enter to select · Esc to cancel",
						),
						0,
						0,
					),
				);
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

				let focused = true;
				return {
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						focused = value;
						searchInput.focused = value;
					},
					capturesViewportInput: true,
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						const isNav =
							keybindings.matches(data, "tui.select.up") ||
							keybindings.matches(data, "tui.select.down") ||
							keybindings.matches(data, "tui.select.pageUp") ||
							keybindings.matches(data, "tui.select.pageDown") ||
							keybindings.matches(data, "tui.select.confirm") ||
							keybindings.matches(data, "tui.select.cancel");
						if (isNav) {
							selectList.handleInput(data);
							tui.requestRender();
							return;
						}
						searchInput.handleInput(data);
						applyFilter(searchInput.getValue());
					},
				};
			},
			{ blocked: { kind: "question", message: title } },
		);
		return chosen;
	}

	const labels = items.map((i) => i.label);
	const picked = await ctx.ui.select(title, labels);
	if (!picked) {
		return undefined;
	}
	return refFromSelectLabel(picked);
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

	const items = buildModelSelectItems(candidates);
	const title = project
		? "Select fastcontext model (project config)"
		: "Select fastcontext model";
	const chosen = await selectModelInteractively(ctx, title, items);
	if (!chosen) {
		return;
	}
	await applyModelChoice(ctx, pi, chosen, project);
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
