#!/usr/bin/env bun
/**
 * BenchLog CLI. Starts the published oh-my-pi coding agent with this
 * package's serial tools. Does not require a separate global `omp` install.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);

export function packageRoot() {
	return pkgRoot;
}

/**
 * Arguments forwarded to the oh-my-pi CLI, plus BenchLog-only startup state.
 * `--fixture` is not an upstream flag in the published 18.10.1 harness.
 */
export function prepareLaunch(options) {
	const argv = options.argv;
	const cwd = options.cwd;
	const root = options.pkgRoot;
	const forwarded = [];
	let fixture = false;
	for (const arg of argv) {
		if (arg === "--fixture") {
			fixture = true;
			continue;
		}
		forwarded.push(arg);
	}
	const projectTool = path.join(cwd, ".omp", "tools", "serial", "index.ts");
	const useProjectSerial = existsSync(projectTool);
	const args = [];
	if (!useProjectSerial) {
		args.push("--extension", path.join(root, "benchlog-ext"));
	}
	args.push(...forwarded);
	return { args, fixture, useProjectSerial };
}

export function wantsBenchlogHelp(args) {
	return args.includes("--help") || args.includes("-h");
}

export function wantsBenchlogVersion(args) {
	return args.includes("--version") || args.includes("-v");
}

function bunExecutable() {
	if (path.basename(process.execPath) === "bun") return process.execPath;
	return "bun";
}

function codingAgentCli() {
	const manifest = require.resolve("@oh-my-pi/pi-coding-agent/package.json");
	return path.join(path.dirname(manifest), "src", "cli.ts");
}

function benchlogVersion() {
	const manifest = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
	return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

const HELP_TRAILER = `BenchLog
  --fixture
      Set BENCHLOG_SERIAL_FIXTURE=1 so serial_open defaults to fixture://firmware-boot.
      This flag is not forwarded to the oh-my-pi harness.
  Startup
      The interactive screen is BenchLog (板端串口观测与诊断 Agent) on the published
      oh-my-pi harness. This session does not prompt to run omp update.
  Serial tools
      ./.omp/tools/serial when that directory exists in the working directory.
      Otherwise the installed copy is loaded with --extension <benchlog>/benchlog-ext.
`;

export function brandPreloadPath() {
	return path.join(here, "benchlog-brand.ts");
}

export function startupConfigPath() {
	return path.join(here, "benchlog-startup.yml");
}

/** Bun argv that runs the harness with the BenchLog face and without the omp update nag. */
export function benchlogChildArgs(cliPath, launchArgs) {
	return ["--preload", brandPreloadPath(), cliPath, "--config", startupConfigPath(), ...launchArgs];
}

function isDirectRun() {
	const argv1 = process.argv[1];
	if (!argv1) return false;
	try {
		return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
	const launch = prepareLaunch({ argv, cwd, pkgRoot });
	if (wantsBenchlogVersion(launch.args)) {
		process.stdout.write(`benchlog ${benchlogVersion()}\n`);
	}
	let cli;
	try {
		cli = codingAgentCli();
	} catch {
		process.stderr.write(
			"benchlog: @oh-my-pi/pi-coding-agent is not installed. From this package run `bun install`.\n",
		);
		process.exit(1);
	}
	const env = { ...process.env, BENCHLOG_BRAND: "1" };
	if (launch.fixture) env.BENCHLOG_SERIAL_FIXTURE = "1";
	const child = spawn(bunExecutable(), benchlogChildArgs(cli, launch.args), {
		stdio: "inherit",
		env,
		cwd,
	});
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (status, signal) => {
			if (signal) {
				process.kill(process.pid, signal);
				resolve(1);
				return;
			}
			resolve(status ?? 1);
		});
	}).catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`benchlog: failed to start bun (${message}). Install Bun >= 1.3.14.\n`);
		process.exit(1);
	});
	if (code === 0 && wantsBenchlogHelp(launch.args)) {
		process.stdout.write(`\n${HELP_TRAILER}`);
	}
	process.exit(code);
}

if (isDirectRun()) {
	await main();
}
