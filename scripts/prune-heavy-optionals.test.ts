/**
 * The postinstall prune removes BenchLog's unused UI/ONNX trees and leaves a
 * project dependency in place. If this regresses, `npm install benchlog`
 * inside a React app deletes that app's react, or a BenchLog install keeps
 * the lucide-react tree the size budget excludes.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { pruneHeavyOptionals } from "./prune-heavy-optionals.js";

async function writeJson(file: string, value: unknown) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(value));
}

describe("pruneHeavyOptionals", () => {
	it("removes hoisted lucide-react from a BenchLog install that does not depend on it", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "benchlog-prune-"));
		await writeJson(path.join(root, "package.json"), {
			name: "benchlog",
			dependencies: { "@oh-my-pi/pi-coding-agent": "18.10.1" },
		});
		await writeJson(path.join(root, "node_modules", "lucide-react", "package.json"), {
			name: "lucide-react",
			version: "1.0.0",
		});
		await writeJson(path.join(root, "node_modules", "@oh-my-pi", "omp-stats", "package.json"), {
			name: "@oh-my-pi/omp-stats",
			dependencies: { "lucide-react": "^1.0.0" },
		});
		const removed = await pruneHeavyOptionals(root);
		expect(removed.some(dir => dir.endsWith(`${path.sep}lucide-react`))).toBe(true);
		expect(await Bun.file(path.join(root, "node_modules", "lucide-react", "package.json")).exists()).toBe(false);
	});

	it("keeps react when the top-level project depends on it", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "benchlog-prune-app-"));
		await writeJson(path.join(root, "package.json"), {
			name: "board-ui",
			dependencies: { benchlog: "0.1.0", react: "^19.0.0" },
		});
		await writeJson(path.join(root, "node_modules", "react", "package.json"), {
			name: "react",
			version: "19.0.0",
		});
		const removed = await pruneHeavyOptionals(root);
		expect(removed).toEqual([]);
		expect(await Bun.file(path.join(root, "node_modules", "react", "package.json")).exists()).toBe(true);
	});
});
