import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	loadConfig,
	mergeConfig,
	saveConfig,
} from "../src/config.ts";

describe("config", () => {
	it("mergeConfig applies defaults when overlays are empty", () => {
		const { config, hadInvalid } = mergeConfig();
		assert.deepEqual(config, DEFAULT_CONFIG);
		assert.equal(hadInvalid, false);
		assert.equal(config.model, undefined);
	});

	it("mergeConfig: later overlay overrides earlier; project wins over global", () => {
		const { config, hadInvalid } = mergeConfig(
			{ model: "openai/gpt-4o-mini", maxTurns: 2 },
			{ model: "anthropic/claude-haiku", maxResults: 5 },
		);
		assert.equal(hadInvalid, false);
		assert.equal(config.model, "anthropic/claude-haiku");
		assert.equal(config.maxTurns, 2);
		assert.equal(config.maxResults, 5);
		assert.equal(config.reasoning, "low");
	});

	it("mergeConfig: illegal values fall back to defaults", () => {
		const { config, hadInvalid, invalidKeys } = mergeConfig({
			reasoning: "nope" as "low",
			maxTurns: 0,
			maxParallelCalls: -1,
			maxResults: 1.5 as unknown as number,
			maxOutputBytes: -10,
			maxLinesPerSnippet: "many" as unknown as number,
			innerToolMaxBytes: Number.NaN,
			timeoutMs: 0,
			nudgeBroadSearch: "yes" as unknown as boolean,
			model: "   ",
		});
		assert.equal(hadInvalid, true);
		assert.ok(invalidKeys.includes("reasoning"));
		assert.ok(invalidKeys.includes("maxTurns"));
		assert.ok(invalidKeys.includes("nudgeBroadSearch"));
		assert.ok(invalidKeys.includes("model"));
		assert.equal(config.reasoning, DEFAULT_CONFIG.reasoning);
		assert.equal(config.maxTurns, DEFAULT_CONFIG.maxTurns);
		assert.equal(config.maxParallelCalls, DEFAULT_CONFIG.maxParallelCalls);
		assert.equal(config.maxResults, DEFAULT_CONFIG.maxResults);
		assert.equal(config.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes);
		assert.equal(config.maxLinesPerSnippet, DEFAULT_CONFIG.maxLinesPerSnippet);
		assert.equal(config.innerToolMaxBytes, DEFAULT_CONFIG.innerToolMaxBytes);
		assert.equal(config.timeoutMs, DEFAULT_CONFIG.timeoutMs);
		assert.equal(config.nudgeBroadSearch, DEFAULT_CONFIG.nudgeBroadSearch);
		assert.equal(config.model, undefined);
	});

	it("loadConfig: untrusted project does not read project config", async () => {
		const root = await mkdtemp(join(tmpdir(), "fc-cfg-"));
		const globalPath = join(root, "global-fastcontext.json");
		const projectDir = join(root, "proj");
		await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(
			globalPath,
			JSON.stringify({ model: "global/model", maxTurns: 3 }),
			"utf8",
		);
		await writeFile(
			join(projectDir, CONFIG_DIR_NAME, "fastcontext.json"),
			JSON.stringify({ model: "project/model", maxTurns: 9 }),
			"utf8",
		);

		const notifications: string[] = [];
		const { config, projectRead } = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: false,
			globalPath,
			notify: (msg) => notifications.push(msg),
		});

		assert.equal(projectRead, false);
		assert.equal(config.model, "global/model");
		assert.equal(config.maxTurns, 3);
		assert.equal(notifications.length, 0);
	});

	it("loadConfig: trusted project overrides global; notify once on invalid", async () => {
		const root = await mkdtemp(join(tmpdir(), "fc-cfg-"));
		const globalPath = join(root, "global-fastcontext.json");
		const projectDir = join(root, "proj");
		await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(
			globalPath,
			JSON.stringify({ model: "global/model", maxTurns: 3, reasoning: "high" }),
			"utf8",
		);
		await writeFile(
			join(projectDir, CONFIG_DIR_NAME, "fastcontext.json"),
			JSON.stringify({
				model: "project/model",
				maxTurns: -5,
				nudgeBroadSearch: true,
			}),
			"utf8",
		);

		const notifications: Array<{ msg: string; level?: string }> = [];
		const { config, projectRead } = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: true,
			globalPath,
			notify: (msg, level) => notifications.push({ msg, level }),
		});

		assert.equal(projectRead, true);
		assert.equal(config.model, "project/model");
		assert.equal(config.maxTurns, DEFAULT_CONFIG.maxTurns); // invalid → default
		assert.equal(config.reasoning, "high"); // from global
		assert.equal(config.nudgeBroadSearch, true);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "warning");
		assert.match(notifications[0]?.msg ?? "", /maxTurns/);
	});

	it("saveConfig writes global and project scopes", async () => {
		const root = await mkdtemp(join(tmpdir(), "fc-cfg-"));
		const globalPath = join(root, "agent", "fastcontext.json");
		const projectDir = join(root, "proj");

		await saveConfig(
			{ model: "openai/mini" },
			{ scope: "global", globalPath },
		);
		const loadedGlobal = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: false,
			globalPath,
		});
		assert.equal(loadedGlobal.config.model, "openai/mini");

		await saveConfig(
			{ model: "anthropic/haiku", maxResults: 7 },
			{ scope: "project", cwd: projectDir },
		);
		const loadedProject = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: true,
			globalPath,
		});
		assert.equal(loadedProject.config.model, "anthropic/haiku");
		assert.equal(loadedProject.config.maxResults, 7);

		await saveConfig(
			{},
			{ scope: "project", cwd: projectDir, clearModel: true },
		);
		const cleared = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: true,
			globalPath,
		});
		assert.equal(cleared.config.model, "openai/mini"); // falls back to global
		assert.equal(cleared.config.maxResults, 7);
	});
});
