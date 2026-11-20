import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	appendNudgeTip,
	formatCost,
	formatDuration,
	isBroadBashCommand,
	isBroadSearchToolResult,
	NUDGE_TIP,
	rangeLabel,
	renderCall,
	renderResult,
	truncateQuery,
} from "../src/render.ts";

/** Minimal Theme stand-in: return text unchanged (print/json-safe path). */
function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

describe("render helpers", () => {
	it("truncateQuery clips at 80 chars", () => {
		assert.equal(truncateQuery("short"), "short");
		assert.equal(truncateQuery("x".repeat(80)).length, 80);
		assert.equal(truncateQuery("x".repeat(100)).length, 80);
	});

	it("formatCost / formatDuration", () => {
		assert.equal(formatCost(0), "$0");
		assert.equal(formatCost(0.0012), "$0.0012");
		assert.equal(formatCost(1.5), "$1.50");
		assert.equal(formatDuration(1800), "1.8s");
		assert.equal(formatDuration(15_000), "15s");
	});

	it("rangeLabel", () => {
		assert.equal(rangeLabel({ path: "a.ts", startLine: 1, endLine: 3 }), "a.ts:1-3");
	});

	it("isBroadBashCommand matches PLAN prefixes", () => {
		assert.equal(isBroadBashCommand("rg foo"), true);
		assert.equal(isBroadBashCommand("grep -r foo ."), true);
		assert.equal(isBroadBashCommand("find . -name '*.ts'"), true);
		assert.equal(isBroadBashCommand("echo hi"), false);
		assert.equal(isBroadBashCommand("grep foo"), false);
	});

	it("isBroadSearchToolResult for grep/find/bash", () => {
		assert.equal(isBroadSearchToolResult("grep", {}), true);
		assert.equal(isBroadSearchToolResult("find", {}), true);
		assert.equal(isBroadSearchToolResult("bash", { command: "rg x" }), true);
		assert.equal(isBroadSearchToolResult("bash", { command: "ls" }), false);
		assert.equal(isBroadSearchToolResult("read", {}), false);
	});
});

describe("renderCall / renderResult", () => {
	const theme = fakeTheme();

	it("renderCall includes query preview and paths", () => {
		const c = renderCall({ query: "where is X", paths: ["src"] }, theme);
		const lines = c.render(120);
		const joined = lines.join("\n");
		assert.match(joined, /fast_context/);
		assert.match(joined, /where is X/);
		assert.match(joined, /paths=src/);
	});

	it("renderResult partial shows turn/searches/model", () => {
		const c = renderResult(
			{
				content: [{ type: "text", text: "…" }],
				details: { model: "openai/gpt", turns: 2, maxTurns: 4, searches: 7 },
			},
			{ expanded: false, isPartial: true },
			theme,
		);
		const joined = c.render(120).join("\n");
		assert.match(joined, /turn 2\/4/);
		assert.match(joined, /7 searches/);
		assert.match(joined, /openai\/gpt/);
	});

	it("renderResult collapsed shows summary and first 3 ranges", () => {
		const items = [
			{ path: "a.ts", startLine: 1, endLine: 2, reason: "r1" },
			{ path: "b.ts", startLine: 3, endLine: 4, reason: "r2" },
			{ path: "c.ts", startLine: 5, endLine: 6, reason: "r3" },
			{ path: "d.ts", startLine: 7, endLine: 8, reason: "r4" },
		];
		const c = renderResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					model: "p/m",
					turns: 1,
					searches: 2,
					usage: { cost: { total: 0.001 } },
					durationMs: 1800,
				},
				structuredContent: { results: items, truncated: false },
			},
			{ expanded: false, isPartial: false },
			theme,
		);
		const joined = c.render(120).join("\n");
		assert.match(joined, /4 results/);
		assert.match(joined, /1 turns/);
		assert.match(joined, /\$0\.0010/);
		assert.match(joined, /1\.8s/);
		assert.match(joined, /a\.ts:1-2/);
		assert.match(joined, /\+1 more/);
		assert.doesNotMatch(joined, /d\.ts:7-8/);
	});

	it("renderResult expanded lists reasons and turn history", () => {
		const c = renderResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					model: "p/m",
					turns: 1,
					searches: 1,
					durationMs: 500,
					usage: { cost: { total: 0 } },
					turnHistory: [
						{
							turn: 1,
							calls: [
								{ name: "grep", arguments: { pattern: "foo" } },
								{ name: "report", arguments: { results: [{}] } },
							],
						},
					],
				},
				structuredContent: {
					results: [{ path: "a.ts", startLine: 1, endLine: 2, reason: "hit" }],
					truncated: false,
				},
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const joined = c.render(120).join("\n");
		assert.match(joined, /a\.ts:1-2/);
		assert.match(joined, /hit/);
		assert.match(joined, /turn 1/);
		assert.match(joined, /grep/);
		assert.match(joined, /report/);
	});

	it("renderResult error shows first line in error style", () => {
		const c = renderResult(
			{
				content: [{ type: "text", text: "fast_context: Cancelled.\nmore" }],
				details: { kind: "cancelled" },
				isError: true,
			},
			{ expanded: false, isPartial: false },
			theme,
		);
		const joined = c.render(120).join("\n");
		assert.match(joined, /Cancelled/);
		assert.doesNotMatch(joined, /more/);
	});
});

describe("appendNudgeTip", () => {
	it("appends tip and keeps details + structuredContent", () => {
		const details = { exitCode: 0 };
		const structured = { matches: 1 };
		const out = appendNudgeTip({
			content: [{ type: "text", text: "found" }],
			details,
			structuredContent: structured,
		});
		assert.equal(out.details, details);
		assert.deepEqual(out.structuredContent, structured);
		assert.equal(out.content?.length, 2);
		const tip = out.content?.[1];
		assert.ok(tip && tip.type === "text");
		assert.match((tip as { text: string }).text, new RegExp(NUDGE_TIP));
	});
});
