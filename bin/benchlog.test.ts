/**
 * Contracts for the BenchLog launcher:
 * - `--fixture` is consumed by BenchLog and is not forwarded (published omp
 *   18.10.1 rejects that flag)
 * - a working directory without `.omp/tools/serial` gets `--extension`
 *   pointed at this package's benchlog-ext
 * - the extension entry exports the serial tools
 * - `benchlog --fixture --version` exits 0 against the installed harness
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverCustomToolPaths } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import factory from "../benchlog-ext/tools/serial/index.ts";
import { prepareLaunch, wantsBenchlogHelp, wantsBenchlogVersion } from "./benchlog.js";

const repoRoot = path.resolve(import.meta.dir, "..");
const extensionIndex = path.join(repoRoot, "benchlog-ext", "tools", "serial", "index.ts");

afterEach(() => {
	clearOmpExtensionCliRoots();
});

describe("prepareLaunch", () => {
	it("strips --fixture so the published harness does not reject the session", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "benchlog-cwd-"));
		const launch = prepareLaunch({
			argv: ["--fixture", "--version"],
			cwd,
			pkgRoot: repoRoot,
		});
		expect(launch.fixture).toBe(true);
		expect(launch.args).toEqual(["--extension", path.join(repoRoot, "benchlog-ext"), "--version"]);
		expect(launch.args).not.toContain("--fixture");
	});

	it("does not inject benchlog-ext when the working directory already has the serial tool", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "benchlog-project-"));
		await mkdir(path.join(cwd, ".omp", "tools", "serial"), { recursive: true });
		await writeFile(path.join(cwd, ".omp", "tools", "serial", "index.ts"), "export default () => [];\n");
		const launch = prepareLaunch({
			argv: ["--help"],
			cwd,
			pkgRoot: repoRoot,
		});
		expect(launch.useProjectSerial).toBe(true);
		expect(launch.args).toEqual(["--help"]);
	});

	it("treats -v and -h as version and help", () => {
		expect(wantsBenchlogVersion(["-v"])).toBe(true);
		expect(wantsBenchlogHelp(["-h"])).toBe(true);
		expect(wantsBenchlogVersion(["--print"])).toBe(false);
	});
});

describe("serial extension entry", () => {
	it("exports the serial tools the harness loads from benchlog-ext", () => {
		const tools = factory({ zod });
		const names = tools.map(tool => tool.name).sort();
		expect(names).toEqual(["serial_list", "serial_open", "serial_probe", "serial_read", "serial_write"]);
	});

	it("is discovered as a custom tool outside the BenchLog checkout", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "benchlog-discover-"));
		injectOmpExtensionCliRoots([path.join(repoRoot, "benchlog-ext")], os.homedir(), cwd);
		const paths = await discoverCustomToolPaths([], cwd);
		const discovered = paths.map(entry => path.resolve(entry.path));
		expect(discovered).toContain(path.resolve(extensionIndex));
	});
});

describe("benchlog CLI", () => {
	it("starts the harness with --fixture without an unrecognized-flag error", async () => {
		const proc = Bun.spawn([process.execPath, path.join(repoRoot, "bin", "benchlog.js"), "--fixture", "--version"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, status] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(status).toBe(0);
		expect(stdout).toContain("benchlog ");
		expect(stdout).toMatch(/\d+\.\d+\.\d+/);
		expect(stderr.toLowerCase()).not.toContain("unrecognized");
		expect(stderr.toLowerCase()).not.toContain("unknown flag");
	}, 120_000);
});
