import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildModelSelectItems,
	buildSelectItems,
	filterModelSelectItems,
	formatModelSelectLabel,
	formatStatus,
	getArgumentCompletions,
	listCandidateModels,
	modelRef,
	parseCommandArgs,
	parseProviderModel,
	refFromSelectLabel,
	resolveSubModel,
	type ModelRegistryView,
} from "../src/model-select.ts";

function fakeModel(
	provider: string,
	id: string,
	opts?: { cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } },
): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test",
		input: ["text"],
		cost: opts?.cost ?? { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function fakeRegistry(models: Model<string>[], authed: Set<string>): ModelRegistryView {
	return {
		find(provider, modelId) {
			return models.find((m) => m.provider === provider && m.id === modelId);
		},
		hasConfiguredAuth(model) {
			return authed.has(modelRef(model));
		},
		getAvailable() {
			return models;
		},
	};
}

describe("model-select", () => {
	it("parseProviderModel splits on first slash", () => {
		assert.deepEqual(parseProviderModel("openai/gpt-4o-mini"), {
			provider: "openai",
			id: "gpt-4o-mini",
		});
		assert.deepEqual(parseProviderModel("openrouter/qwen/qwen3-coder"), {
			provider: "openrouter",
			id: "qwen/qwen3-coder",
		});
		assert.equal(parseProviderModel("noslash"), null);
		assert.equal(parseProviderModel("/onlyid"), null);
		assert.equal(parseProviderModel("provider/"), null);
	});

	it("parseCommandArgs handles --project, clear, and direct ref", () => {
		assert.deepEqual(parseCommandArgs(""), { project: false, clear: false });
		assert.deepEqual(parseCommandArgs("clear"), { project: false, clear: true });
		assert.deepEqual(parseCommandArgs("--project clear"), { project: true, clear: true });
		assert.deepEqual(parseCommandArgs("openai/gpt-4o-mini"), {
			project: false,
			clear: false,
			modelRef: "openai/gpt-4o-mini",
		});
		assert.deepEqual(parseCommandArgs("--project openai/gpt-4o-mini"), {
			project: true,
			clear: false,
			modelRef: "openai/gpt-4o-mini",
		});
	});

	it("formatStatus and select labels", () => {
		assert.equal(formatStatus(undefined), "fc: (未设置)");
		assert.equal(formatStatus("openai/gpt-4o-mini"), "fc: openai/gpt-4o-mini");
		const m = fakeModel("openai", "mini", {
			cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		});
		assert.equal(formatModelSelectLabel(m), "openai/mini  (in $0.15/M · out $0.6/M)");
		assert.equal(refFromSelectLabel(formatModelSelectLabel(m)), "openai/mini");
	});

	it("listCandidateModels prefers scoped then available, deduped", () => {
		const a = fakeModel("a", "1");
		const b = fakeModel("b", "2");
		const c = fakeModel("c", "3");
		const listed = listCandidateModels([{ model: b }, { model: a }], [a, c, b]);
		assert.deepEqual(listed.map(modelRef), ["b/2", "a/1", "c/3"]);
		assert.deepEqual(buildSelectItems([a]).map(refFromSelectLabel), ["a/1"]);
		assert.deepEqual(
			buildModelSelectItems([a]).map((i) => i.value),
			["a/1"],
		);
	});

	it("filterModelSelectItems fuzzy-matches provider/id keywords", () => {
		const items = buildModelSelectItems([
			fakeModel("openai", "gpt-4o-mini"),
			fakeModel("anthropic", "claude-haiku"),
			fakeModel("openrouter", "qwen/qwen3-coder"),
		]);
		assert.equal(filterModelSelectItems(items, "").length, 3);
		assert.deepEqual(
			filterModelSelectItems(items, "haiku").map((i) => i.value),
			["anthropic/claude-haiku"],
		);
		assert.deepEqual(
			filterModelSelectItems(items, "openai mini").map((i) => i.value),
			["openai/gpt-4o-mini"],
		);
		assert.deepEqual(
			filterModelSelectItems(items, "qwen").map((i) => i.value),
			["openrouter/qwen/qwen3-coder"],
		);
		assert.deepEqual(filterModelSelectItems(items, "zzz-no-match"), []);
	});

	it("resolveSubModel: unset / flag over config / not_found / no_auth / sameAsMain", () => {
		const cheap = fakeModel("openai", "mini");
		const main = fakeModel("openai", "mini");
		const other = fakeModel("anthropic", "haiku");
		const registry = fakeRegistry([cheap, other], new Set(["openai/mini"]));

		const unset = resolveSubModel({ registry });
		assert.equal(unset.ok, false);
		if (!unset.ok) assert.equal(unset.code, "unset");

		const fromFlag = resolveSubModel({
			registry,
			flagModel: "openai/mini",
			configModel: "anthropic/haiku",
			mainModel: main,
		});
		assert.equal(fromFlag.ok, true);
		if (fromFlag.ok) {
			assert.equal(fromFlag.source, "flag");
			assert.equal(fromFlag.sameAsMain, true);
			assert.equal(fromFlag.ref, "openai/mini");
		}

		const fromConfig = resolveSubModel({
			registry,
			configModel: "openai/mini",
			mainModel: fakeModel("anthropic", "opus"),
		});
		assert.equal(fromConfig.ok, true);
		if (fromConfig.ok) {
			assert.equal(fromConfig.source, "config");
			assert.equal(fromConfig.sameAsMain, false);
		}

		const missing = resolveSubModel({ registry, configModel: "missing/x" });
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.code, "not_found");

		const noAuth = resolveSubModel({ registry, configModel: "anthropic/haiku" });
		assert.equal(noAuth.ok, false);
		if (!noAuth.ok) assert.equal(noAuth.code, "no_auth");
	});

	it("getArgumentCompletions filters static and candidate refs", () => {
		const items = getArgumentCompletions("cle", ["openai/mini"]);
		assert.ok(items);
		assert.ok(items!.some((i) => i.value === "clear"));

		const modelItems = getArgumentCompletions("openai", ["openai/mini", "anthropic/haiku"]);
		assert.ok(modelItems);
		assert.deepEqual(
			modelItems!.map((i) => i.value),
			["openai/mini"],
		);
	});
});
