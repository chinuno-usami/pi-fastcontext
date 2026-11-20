/**
 * End-to-end `fast_context` tests via executeFastContext + fake modelRegistry.
 * Covers PLAN §11.1 gaps and §13 items verifiable without a real model/network.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type {
	Api,
	AssistantMessage,
	Context,
	JsonObject,
	Model,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type FastContextConfig } from "../src/config.ts";
import {
	clipMaxResults,
	executeFastContext,
	type FastContextDetails,
} from "../src/index.ts";
import { emptyUsage, type StreamSimpleRegistry } from "../src/loop.ts";
import { FLAG_NAME } from "../src/model-select.ts";

const here = dirname(fileURLToPath(import.meta.url));
const miniRepo = join(here, "fixtures", "mini-repo");
const outsideSecret = join(here, "fixtures", "outside-secret.txt");

function usage(partial: Partial<Usage> & Pick<Usage, "input" | "output">): Usage {
	return {
		input: partial.input,
		output: partial.output,
		cacheRead: partial.cacheRead ?? 0,
		cacheWrite: partial.cacheWrite ?? 0,
		totalTokens: partial.totalTokens ?? partial.input + partial.output,
		cost: partial.cost ?? {
			input: 0.01,
			output: 0.02,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.03,
		},
	};
}

function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	} as Model<Api>;
}

function assistant(opts: {
	toolCalls?: ToolCall[];
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	usage?: Usage;
	errorMessage?: string;
}): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolCalls) content.push(...opts.toolCalls);
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: opts.usage ?? usage({ input: 10, output: 5 }),
		stopReason: opts.stopReason ?? (opts.toolCalls?.length ? "toolUse" : "stop"),
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

function toolCall(name: string, args: JsonObject, id?: string): ToolCall {
	return {
		type: "toolCall",
		id: id ?? `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
		name,
		arguments: args,
	};
}

type ScriptStep =
	| AssistantMessage
	| ((ctx: Context, turnIndex: number) => AssistantMessage | Promise<AssistantMessage>);

function scriptedRegistry(
	script: ScriptStep[],
	opts?: {
		models?: Model<Api>[];
		auth?: (m: Model<Api>) => boolean;
	},
): StreamSimpleRegistry &
	Pick<ModelRegistry, "find" | "hasConfiguredAuth"> & { calls: Context[] } {
	const calls: Context[] = [];
	let i = 0;
	const models = opts?.models ?? [fakeModel()];
	const auth = opts?.auth ?? (() => true);
	return {
		calls,
		find(provider: string, id: string) {
			return models.find((m) => m.provider === provider && m.id === id);
		},
		hasConfiguredAuth(model: Model<Api>) {
			return auth(model);
		},
		streamSimple(_model, context) {
			calls.push(context);
			const step = script[i++];
			if (!step) {
				throw new Error(`script exhausted at call ${i}`);
			}
			const turnIndex = i;
			return {
				result: async () => {
					if (typeof step === "function") {
						return await step(context, turnIndex);
					}
					return step;
				},
			} as ReturnType<StreamSimpleRegistry["streamSimple"]>;
		},
	};
}

function assertDetailsShape(details: FastContextDetails, opts?: { expectUsage?: boolean }) {
	assert.equal(typeof details.model, "string");
	assert.equal(typeof details.turns, "number");
	assert.equal(typeof details.maxTurns, "number");
	assert.equal(typeof details.searches, "number");
	assert.ok(Array.isArray(details.turnHistory));
	assert.ok(Array.isArray(details.warnings));
	assert.equal(typeof details.durationMs, "number");
	assert.equal(typeof details.truncated, "boolean");
	assert.ok(details.usage);
	assert.equal(typeof details.usage.input, "number");
	assert.equal(typeof details.usage.output, "number");
	assert.equal(typeof details.usage.cacheRead, "number");
	assert.equal(typeof details.usage.cacheWrite, "number");
	assert.equal(typeof details.usage.totalTokens, "number");
	assert.ok(details.usage.cost);
	assert.equal(typeof details.usage.cost.total, "number");
	if (opts?.expectUsage) {
		assert.ok(details.usage.input > 0 || details.usage.output > 0);
	}
}

function makePi(flag?: string): ExtensionAPI {
	return {
		getFlag(name: string) {
			if (name === FLAG_NAME) return flag;
			return undefined;
		},
	} as unknown as ExtensionAPI;
}

function makeCtx(opts: {
	cwd?: string;
	registry: ReturnType<typeof scriptedRegistry>;
	mainModel?: Model<Api>;
	trusted?: boolean;
}): ExtensionToolContext {
	const main = opts.mainModel ?? fakeModel({ id: "main-model", provider: "test" });
	return {
		cwd: opts.cwd ?? miniRepo,
		model: main,
		modelRegistry: opts.registry as unknown as ModelRegistry,
		isProjectTrusted: () => opts.trusted ?? false,
		ui: {
			notify() {},
			setStatus() {},
		},
	} as unknown as ExtensionToolContext;
}

function testConfig(over: Partial<FastContextConfig> = {}): FastContextConfig {
	return {
		...DEFAULT_CONFIG,
		model: "test/test-model",
		timeoutMs: 30_000,
		...over,
	};
}

describe("clipMaxResults", () => {
	it("clips to [1, configMax] and falls back for invalid", () => {
		assert.equal(clipMaxResults(undefined, 12), 12);
		assert.equal(clipMaxResults(Number.NaN, 12), 12);
		assert.equal(clipMaxResults(0, 12), 1);
		assert.equal(clipMaxResults(-3, 12), 1);
		assert.equal(clipMaxResults(100, 12), 12);
		assert.equal(clipMaxResults(3.9, 12), 3);
		assert.equal(clipMaxResults(5, 12), 5);
	});
});

describe("executeFastContext (fake registry e2e)", () => {
	it("success: grep then report returns snippets, details, and usage", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("grep", { pattern: "greet", path: "src" })],
				usage: usage({ input: 11, output: 6 }),
			}),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [
							{
								path: "src/hello.ts",
								startLine: 1,
								endLine: 3,
								reason: "greet helper",
							},
						],
						notes: "found greet",
					}),
				],
				usage: usage({ input: 20, output: 8 }),
			}),
		]);

		const result = await executeFastContext(
			makePi("test/test-model"),
			"tc1",
			{ query: "where is greet?" },
			undefined,
			undefined,
			makeCtx({ registry }),
			{ config: testConfig() },
		);

		assert.notEqual(result.isError, true);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		assert.match(text, /fast_context:/);
		assert.match(text, /src\/hello\.ts:1-3/);
		assert.match(text, /greet/);
		assert.match(text, /notes: found greet/);

		assertDetailsShape(result.details as FastContextDetails, { expectUsage: true });
		assert.equal(result.details.model, "test/test-model");
		assert.equal(result.details.turns, 2);
		assert.equal(result.usage?.input, 31);
		assert.equal(result.usage?.output, 14);
		assert.equal(result.usage?.cost.total, 0.06);

		const structured = result.structuredContent as {
			results: Array<{ path: string; startLine: number; endLine: number }>;
			truncated: boolean;
			notes?: string;
		};
		assert.equal(structured.results.length, 1);
		assert.equal(structured.results[0]!.path, "src/hello.ts");
		assert.equal(structured.notes, "found greet");
		assert.equal(structured.truncated, false);
	});

	it("unset model: isError with empty usage and consistent details", async () => {
		const registry = scriptedRegistry([]);
		const result = await executeFastContext(
			makePi(),
			"tc-unset",
			{ query: "anything" },
			undefined,
			undefined,
			makeCtx({ registry }),
			{ config: testConfig({ model: undefined }) },
		);

		assert.equal(result.isError, true);
		assert.match(
			result.content.map((c) => ("text" in c ? c.text : "")).join(""),
			/no sub-model|\/fastcontext-model/i,
		);
		assertDetailsShape(result.details as FastContextDetails);
		assert.deepEqual(result.usage, emptyUsage());
		assert.deepEqual(result.details.usage, emptyUsage());
		assert.equal(result.details.model, "");
		assert.equal(result.details.maxTurns, DEFAULT_CONFIG.maxTurns);
		assert.deepEqual(result.structuredContent, { results: [], truncated: false });
	});

	it("not_found and no_auth errors keep details/usage shape", async () => {
		const model = fakeModel();
		const notFoundReg = scriptedRegistry([], {
			models: [],
			auth: () => true,
		});
		const notFound = await executeFastContext(
			makePi("test/missing"),
			"tc-nf",
			{ query: "x" },
			undefined,
			undefined,
			makeCtx({ registry: notFoundReg }),
			{ config: testConfig({ model: undefined }) },
		);
		assert.equal(notFound.isError, true);
		assert.match(
			notFound.content.map((c) => ("text" in c ? c.text : "")).join(""),
			/not found|Model not found/i,
		);
		assertDetailsShape(notFound.details as FastContextDetails);
		assert.deepEqual(notFound.usage, emptyUsage());

		const noAuthReg = scriptedRegistry([], {
			models: [model],
			auth: () => false,
		});
		const noAuth = await executeFastContext(
			makePi("test/test-model"),
			"tc-na",
			{ query: "x" },
			undefined,
			undefined,
			makeCtx({ registry: noAuthReg }),
			{ config: testConfig({ model: undefined }) },
		);
		assert.equal(noAuth.isError, true);
		assert.match(
			noAuth.content.map((c) => ("text" in c ? c.text : "")).join(""),
			/auth/i,
		);
		assertDetailsShape(noAuth.details as FastContextDetails);
		assert.deepEqual(noAuth.usage, emptyUsage());
	});

	it("paths jail via tool entry: ../ and absolute path → error + usage", async () => {
		const registry = scriptedRegistry([
			// Should never be called; roots fail before the loop streams.
			assistant({ text: "should not run", stopReason: "stop" }),
		]);

		const relEscape = await executeFastContext(
			makePi("test/test-model"),
			"tc-path-rel",
			{ query: "leak", paths: ["../outside-secret.txt"] },
			undefined,
			undefined,
			makeCtx({ registry }),
			{ config: testConfig() },
		);
		assert.equal(relEscape.isError, true);
		assert.match(
			relEscape.content.map((c) => ("text" in c ? c.text : "")).join(""),
			/out of scope|paths entry/i,
		);
		assertDetailsShape(relEscape.details as FastContextDetails);
		assert.ok(relEscape.usage);
		assert.equal(relEscape.details.kind, "error");
		assert.equal(registry.calls.length, 0);

		const absEscape = await executeFastContext(
			makePi("test/test-model"),
			"tc-path-abs",
			{ query: "leak", paths: [outsideSecret] },
			undefined,
			undefined,
			makeCtx({ registry: scriptedRegistry([]) }),
			{ config: testConfig() },
		);
		assert.equal(absEscape.isError, true);
		assert.match(
			absEscape.content.map((c) => ("text" in c ? c.text : "")).join(""),
			/out of scope|paths entry/i,
		);
		assertDetailsShape(absEscape.details as FastContextDetails);
	});

	it("paths:@prefix allowed when under cwd; symlink escape still rejected by inner tools", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [
							{
								path: "src/hello.ts",
								startLine: 1,
								endLine: 2,
								reason: "ok",
							},
						],
					}),
				],
				usage: usage({ input: 4, output: 2 }),
			}),
		]);
		const ok = await executeFastContext(
			makePi("test/test-model"),
			"tc-at",
			{ query: "greet", paths: ["@src"] },
			undefined,
			undefined,
			makeCtx({ registry }),
			{ config: testConfig() },
		);
		assert.notEqual(ok.isError, true);
		assert.equal(
			(ok.structuredContent as { results: unknown[] }).results.length,
			1,
		);

		const jailReg = scriptedRegistry([
			assistant({
				toolCalls: [
					toolCall("read", { path: "escape-link.txt", offset: 1, limit: 10 }),
				],
				usage: usage({ input: 2, output: 1 }),
			}),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [],
						notes: "could not read escape link",
					}),
				],
				usage: usage({ input: 2, output: 1 }),
			}),
		]);
		const jail = await executeFastContext(
			makePi("test/test-model"),
			"tc-symlink",
			{ query: "secret" },
			undefined,
			undefined,
			makeCtx({ registry: jailReg }),
			{ config: testConfig({ maxTurns: 3 }) },
		);
		assert.notEqual(jail.isError, true);
		// Inner tool should have returned an error toolResult; loop continues to report.
		assert.ok(jailReg.calls.length >= 2);
		const firstAssistantFollowUp = jailReg.calls[1]!;
		const toolResults = firstAssistantFollowUp.messages.filter((m) => m.role === "toolResult");
		assert.ok(
			toolResults.some((m) => m.role === "toolResult" && m.isError === true),
			"symlink escape must surface as isError tool result",
		);
	});

	it("maxResults from params is clipped and applied to report", async () => {
		// Non-overlapping ranges (gap > 3) so snippets.merge does not collapse them.
		const many = [1, 8, 15, 22, 29, 36].map((start, i) => ({
			path: "src/lines.txt",
			startLine: start,
			endLine: start,
			reason: `r${i}`,
		}));
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("report", { results: many })],
				usage: usage({ input: 5, output: 5 }),
			}),
		]);

		const result = await executeFastContext(
			makePi("test/test-model"),
			"tc-mr",
			{ query: "many", maxResults: 100 }, // clipped to config maxResults=3
			undefined,
			undefined,
			makeCtx({ registry }),
			{ config: testConfig({ maxResults: 3 }) },
		);

		assert.notEqual(result.isError, true);
		const structured = result.structuredContent as {
			results: unknown[];
		};
		assert.equal(structured.results.length, 3);
		assert.ok(
			(result.details as FastContextDetails).warnings.some((w) =>
				/maxResults/i.test(w),
			),
		);

		const clippedLow = await executeFastContext(
			makePi("test/test-model"),
			"tc-mr2",
			{ query: "many", maxResults: 0 }, // → 1
			undefined,
			undefined,
			makeCtx({
				registry: scriptedRegistry([
					assistant({
						toolCalls: [toolCall("report", { results: many })],
						usage: usage({ input: 1, output: 1 }),
					}),
				]),
			}),
			{ config: testConfig({ maxResults: 12 }) },
		);
		assert.equal(
			(clippedLow.structuredContent as { results: unknown[] }).results.length,
			1,
		);
	});

	it("sameAsMain adds 未节省成本 warning on success", async () => {
		const model = fakeModel();
		const registry = scriptedRegistry(
			[
				assistant({
					toolCalls: [
						toolCall("report", {
							results: [
								{
									path: "src/hello.ts",
									startLine: 1,
									endLine: 2,
									reason: "x",
								},
							],
						}),
					],
					usage: usage({ input: 1, output: 1 }),
				}),
			],
			{ models: [model] },
		);

		const result = await executeFastContext(
			makePi("test/test-model"),
			"tc-same",
			{ query: "x" },
			undefined,
			undefined,
			makeCtx({ registry, mainModel: model }),
			{ config: testConfig() },
		);
		assert.notEqual(result.isError, true);
		assert.ok(
			(result.details as FastContextDetails).warnings.some((w) =>
				/未节省成本|same as the main/i.test(w),
			),
		);
	});

	it("abort signal → cancelled with details.usage", async () => {
		const ac = new AbortController();
		ac.abort();
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("report", { results: [] })],
				usage: usage({ input: 1, output: 1 }),
			}),
		]);
		const result = await executeFastContext(
			makePi("test/test-model"),
			"tc-abort",
			{ query: "x" },
			ac.signal,
			undefined,
			makeCtx({ registry }),
			{ config: testConfig() },
		);
		assert.equal(result.isError, true);
		assert.match(
			result.content.map((c) => ("text" in c ? c.text : "")).join(""),
			/Cancelled/i,
		);
		assertDetailsShape(result.details as FastContextDetails);
		assert.equal(result.details.kind, "cancelled");
		assert.ok(result.usage);
	});

	it("onUpdate partial details share the same shape", async () => {
		const partials: FastContextDetails[] = [];
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("grep", { pattern: "greet", path: "src" })],
				usage: usage({ input: 3, output: 2 }),
			}),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [
							{
								path: "src/hello.ts",
								startLine: 1,
								endLine: 2,
								reason: "ok",
							},
						],
					}),
				],
				usage: usage({ input: 3, output: 2 }),
			}),
		]);

		await executeFastContext(
			makePi("test/test-model"),
			"tc-upd",
			{ query: "greet" },
			undefined,
			(u) => {
				partials.push(u.details as FastContextDetails);
			},
			makeCtx({ registry }),
			{ config: testConfig() },
		);

		assert.ok(partials.length >= 1);
		for (const d of partials) {
			assertDetailsShape(d);
			assert.equal(d.maxTurns, DEFAULT_CONFIG.maxTurns);
		}
	});
});
