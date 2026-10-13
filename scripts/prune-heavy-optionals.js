/**
 * Drop real Hugging Face / sherpa / ONNX / omp-stats UI trees if this install
 * did not apply BenchLog's root `overrides` (npm only honors overrides on the
 * project root). Stubs from `vendor/omitted-optional` are left in place.
 *
 * A hoisted copy is kept when the top-level project, or some other installed
 * package, depends on it. That keeps `npm install benchlog` inside a React
 * app from deleting that app's `react`.
 */
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEAVY_PACKAGES, OMIT_MARKER } from "./heavy-optionals.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAVY = new Set(HEAVY_PACKAGES);

/** Packages that are allowed to be the only dependents of a heavy name. */
const OWNERS = {
	"@huggingface/transformers": ["@oh-my-pi/pi-coding-agent"],
	"@huggingface/tokenizers": ["@huggingface/transformers"],
	"sherpa-onnx": ["sherpa-onnx-node"],
	"sherpa-onnx-node": ["@oh-my-pi/pi-coding-agent"],
	"sherpa-onnx-linux-x64": ["sherpa-onnx-node"],
	"sherpa-onnx-linux-arm64": ["sherpa-onnx-node"],
	"sherpa-onnx-darwin-x64": ["sherpa-onnx-node"],
	"sherpa-onnx-darwin-arm64": ["sherpa-onnx-node"],
	"sherpa-onnx-win-x64": ["sherpa-onnx-node"],
	"sherpa-onnx-win-ia32": ["sherpa-onnx-node"],
	"onnxruntime-node": ["@huggingface/transformers", "@oh-my-pi/pi-mnemopi", "fastembed"],
	"onnxruntime-web": ["@huggingface/transformers"],
	"onnxruntime-common": ["onnxruntime-node", "onnxruntime-web"],
	fastembed: ["@oh-my-pi/pi-mnemopi"],
	"lucide-react": ["@oh-my-pi/omp-stats"],
	react: ["@oh-my-pi/omp-stats", "lucide-react"],
	"react-dom": ["@oh-my-pi/omp-stats"],
};

function nodeModulesRoots(start) {
	const roots = [path.join(start, "node_modules")];
	let dir = path.resolve(start);
	for (let i = 0; i < 6; i++) {
		if (path.basename(dir) === "node_modules") {
			roots.push(dir);
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [...new Set(roots)];
}

async function readPackage(dir) {
	try {
		const text = await readFile(path.join(dir, "package.json"), "utf8");
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function isStub(manifest) {
	if (!manifest || typeof manifest !== "object") return false;
	if (manifest.name === "benchlog-omitted-optional") return true;
	return typeof manifest.description === "string" && manifest.description.includes(OMIT_MARKER);
}

function dependencyNames(manifest) {
	if (!manifest || typeof manifest !== "object") return [];
	const names = [];
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		const block = manifest[field];
		if (block && typeof block === "object") names.push(...Object.keys(block));
	}
	return names;
}

function isPrivateBenchlogCopy(dir) {
	const parts = dir.split(path.sep);
	for (let i = 0; i < parts.length - 1; i++) {
		if (parts[i] === "benchlog" && parts[i + 1] === "node_modules") return true;
	}
	return false;
}

async function listInstalledManifests(nodeModules) {
	const manifests = [];
	let entries;
	try {
		entries = await readdir(nodeModules, { withFileTypes: true });
	} catch {
		return manifests;
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
				const manifest = await readPackage(path.join(dir, child.name));
				if (manifest?.name) manifests.push(manifest);
			}
		} else {
			const manifest = await readPackage(dir);
			if (manifest?.name) manifests.push(manifest);
		}
	}
	return manifests;
}

/**
 * Keep a hoisted package when the top-level project or an unrelated package
 * depends on it. Copies nested under `benchlog/node_modules` are BenchLog's.
 */
export async function shouldKeepHoisted(nodeModules, heavyName) {
	const project = await readPackage(path.dirname(nodeModules));
	if (dependencyNames(project).includes(heavyName)) return true;
	const owners = new Set(OWNERS[heavyName] ?? []);
	const installed = await listInstalledManifests(nodeModules);
	for (const manifest of installed) {
		if (!manifest.name || manifest.name === heavyName || owners.has(manifest.name)) continue;
		if (dependencyNames(manifest).includes(heavyName)) return true;
	}
	return false;
}

async function findPackageDirs(nodeModules, segments, depth, found) {
	let entries;
	try {
		entries = await readdir(nodeModules, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const dir = path.join(nodeModules, entry.name);
		if (entry.name.startsWith(".")) continue;
		if (segments.length === 1 && entry.name === segments[0]) {
			found.push(dir);
			continue;
		}
		if (segments.length === 2 && entry.name === segments[0]) {
			const nested = path.join(dir, segments[1]);
			try {
				const stat = await lstat(nested);
				if (stat.isDirectory()) found.push(nested);
			} catch {
				// scope folder without that package
			}
		}
		if (depth > 0 && entry.name !== "node_modules") {
			await findPackageDirs(path.join(dir, "node_modules"), segments, depth - 1, found);
		}
	}
}

export async function pruneHeavyOptionals(start = pkgRoot) {
	const removed = [];
	for (const root of nodeModulesRoots(start)) {
		for (const name of HEAVY) {
			const segments = name.startsWith("@") ? name.split("/") : [name];
			const dirs = [];
			await findPackageDirs(root, segments, 2, dirs);
			for (const dir of dirs) {
				const manifest = await readPackage(dir);
				if (!manifest || isStub(manifest) || !HEAVY.has(manifest.name)) continue;
				if (!isPrivateBenchlogCopy(dir) && (await shouldKeepHoisted(root, manifest.name))) continue;
				await rm(dir, { recursive: true, force: true });
				removed.push(dir);
			}
		}
	}
	return removed;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
	const removed = await pruneHeavyOptionals();
	if (removed.length > 0) {
		console.log(`benchlog: removed ${removed.length} unused optional package tree(s)`);
	}
}
