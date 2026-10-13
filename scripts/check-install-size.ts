#!/usr/bin/env bun
/**
 * Fail when a clean BenchLog install's node_modules exceeds 500 MiB.
 *
 * Measures a fresh `bun install` of this package (root manifest, overrides,
 * hoisted linker), not an existing checkout's node_modules, unless `--self`
 * is passed. On Linux the total is `du -s -B1` (allocated bytes). `du -sb`
 * is apparent size and under-counts block slack. The per-package list is a
 * walk that skips symlinks. macOS `du` may not support `-B1`; the script then
 * sums file lengths instead.
 *
 * Platform: `@oh-my-pi/pi-natives` installs only the host OS/CPU leaf. The
 * 500 MiB budget is the linux x64 target. Other platforms differ. macOS `du`
 * block sizes are not used; this script sums file byte lengths.
 */
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEAVY_PACKAGES, OMIT_MARKER } from "./heavy-optionals.js";

const LIMIT_BYTES = 500 * 1024 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface FoundPackage {
	name: string;
	dir: string;
	stub: boolean;
}

function formatMiB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function gnuDuBytes(dir: string): Promise<number | null> {
	const result = spawnSync("du", ["-s", "-B1", dir], { encoding: "utf8" });
	if (result.status !== 0 || !result.stdout) return null;
	const bytes = Number(result.stdout.trim().split(/\s+/)[0]);
	return Number.isFinite(bytes) ? bytes : null;
}

async function directoryBytes(dir: string): Promise<number> {
	let total = 0;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const child = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			total += await directoryBytes(child);
			continue;
		}
		try {
			const stat = await lstat(child);
			if (stat.isFile()) total += stat.size;
		} catch {
			// vanished during scan
		}
	}
	return total;
}

async function readManifest(dir: string): Promise<{ name?: string; description?: string } | null> {
	try {
		return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
	} catch {
		return null;
	}
}

function isStub(manifest: { name?: string; description?: string }): boolean {
	if (manifest.name === "benchlog-omitted-optional") return true;
	return typeof manifest.description === "string" && manifest.description.includes(OMIT_MARKER);
}

async function findNamedPackages(nodeModules: string, depth: number, found: FoundPackage[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(nodeModules, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
		const dir = path.join(nodeModules, entry.name);
		if (entry.name.startsWith("@")) {
			let scoped;
			try {
				scoped = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const child of scoped) {
				if (!child.isDirectory() || child.isSymbolicLink()) continue;
				const childDir = path.join(dir, child.name);
				const manifest = await readManifest(childDir);
				if (manifest?.name) found.push({ name: manifest.name, dir: childDir, stub: isStub(manifest) });
				if (depth > 0) await findNamedPackages(path.join(childDir, "node_modules"), depth - 1, found);
			}
		} else {
			const manifest = await readManifest(dir);
			if (manifest?.name) found.push({ name: manifest.name, dir, stub: isStub(manifest) });
			if (depth > 0) await findNamedPackages(path.join(dir, "node_modules"), depth - 1, found);
		}
	}
}

async function topLevelSizes(nodeModules: string): Promise<Array<{ name: string; bytes: number }>> {
	let entries;
	try {
		entries = await readdir(nodeModules, { withFileTypes: true });
	} catch {
		return [];
	}
	const sizes: Array<{ name: string; bytes: number }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const dir = path.join(nodeModules, entry.name);
		if (entry.name.startsWith("@")) {
			let scoped;
			try {
				scoped = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const child of scoped) {
				if (!child.isDirectory() || child.isSymbolicLink()) continue;
				const childDir = path.join(dir, child.name);
				sizes.push({ name: `${entry.name}/${child.name}`, bytes: await directoryBytes(childDir) });
			}
		} else {
			sizes.push({ name: entry.name, bytes: await directoryBytes(dir) });
		}
	}
	sizes.sort((a, b) => b.bytes - a.bytes);
	return sizes;
}

