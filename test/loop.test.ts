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
import { DEFAULT_CONFIG, type FastContextConfig } from "../src/config.ts";
import {
	addUsage,
	combineSignals,
	emptyUsage,
	runSearchLoop,
	validateReportParams,
	weakParseGrepHits,
	type StreamSimpleRegistry,
} from "../src/loop.ts";
import { resolveAllowedRoots } from "../src/inner-tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const miniRepo = join(here, "fixtures", "mini-repo");

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

function scriptedRegistry(script: ScriptStep[]): StreamSimpleRegistry & { calls: Context[] } {
	const calls: Context[] = [];
	let i = 0;
	return {
		calls,
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

function baseConfig(over: Partial<FastContextConfig> = {}): FastContextConfig {
	return { ...DEFAULT_CONFIG, maxTurns: 4, maxParallelCalls: 8, timeoutMs: 30_000, ...over };
}

describe("loop helpers", () => {
	it("emptyUsage / addUsage accumulate tokens and cost", () => {
		const a = emptyUsage();
		const b = addUsage(a, usage({ input: 3, output: 4, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } }));
		const c = addUsage(b, usage({ input: 7, output: 1, cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 } }));
		assert.equal(c.input, 10);
		assert.equal(c.output, 5);
		assert.equal(c.cost.total, 4);
	});

	it("combineSignals aborts on timeout", async () => {
		const { signal, timeout } = combineSignals(undefined, 20);
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(timeout.aborted, true);
		assert.equal(signal.aborted, true);
	});

	it("weakParseGrepHits extracts path:line", () => {
		const hits = weakParseGrepHits(
			["src/hello.ts:1:export function greet\nsrc/hello.ts:2:  return"],
			12,
		);
		assert.ok(hits.length >= 1);
		assert.equal(hits[0]!.path, "src/hello.ts");
		assert.equal(hits[0]!.startLine, 1);
	});

	it("validateReportParams clips endLine and rejects escapes", async () => {
		const { roots } = await resolveAllowedRoots(miniRepo);
		const ok = await validateReportParams(
			{
				results: [
					{ path: "src/hello.ts", startLine: 1, endLine: 999, reason: "greet" },
					{ path: "../outside-secret.txt", startLine: 1, endLine: 1, reason: "nope" },
				],
			},
			{ cwd: miniRepo, roots, maxResults: 12 },
		);
		assert.equal(ok.results.length, 1);
		assert.equal(ok.results[0]!.path, "src/hello.ts");
		assert.ok(ok.results[0]!.endLine < 999);
		assert.ok(ok.warnings.some((w) => w.includes("outside") || w.includes("out of scope") || w.includes("skipped")));
	});
});

