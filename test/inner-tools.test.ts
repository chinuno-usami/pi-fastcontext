import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
	READ_DEFAULT_LIMIT,
	READ_MAX_LIMIT,
	checkPathUnderRoots,
	createInnerTools,
	createReportTool,
	isInsideRoot,
	resolveAllowedRoots,
} from "../src/inner-tools.ts";
import { buildSystemPrompt, listTopLevel } from "../src/prompt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures");
const miniRepo = join(fixtureRoot, "mini-repo");

describe("inner-tools path jail", () => {
	it("isInsideRoot accepts nested paths and rejects escapes", async () => {
		const root = await realpath(miniRepo);
		assert.equal(isInsideRoot(join(root, "src"), [root]), true);
		assert.equal(isInsideRoot(root, [root]), true);
		assert.equal(isInsideRoot(join(root, ".."), [root]), false);
		assert.equal(isInsideRoot("/tmp", [root]), false);
	});

	it("rejects ../ and absolute paths outside cwd", async () => {
		const roots = (await resolveAllowedRoots(miniRepo)).roots;
		const up = await checkPathUnderRoots("../outside-secret.txt", roots, { cwd: miniRepo });
		assert.equal(up.ok, false);
		const abs = await checkPathUnderRoots(join(fixtureRoot, "outside-secret.txt"), roots, {
			cwd: miniRepo,
		});
		assert.equal(abs.ok, false);
	});

	it("rejects symlink that escapes cwd", async () => {
		const roots = (await resolveAllowedRoots(miniRepo)).roots;
		const link = await checkPathUnderRoots("escape-link.txt", roots, {
			cwd: miniRepo,
			mustExist: true,
		});
		assert.equal(link.ok, false);
	});

	it("allows normal file under cwd", async () => {
		const roots = (await resolveAllowedRoots(miniRepo)).roots;
		const ok = await checkPathUnderRoots("src/hello.ts", roots, {
			cwd: miniRepo,
			mustExist: true,
		});
		assert.equal(ok.ok, true);
	});

	it("resolveAllowedRoots rejects paths outside cwd", async () => {
		const bad = await resolveAllowedRoots(miniRepo, ["../outside-secret.txt"]);
		assert.ok(bad.error);
		assert.equal(bad.roots.length, 0);
	});

	it("execute read clamps limit and returns file text", async () => {
		const tools = createInnerTools({ cwd: miniRepo, innerToolMaxBytes: 16_000 });
		const result = await tools.execute("read", "t1", {
			path: "src/hello.ts",
			limit: 9999,
		});
		assert.equal(result.isError, undefined);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		assert.match(text, /greet/);
	});

	it("execute read rejects escaped path without throwing", async () => {
		const tools = createInnerTools({ cwd: miniRepo, innerToolMaxBytes: 16_000 });
		const result = await tools.execute("read", "t2", { path: "../outside-secret.txt" });
		assert.equal(result.isError, true);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		assert.match(text, /out of scope/);
	});

	it("execute grep rejects symlink escape", async () => {
		const tools = createInnerTools({ cwd: miniRepo, innerToolMaxBytes: 16_000 });
		const result = await tools.execute("grep", "t3", {
			pattern: "secret",
			path: "escape-link.txt",
		});
		assert.equal(result.isError, true);
	});

	it("createReportTool exposes name and parameters", () => {
		const t = createReportTool();
		assert.equal(t.name, "report");
		assert.ok(t.parameters);
	});

	it("read limit constants match PLAN", () => {
		assert.equal(READ_DEFAULT_LIMIT, 200);
		assert.equal(READ_MAX_LIMIT, 400);
	});
});

describe("prompt", () => {
	it("buildSystemPrompt injects maxTurns, maxResults, cwd, paths", () => {
		const prompt = buildSystemPrompt({
			cwd: "/repo",
			paths: ["src", "pkg"],
			maxTurns: 4,
			maxResults: 12,
			topLevelListing: "src\nREADME.md",
		});
		assert.match(prompt, /code locator/i);
		assert.match(prompt, /4 turns/);
		assert.match(prompt, /12 results/);
		assert.match(prompt, /cwd: \/repo/);
		assert.match(prompt, /src, pkg/);
		assert.match(prompt, /README\.md/);
		assert.ok(prompt.length < 3500);
	});

	it("listTopLevel returns fixture entries", async () => {
		const listing = await listTopLevel(miniRepo);
		assert.match(listing, /README\.md/);
		assert.match(listing, /src/);
	});
});