async function copyInstallInputs(destination: string): Promise<void> {
	await mkdir(path.join(destination, "scripts"), { recursive: true });
	await cp(path.join(repoRoot, "package.json"), path.join(destination, "package.json"));
	await cp(path.join(repoRoot, "bunfig.toml"), path.join(destination, "bunfig.toml"));
	await cp(path.join(repoRoot, "bun.lock"), path.join(destination, "bun.lock"));
	await cp(path.join(repoRoot, "vendor"), path.join(destination, "vendor"), { recursive: true });
	await cp(path.join(repoRoot, "scripts", "heavy-optionals.js"), path.join(destination, "scripts", "heavy-optionals.js"));
	await cp(
		path.join(repoRoot, "scripts", "prune-heavy-optionals.js"),
		path.join(destination, "scripts", "prune-heavy-optionals.js"),
	);
}

async function installTree(destination: string): Promise<void> {
	const bun = process.execPath;
	const result = spawnSync(bun, ["install", "--frozen-lockfile"], {
		cwd: destination,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`bun install --frozen-lockfile failed in ${destination} (exit ${result.status ?? "signal"})`);
	}
}

function report(nodeModules: string, bytes: number, packages: FoundPackage[], sizes: Array<{ name: string; bytes: number }>) {
	const platform = `${os.platform()} ${os.arch()}`;
	console.log(`BenchLog node_modules: ${formatMiB(bytes)} (${bytes} bytes) on ${platform}`);
	console.log(`Budget: ${formatMiB(LIMIT_BYTES)} (500 × 1024 × 1024). linux x64 is the target; other pi-natives leaves differ.`);
	const natives = packages.filter(pkg => pkg.name === "@oh-my-pi/pi-natives" || pkg.name.startsWith("@oh-my-pi/pi-natives-"));
	console.log(`pi-natives packages: ${natives.map(pkg => pkg.name).join(", ") || "(none)"}`);
	console.log("Largest packages:");
	for (const entry of sizes.slice(0, 12)) {
		console.log(`  ${formatMiB(entry.bytes).padStart(10)}  ${entry.name}`);
	}
	const heavy = new Set(HEAVY_PACKAGES);
	const realHeavy = packages.filter(pkg => heavy.has(pkg.name) && !pkg.stub);
	const failures: string[] = [];
	if (bytes > LIMIT_BYTES) {
		failures.push(`node_modules is ${formatMiB(bytes)}, over the ${formatMiB(LIMIT_BYTES)} budget`);
	}
	if (realHeavy.length > 0) {
		failures.push(`real heavy packages are installed: ${realHeavy.map(pkg => pkg.name).join(", ")}`);
	}
	if (!packages.some(pkg => pkg.name === "@oh-my-pi/pi-natives")) {
		failures.push("@oh-my-pi/pi-natives is missing");
	}
	if (!packages.some(pkg => pkg.name.startsWith("@oh-my-pi/pi-natives-"))) {
		failures.push("no host @oh-my-pi/pi-natives-<platform> leaf is installed (the agent needs that binary)");
	}
	if (failures.length > 0) {
		for (const failure of failures) console.error(`size check failed: ${failure}`);
		process.exit(1);
	}
	console.log("size check passed");
}

const self = process.argv.includes("--self");
if (self) {
	const nodeModules = path.join(repoRoot, "node_modules");
	const packages: FoundPackage[] = [];
	await findNamedPackages(nodeModules, 2, packages);
	const bytes = (await gnuDuBytes(nodeModules)) ?? (await directoryBytes(nodeModules));
	const sizes = await topLevelSizes(nodeModules);
	report(nodeModules, bytes, packages, sizes);
} else {
	const temp = await mkdtemp(path.join(os.tmpdir(), "benchlog-install-"));
	try {
		await copyInstallInputs(temp);
		await installTree(temp);
		const nodeModules = path.join(temp, "node_modules");
		const packages: FoundPackage[] = [];
		await findNamedPackages(nodeModules, 2, packages);
		const bytes = (await gnuDuBytes(nodeModules)) ?? (await directoryBytes(nodeModules));
		const sizes = await topLevelSizes(nodeModules);
		report(nodeModules, bytes, packages, sizes);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
