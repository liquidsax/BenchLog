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
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStartupCheckUpdate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	benchlogChildArgs,
	prepareLaunch,
	startupConfigPath,
	wantsBenchlogHelp,
	wantsBenchlogVersion,
} from "./benchlog.js";
import { renderBenchlogWelcome, rewriteHarnessFaceSource } from "./benchlog-brand.ts";

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

const OMP_WORDMARK = "▄▀▀▄";
const OMP_BLOCK_ROW = "████████████";
const OMP_SETUP_WORDMARK = "O h   M y   P i";

function visible(lines: readonly string[]): string {
	return lines.map(line => Bun.stripANSI(line)).join("\n");
}

describe("BenchLog startup face", () => {
	it("draws a BenchLog mark instead of the omp lockup, and drops lines that do not fit", () => {
		const wide = visible(renderBenchlogWelcome(80, "0.1.0"));
		expect(wide).toContain("BenchLog");
		expect(wide).toContain("板端串口观测与诊断 Agent");
		expect(wide).toContain("v0.1.0");
		expect(wide).not.toContain(OMP_WORDMARK);
		expect(wide).not.toContain(OMP_BLOCK_ROW);
		const borders = wide
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.includes("╔") || line.includes("║") || line.includes("╚"));
		const widths = borders.map(line => Bun.stringWidth(line));
		expect(widths.length).toBe(4);
		expect(new Set(widths).size).toBe(1);

		const narrow = visible(renderBenchlogWelcome(20, "0.1.0"));
		expect(narrow).toContain("BenchLog");
		expect(narrow).not.toContain("╔");
		expect(narrow).not.toContain("板端串口观测与诊断 Agent");
		expect(visible(renderBenchlogWelcome(4, "0.1.0"))).toBe("");
	});

	it("refuses a setup splash whose harness shape no longer matches", () => {
		expect(() => rewriteHarnessFaceSource("/pi-tui/src/setup/scenes/splash.ts", "export const moved = true;\n")).toThrow(
			/setup splash/,
		);
	});

	it("passes the face preload and disables the omp update check", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "benchlog-launch-"));
		const launch = prepareLaunch({ argv: ["--fixture", "--version"], cwd, pkgRoot: repoRoot });
		const args = benchlogChildArgs("/opt/harness/cli.ts", launch.args);
		expect(args.slice(0, 2)).toEqual(["--preload", path.join(repoRoot, "bin", "benchlog-brand.ts")]);
		expect(args).toContain("--config");
		expect(args).toContain(startupConfigPath());
		expect(args.at(-1)).toBe("--version");
		expect(args).not.toContain("--fixture");
		const published = (await Bun.file(path.join(repoRoot, "package.json")).json()) as { files?: string[] };
		expect(published.files).toContain("bin/benchlog-brand.ts");
		expect(published.files).toContain("bin/benchlog-startup.yml");

		const settings = await Settings.loadIsolated({
			inMemory: true,
			cwd,
			configFiles: [startupConfigPath()],
		});
		expect(cfgStartupCheckUpdate.get(settings)).toBe(false);
	});

	it("replaces the harness welcome, splash, and setup header when the preload is active", async () => {
		const proc = Bun.spawn([process.execPath, "--preload", path.join(repoRoot, "bin", "benchlog-brand.ts"), "-e", PROBE], {
			cwd: repoRoot,
			env: { ...process.env, BENCHLOG_BRAND: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, status] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(stderr).toBe("");
		expect(status).toBe(0);
		const report = JSON.parse(stdout) as {
			welcomeText: string;
			welcomeDescribe: string;
			splashText: string;
			splashDescribe: string;
			outroText: string;
			sceneText: string;
		};
		for (const text of [report.welcomeText, report.splashText, report.outroText, report.sceneText]) {
			expect(text).toContain("BenchLog");
			expect(text).toContain("板端串口观测与诊断 Agent");
			expect(text).not.toContain(OMP_WORDMARK);
			expect(text).not.toContain(OMP_BLOCK_ROW);
			expect(text).not.toContain(OMP_SETUP_WORDMARK);
			expect(text).not.toContain("18.10.1");
			expect(text).not.toContain("omp update");
		}
		expect(report.welcomeText).toContain("v0.1.0");
		expect(report.splashText).toContain("press enter to skip");
		expect(report.outroText).toContain("Setup saved");
		expect(report.sceneText).toContain("PROBE_BODY");
		expect(report.sceneText).toContain("Setup step 1 of 1");
		expect(report.welcomeDescribe).toContain("BenchLog");
		expect(report.welcomeDescribe).not.toContain('"builtin":"omp"');
		expect(report.splashDescribe).not.toContain('"builtin":"omp"');
	}, 60_000);
});

const PROBE = `
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";
import { WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { describeSetupSplash, renderSetupSplash } from "@oh-my-pi/pi-tui/setup/scenes/splash";
import { renderSetupOutro } from "@oh-my-pi/pi-tui/setup/scenes/outro";
import { SetupWizardComponent } from "@oh-my-pi/pi-tui/setup/wizard-overlay";

initThemeSync();
const strip = (lines) => lines.map((line) => Bun.stripANSI(line)).join("\\n");
const welcome = new WelcomeComponent("18.10.1");
const welcomeText = strip(welcome.render(100));
const welcomeDescribe = JSON.stringify(welcome.describe({}));
const splashText = strip(renderSetupSplash(80, 24, 0));
const splashDescribe = JSON.stringify(describeSetupSplash());
const outroText = strip(renderSetupOutro(80, 24, 0));
const ui = { terminal: { rows: 30 }, requestRender() {}, setFocus() {} };
const wizard = new SetupWizardComponent({ ui }, [{
  id: "probe",
  title: "Probe",
  minVersion: 0,
  mount() {
    return { title: "Probe", render() { return ["PROBE_BODY"]; } };
  },
}]);
wizard.handleInput("\\r");
await Bun.sleep(500);
const sceneText = strip(wizard.render(80));
wizard.dispose();
process.stdout.write(JSON.stringify({ welcomeText, welcomeDescribe, splashText, splashDescribe, outroText, sceneText }));
`;

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

	it("starts from a directory that is not the BenchLog checkout", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "benchlog-away-"));
		const proc = Bun.spawn([process.execPath, path.join(repoRoot, "bin", "benchlog.js"), "--version"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, status] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(status).toBe(0);
		expect(stdout).toContain("benchlog 0.1.0");
		expect(stderr.toLowerCase()).not.toContain("failed to load");
		expect(stderr.toLowerCase()).not.toContain("unrecognized");
	}, 120_000);
});
