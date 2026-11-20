import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatEntry, formatFastContextContent, formatHeader } from "../src/format.ts";
import {
	buildSnippets,
	formatSnippetBody,
	isBinaryFile,
	mergeResultRanges,
	type SnippetEntry,
} from "../src/snippets.ts";

const fixturesRoot = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

describe("snippets merge", () => {
	it("merges overlapping ranges in the same file", () => {
		const merged = mergeResultRanges([
			{ path: "a.ts", startLine: 1, endLine: 5, reason: "first" },
			{ path: "a.ts", startLine: 4, endLine: 10, reason: "second" },
		]);
		assert.equal(merged.length, 1);
		assert.deepEqual(merged[0], {
			path: "a.ts",
			startLine: 1,
			endLine: 10,
			reason: "first",
		});
	});

	it("merges ranges at most 3 lines apart", () => {
		const merged = mergeResultRanges([
			{ path: "a.ts", startLine: 1, endLine: 10, reason: "a" },
			{ path: "a.ts", startLine: 14, endLine: 20, reason: "b" }, // gap 11,12,13 = 3
		]);
		assert.equal(merged.length, 1);
		assert.equal(merged[0]!.endLine, 20);
	});

	it("does not merge when gap is 4 lines", () => {
		const merged = mergeResultRanges([
			{ path: "a.ts", startLine: 1, endLine: 10, reason: "a" },
			{ path: "a.ts", startLine: 15, endLine: 20, reason: "b" }, // gap 11-14 = 4
		]);
		assert.equal(merged.length, 2);
	});

	it("preserves first-occurrence order across files", () => {
		const merged = mergeResultRanges([
			{ path: "b.ts", startLine: 1, endLine: 2, reason: "b" },
			{ path: "a.ts", startLine: 1, endLine: 2, reason: "a" },
			{ path: "b.ts", startLine: 3, endLine: 4, reason: "b2" },
		]);
		assert.equal(merged.length, 2);
		assert.equal(merged[0]!.path, "b.ts");
		assert.equal(merged[0]!.endLine, 4);
		assert.equal(merged[1]!.path, "a.ts");
	});
});

describe("snippets body", () => {
	it("prefixes line numbers and truncates long ranges", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
		const { body, linesTruncated, rangeLineCount } = formatSnippetBody({
			lines,
			startLine: 1,
			endLine: 50,
			maxLinesPerSnippet: 5,
		});
		assert.equal(linesTruncated, true);
		assert.equal(rangeLineCount, 50);
		assert.match(body, /^ *1\|line-1/m);
		assert.match(body, /共 50 行/);
		assert.match(body, /offset=1 limit=50/);
		const bodyLines = body.split("\n");
		assert.equal(bodyLines.length, 6); // 5 content + annotation
	});
});

describe("snippets build", () => {
	it("reads fixture file and includes numbered snippet", async () => {
		const { entries, truncated } = await buildSnippets({
			cwd: fixturesRoot,
			results: [
				{
					path: "src/hello.ts",
					startLine: 1,
					endLine: 3,
					reason: "greet helper",
				},
			],
			maxLinesPerSnippet: DEFAULT_CONFIG.maxLinesPerSnippet,
			maxOutputBytes: DEFAULT_CONFIG.maxOutputBytes,
			query: "where is greet",
		});
		assert.equal(truncated, false);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.path, "src/hello.ts");
		assert.ok(entries[0]!.snippet?.includes("greet"));
		assert.match(entries[0]!.snippet!, /1\|/);
	});

	it("skips binary files (NUL in first 8KB)", async () => {
		const dir = join(fixturesRoot, ".tmp-bin");
		await mkdir(dir, { recursive: true });
		const binPath = join(dir, "blob.bin");
		const buf = Buffer.alloc(100);
		buf[50] = 0;
		buf.write("hello", 0);
		await writeFile(binPath, buf);

		assert.equal(await isBinaryFile(binPath), true);

		const { entries } = await buildSnippets({
			cwd: fixturesRoot,
			results: [
				{ path: ".tmp-bin/blob.bin", startLine: 1, endLine: 1, reason: "bin" },
			],
			maxLinesPerSnippet: 40,
			maxOutputBytes: 12_000,
			query: "bin",
		});
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.binarySkipped, true);
		assert.equal(entries[0]!.snippet, undefined);
	});

	it("enforces maxOutputBytes by dropping later snippets", async () => {
		const spread = [
			{ path: "src/hello.ts", startLine: 1, endLine: 1, reason: "a" },
			{ path: "README.md", startLine: 1, endLine: 1, reason: "b" },
			{ path: "src/hello.ts", startLine: 3, endLine: 3, reason: "c" },
		];
		const { entries, truncated } = await buildSnippets({
			cwd: fixturesRoot,
			results: spread,
			maxLinesPerSnippet: 40,
			maxOutputBytes: 180,
			query: "tiny-budget-query-that-uses-some-header-bytes",
		});
		assert.equal(truncated, true);
		assert.ok(entries.some((e) => e.omittedForBudget === true));
		assert.ok(entries.every((e) => e.path === "src/hello.ts" || e.path === "README.md"));
	});
});

describe("format", () => {
	it("formats header and entries with fences", () => {
		const entries: SnippetEntry[] = [
			{
				path: "src/hello.ts",
				startLine: 1,
				endLine: 2,
				reason: "greet",
				snippet: "1|export function greet",
			},
			{
				path: "README.md",
				startLine: 1,
				endLine: 1,
				reason: "docs",
				omittedForBudget: true,
			},
		];
		const text = formatFastContextContent({
			query: "where is greet",
			entries,
			notes: "ok",
		});
		assert.equal(formatHeader("where is greet", 2), 'fast_context: 2 results for "where is greet"');
		assert.match(text, /^fast_context: 2 results for "where is greet"/);
		assert.match(text, /1\. src\/hello\.ts:1-2 {2}— greet/);
		assert.match(text, /```ts/);
		assert.match(text, /2\. README\.md:1-1 {2}— docs/);
		assert.doesNotMatch(formatEntry(2, entries[1]!), /```/);
		assert.match(text, /notes: ok/);
	});
});