describe("runSearchLoop", () => {
	it("normal: one parallel grep turn then report", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [
					toolCall("grep", { pattern: "greet", path: "src" }),
					toolCall("grep", { pattern: "hello", path: "src" }),
				],
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
						notes: "found",
					}),
				],
				usage: usage({ input: 20, output: 8 }),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ maxTurns: 4 }),
			query: "where is greet?",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "report");
		assert.equal(result.results.length, 1);
		assert.equal(result.results[0]!.path, "src/hello.ts");
		assert.equal(result.usage.input, 31);
		assert.equal(result.usage.output, 14);
		assert.equal(result.turns, 2);
		assert.ok(result.turnHistory[0]!.calls.length >= 2);
		// last turn tools should be report-only when maxTurns hit — here turn 2 < 4 so all tools
		assert.ok(registry.calls[0]!.tools!.some((t) => t.name === "grep"));
	});

	it("nudge when no tool calls, then report", async () => {
		const registry = scriptedRegistry([
			assistant({ text: "I think it is somewhere", stopReason: "stop", usage: usage({ input: 5, output: 5 }) }),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [
							{ path: "src/hello.ts", startLine: 1, endLine: 2, reason: "ok" },
						],
					}),
				],
				usage: usage({ input: 5, output: 5 }),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ maxTurns: 3 }),
			query: "greet",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "report");
		assert.equal(result.turns, 2);
		// After nudge, messages should include the nudge user message before second call
		const secondCtx = registry.calls[1]!;
		const roles = secondCtx.messages.map((m) => m.role);
		assert.ok(roles.includes("user"));
		assert.ok(
			secondCtx.messages.some(
				(m) =>
					m.role === "user" &&
					typeof m.content === "string" &&
					m.content.includes("report"),
			),
		);
	});

	it("maxTurns without report → degraded from grep output", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("grep", { pattern: "greet", path: "src" })],
				usage: usage({ input: 1, output: 1 }),
			}),
			assistant({
				toolCalls: [toolCall("grep", { pattern: "greet", path: "src" })],
				usage: usage({ input: 1, output: 1 }),
			}),
			assistant({ text: "done", stopReason: "stop", usage: usage({ input: 1, output: 1 }) }),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ maxTurns: 2 }),
			query: "greet",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "degraded");
		assert.equal(result.truncated, true);
		assert.ok(result.warnings.some((w) => /maxTurns/i.test(w)));
		// Last turn should only expose report tool
		assert.equal(registry.calls.length, 3);
		for (const ctx of registry.calls.slice(1)) {
			assert.deepEqual(ctx.tools!.map((t) => t.name), ["report"]);
		}
		assert.ok(result.results.length > 0);
	});

	it("rescue turn: report after ignoring report-only final turn", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("grep", { pattern: "greet", path: "src" })],
				usage: usage({ input: 1, output: 1 }),
			}),
			assistant({
				toolCalls: [toolCall("read", { path: "src/hello.ts" })],
				usage: usage({ input: 1, output: 1 }),
			}),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [{ path: "src/hello.ts", startLine: 1, endLine: 2, reason: "ok" }],
					}),
				],
				usage: usage({ input: 1, output: 1 }),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ maxTurns: 2 }),
			query: "greet",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "report");
		assert.equal(result.turns, 3);
		assert.equal(result.results[0]!.path, "src/hello.ts");
		const rescue = registry.calls[2]!;
		assert.deepEqual(rescue.tools!.map((t) => t.name), ["report"]);
		assert.equal(rescue.messages.length, 1);
		const rescueMsg = rescue.messages[0]!;
		assert.equal(rescueMsg.role, "user");
		assert.ok(typeof rescueMsg.content === "string" && rescueMsg.content.includes("Query: greet"));
		assert.ok(rescueMsg.content.includes("--- grep output ---"));
		assert.ok(!rescueMsg.content.includes("No more searches allowed"));
	});

	it("skips calls beyond maxParallelCalls", async () => {
		const many = Array.from({ length: 5 }, (_, i) =>
			toolCall("grep", { pattern: `p${i}`, path: "src" }, `c${i}`),
		);
		const registry = scriptedRegistry([
			assistant({ toolCalls: many, usage: usage({ input: 2, output: 2 }) }),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [
							{ path: "src/hello.ts", startLine: 1, endLine: 1, reason: "x" },
						],
					}),
				],
				usage: usage({ input: 2, output: 2 }),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ maxParallelCalls: 2, maxTurns: 3 }),
			query: "parallel",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "report");
		const firstTurn = result.turnHistory[0]!;
		assert.equal(firstTurn.calls.length, 5);
		assert.equal(firstTurn.calls.filter((c) => c.skipped).length, 3);
		assert.equal(firstTurn.calls.filter((c) => !c.skipped).length, 2);
	});

	it("path jail: ../ and absolute path return error tool results, loop continues", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [
					toolCall("read", { path: "../outside-secret.txt" }, "escape1"),
					toolCall("read", { path: "/etc/passwd" }, "escape2"),
				],
				usage: usage({ input: 1, output: 1 }),
			}),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [
							{ path: "src/hello.ts", startLine: 1, endLine: 2, reason: "ok" },
						],
					}),
				],
				usage: usage({ input: 1, output: 1 }),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ maxTurns: 3 }),
			query: "secret",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "report");
		const toolResults = registry.calls[1]!.messages.filter((m) => m.role === "toolResult");
		assert.ok(toolResults.length >= 2);
		for (const tr of toolResults.slice(0, 2)) {
			assert.equal(tr.role, "toolResult");
			if (tr.role === "toolResult") {
				assert.equal(tr.isError, true);
				const text = tr.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("");
				assert.match(text, /out of scope|not found/i);
			}
		}
	});

	it("symlink escape is rejected by inner tools during loop", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("read", { path: "escape-link.txt" }, "sym")],
				usage: usage({ input: 1, output: 1 }),
			}),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [],
						notes: "blocked",
					}),
				],
				usage: usage({ input: 1, output: 1 }),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ maxTurns: 3 }),
			query: "escape",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "report");
		const tr = registry.calls[1]!.messages.find((m) => m.role === "toolResult");
		assert.ok(tr && tr.role === "toolResult");
		if (tr && tr.role === "toolResult") {
			assert.equal(tr.isError, true);
		}
	});

	it("abort via signal → cancelled", async () => {
		const ac = new AbortController();
		const registry: StreamSimpleRegistry = {
			streamSimple() {
				ac.abort();
				return {
					result: async () =>
						assistant({
							stopReason: "aborted",
							usage: usage({ input: 1, output: 0 }),
						}),
				} as ReturnType<StreamSimpleRegistry["streamSimple"]>;
			},
		};

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ timeoutMs: 60_000 }),
			query: "x",
			cwd: miniRepo,
			signal: ac.signal,
		});

		assert.equal(result.kind, "cancelled");
		assert.match(result.errorMessage ?? "", /Cancel/i);
	});

	it("timeout without grep hits → error with Timed out (PLAN §9)", async () => {
		const registry: StreamSimpleRegistry = {
			streamSimple(_m, _c, opts) {
				return {
					result: async () => {
						// Wait until the combined signal aborts (short timeoutMs)
						await new Promise<void>((resolve) => {
							const s = opts?.signal;
							if (!s || s.aborted) {
								resolve();
								return;
							}
							s.addEventListener("abort", () => resolve(), { once: true });
						});
						return assistant({
							stopReason: "aborted",
							usage: usage({ input: 0, output: 0 }),
						});
					},
				} as ReturnType<StreamSimpleRegistry["streamSimple"]>;
			},
		};

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ timeoutMs: 30 }),
			query: "x",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "error");
		assert.match(result.errorMessage ?? "", /Timed out/i);
	});

	it("timeout after grep hits → degraded with timeout note (PLAN §9)", async () => {
		let turn = 0;
		const registry: StreamSimpleRegistry = {
			streamSimple(_m, _c, opts) {
				turn += 1;
				const n = turn;
				return {
					result: async () => {
						if (n === 1) {
							return assistant({
								toolCalls: [toolCall("grep", { pattern: "greet", path: "src" })],
								usage: usage({ input: 5, output: 2 }),
							});
						}
						await new Promise<void>((resolve) => {
							const s = opts?.signal;
							if (!s || s.aborted) {
								resolve();
								return;
							}
							s.addEventListener("abort", () => resolve(), { once: true });
						});
						return assistant({
							stopReason: "aborted",
							usage: usage({ input: 1, output: 0 }),
						});
					},
				} as ReturnType<StreamSimpleRegistry["streamSimple"]>;
			},
		};

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig({ timeoutMs: 250, maxTurns: 4 }),
			query: "greet",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "degraded");
		assert.equal(result.truncated, true);
		assert.match(result.errorMessage ?? "", /Timed out/i);
		assert.ok(result.warnings.some((w) => /Timed out/i.test(w)));
		assert.ok(result.results.length >= 1);
	});

	it("usage accumulates across turns", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [toolCall("ls", { path: "." })],
				usage: usage({
					input: 100,
					output: 10,
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
				}),
			}),
			assistant({
				toolCalls: [
					toolCall("report", {
						results: [
							{ path: "src/hello.ts", startLine: 1, endLine: 1, reason: "r" },
						],
					}),
				],
				usage: usage({
					input: 50,
					output: 20,
					cost: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, total: 9 },
				}),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig(),
			query: "usage",
			cwd: miniRepo,
		});

		assert.equal(result.usage.input, 150);
		assert.equal(result.usage.output, 30);
		assert.equal(result.usage.cost.total, 12);
	});

	it("same-turn report with siblings ends without executing siblings", async () => {
		const registry = scriptedRegistry([
			assistant({
				toolCalls: [
					toolCall("grep", { pattern: "nope", path: "src" }, "g1"),
					toolCall(
						"report",
						{
							results: [
								{ path: "src/hello.ts", startLine: 1, endLine: 2, reason: "r" },
							],
						},
						"r1",
					),
				],
				usage: usage({ input: 3, output: 3 }),
			}),
		]);

		const result = await runSearchLoop({
			model: fakeModel(),
			modelRegistry: registry,
			config: baseConfig(),
			query: "same turn",
			cwd: miniRepo,
		});

		assert.equal(result.kind, "report");
		assert.equal(result.turns, 1);
		assert.equal(result.turnHistory[0]!.calls.length, 1);
		assert.equal(result.turnHistory[0]!.calls[0]!.name, "report");
	});

	it("omits reasoning when config is off or model.reasoning is false", async () => {
		let seenReasoning: string | undefined | null = null;
		const registry: StreamSimpleRegistry = {
			streamSimple(_m, _c, opts) {
				seenReasoning = opts?.reasoning;
				return {
					result: async () =>
						assistant({
							toolCalls: [
								toolCall("report", {
									results: [
										{ path: "src/hello.ts", startLine: 1, endLine: 1, reason: "r" },
									],
								}),
							],
						}),
				} as ReturnType<StreamSimpleRegistry["streamSimple"]>;
			},
		};

		await runSearchLoop({
			model: fakeModel({ reasoning: false }),
			modelRegistry: registry,
			config: baseConfig({ reasoning: "low" }),
			query: "r",
			cwd: miniRepo,
		});
		assert.equal(seenReasoning, undefined);

		seenReasoning = null;
		await runSearchLoop({
			model: fakeModel({ reasoning: true }),
			modelRegistry: registry,
			config: baseConfig({ reasoning: "off" }),
			query: "r",
			cwd: miniRepo,
		});
		assert.equal(seenReasoning, undefined);

		seenReasoning = null;
		await runSearchLoop({
			model: fakeModel({ reasoning: true }),
			modelRegistry: registry,
			config: baseConfig({ reasoning: "medium" }),
			query: "r",
			cwd: miniRepo,
		});
		assert.equal(seenReasoning, "medium");
	});
});
