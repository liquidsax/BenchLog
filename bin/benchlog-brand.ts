/**
 * BenchLog product face for one harness process.
 *
 * The published `@oh-my-pi/pi-tui` welcome, setup splash, and setup wizard
 * header draw the omp gradient mark with no branding hook. This module is a
 * Bun preload (`BENCHLOG_BRAND=1`). It does not edit the installed package.
 * Welcome is swapped on the class prototype. Setup screens are rewritten when
 * those modules load, and only while this preload is active.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { plugin, type BunPlugin } from "bun";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { card, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { theme } from "@oh-my-pi/pi-tui/theme/theme";

export const BENCHLOG_PRODUCT_NAME = "BenchLog";
export const BENCHLOG_TAGLINE = "板端串口观测与诊断 Agent";

interface BenchlogFaceHooks {
	__benchlogRenderSetupSplash?: (width: number, height: number) => string[];
	__benchlogDescribeSetupSplash?: () => NativeNode;
	__benchlogRenderSetupOutro?: (width: number, height: number) => string[];
	__benchlogDescribeSetupOutro?: () => NativeNode;
}

const hooks = globalThis as typeof globalThis & BenchlogFaceHooks;

const SPLASH_RENDER =
	"export function renderSetupSplash(width: number, height: number, elapsedMs: number): string[] {";
const SPLASH_DESCRIBE = "export function describeSetupSplash(): NativeNode {";
const OUTRO_RENDER =
	"export function renderSetupOutro(width: number, height: number, elapsedMs: number): string[] {";
const OUTRO_DESCRIBE = "export function describeSetupOutro(): NativeNode {";
const WIZARD_NATIVE_LOGO = "logoNode(PI_LOGO, false),";
const WIZARD_NATIVE_NAME = 'text([span(APP_NAME, "accent strong")], { wrap: "none" }),';
const WIZARD_TERM_LOGO = "const logo = gradientLogo(PI_LOGO, 0);";
const WIZARD_TERM_NAME = 'centerLine(theme.bold(theme.fg("accent", APP_NAME)), width),';

let installed = false;
let frameVersion = "0.0.0";
const welcomeLines = new Map<string, string[]>();
let welcomeNode: NativeNode | undefined;

function productVersion(): string {
	const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "../package.json"), "utf8")) as {
		version?: unknown;
	};
	return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "0.0.0";
}

function columns(value: string): number {
	return Bun.stringWidth(value, { countAnsiEscapeCodes: false });
}

function paint(color: "accent" | "muted" | "dim", value: string, bold = false): string {
	if (typeof theme === "undefined") return value;
	const colored = theme.fg(color, value);
	return bold ? theme.bold(colored) : colored;
}

function centerLine(line: string, width: number): string {
	const gap = Math.max(0, Math.floor((width - columns(line)) / 2));
	return `${" ".repeat(gap)}${line}`;
}

/** Boxed BenchLog mark when it fits; otherwise the name, tagline, and version that fit. */
export function renderBenchlogWelcome(termWidth: number, version: string): string[] {
	const cacheKey = `${termWidth}\0${version}`;
	const cached = welcomeLines.get(cacheKey);
	if (cached) return cached;
	const room = termWidth - 2;
	if (room < 4) {
		const empty: string[] = [];
		welcomeLines.set(cacheKey, empty);
		return empty;
	}
	const title = BENCHLOG_PRODUCT_NAME;
	const tagline = BENCHLOG_TAGLINE;
	const versionLabel = `v${version}`;
	const inner = Math.max(columns(title), columns(tagline));
	const boxWidth = inner + 4;
	let plain: string[];
	if (boxWidth <= room) {
		const top = `╔${"═".repeat(inner + 2)}╗`;
		const bottom = `╚${"═".repeat(inner + 2)}╝`;
		const row = (value: string): string => {
			const pad = inner - columns(value);
			const left = Math.floor(pad / 2);
			return `║ ${" ".repeat(left)}${value}${" ".repeat(pad - left)} ║`;
		};
		plain = [top, row(title), row(tagline), bottom, versionLabel];
	} else {
		plain = [title, tagline, versionLabel].filter(line => columns(line) <= room);
	}
	const painted = plain.map(line => {
		if (line.includes(title)) return paint("accent", line, true);
		if (line.includes(tagline)) return paint("muted", line);
		return paint("dim", line);
	});
	const lines = painted.map(line => centerLine(line, termWidth));
	welcomeLines.set(cacheKey, lines);
	return lines;
}

function fitWidth(line: string, width: number): string {
	const visible = columns(line);
	if (visible > width) return line;
	return line + " ".repeat(width - visible);
}

/** Full-screen setup frame: the welcome mark, plus an optional footer row. */
export function renderBenchlogFrame(width: number, height: number, version: string, footer?: string): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const block = renderBenchlogWelcome(w, version);
	const lines = Array.from({ length: h }, () => " ".repeat(w));
	const showFooter = footer !== undefined && columns(footer) <= w && h > block.length;
	const usable = h - (showFooter ? 1 : 0);
	const start = Math.max(0, Math.floor((usable - block.length) / 2));
	for (let i = 0; i < block.length && start + i < usable; i++) {
		const row = block[i];
		if (row !== undefined) lines[start + i] = fitWidth(row, w);
	}
	if (showFooter && footer !== undefined) lines[h - 1] = fitWidth(centerLine(paint("dim", footer), w), w);
	return lines;
}

export function describeBenchlogWelcome(version: string): NativeNode {
	welcomeNode ??= card({ role: "benchlog.welcome" }, [
		text([span(BENCHLOG_PRODUCT_NAME, "strong")], { wrap: "none" }),
		text([span(BENCHLOG_TAGLINE, "dim")], { wrap: "none" }),
		text([span(`v${version}`, "dim mono")], { wrap: "none" }),
	]);
	return welcomeNode;
}

function clearWelcomeCache(): void {
	welcomeLines.clear();
	welcomeNode = undefined;
}

function mustReplace(source: string, from: string, to: string, label: string): string {
	if (!source.includes(from)) {
		throw new Error(`benchlog: the ${label} startup hook does not match this oh-my-pi build`);
	}
	return source.replace(from, to);
}

/** Rewrite setup modules so their first paint is BenchLog. Exported for the launcher test. */
export function rewriteHarnessFaceSource(filename: string, source: string): string {
	if (filename.endsWith("/splash.ts") || filename.endsWith("\\splash.ts")) {
		let next = mustReplace(
			source,
			SPLASH_RENDER,
			`${SPLASH_RENDER}\n\treturn globalThis.__benchlogRenderSetupSplash(width, height);`,
			"setup splash",
		);
		next = mustReplace(
			next,
			SPLASH_DESCRIBE,
			`${SPLASH_DESCRIBE}\n\treturn globalThis.__benchlogDescribeSetupSplash();`,
			"setup splash description",
		);
		return next;
	}
	if (filename.endsWith("/outro.ts") || filename.endsWith("\\outro.ts")) {
		let next = mustReplace(
			source,
			OUTRO_RENDER,
			`${OUTRO_RENDER}\n\treturn globalThis.__benchlogRenderSetupOutro(width, height);`,
			"setup outro",
		);
		next = mustReplace(
			next,
			OUTRO_DESCRIBE,
			`${OUTRO_DESCRIBE}\n\treturn globalThis.__benchlogDescribeSetupOutro();`,
			"setup outro description",
		);
		return next;
	}
	if (filename.endsWith("/wizard-overlay.ts") || filename.endsWith("\\wizard-overlay.ts")) {
		let next = mustReplace(
			source,
			WIZARD_NATIVE_LOGO,
			'text([span("BenchLog", "accent strong")], { wrap: "none" }),',
			"setup wizard mark",
		);
		next = mustReplace(
			next,
			WIZARD_NATIVE_NAME,
			'text([span("板端串口观测与诊断 Agent", "muted")], { wrap: "none" }),',
			"setup wizard name",
		);
		next = mustReplace(
			next,
			WIZARD_TERM_LOGO,
			'const logo = [theme.bold(theme.fg("accent", "BenchLog")), theme.fg("muted", "板端串口观测与诊断 Agent")];',
			"setup wizard header",
		);
		next = mustReplace(next, WIZARD_TERM_NAME, '"",', "setup wizard wordmark");
		return next;
	}
	return source;
}

const facePlugin: BunPlugin = {
	name: "benchlog-face",
	setup(build) {
		build.onLoad({ filter: /(?:splash|outro|wizard-overlay)\.ts$/ }, async args => {
			const source = await Bun.file(args.path).text();
			if (!args.path.includes("/pi-tui/")) return { contents: source, loader: "ts" };
			return { contents: rewriteHarnessFaceSource(args.path, source), loader: "ts" };
		});
	},
};

function patchWelcome(version: string): void {
	const proto = WelcomeComponent.prototype;
	if (typeof proto.render !== "function" || typeof proto.describe !== "function") {
		throw new Error("benchlog: WelcomeComponent has no render/describe hook");
	}
	const invalidate = proto.invalidate;
	proto.render = function renderBenchlog(termWidth: number): readonly string[] {
		return renderBenchlogWelcome(termWidth, version);
	};
	proto.describe = function describeBenchlog(): NativeNode {
		return describeBenchlogWelcome(version);
	};
	proto.invalidate = function invalidateBenchlog(): void {
		clearWelcomeCache();
		invalidate.call(this);
	};
}

/** Install the in-process face. Safe to call once per process. */
export function installBenchlogBrand(): void {
	if (installed) return;
	installed = true;
	frameVersion = productVersion();
	clearWelcomeCache();
	hooks.__benchlogRenderSetupSplash = (width, height) =>
		renderBenchlogFrame(width, height, frameVersion, "press enter to skip");
	hooks.__benchlogDescribeSetupSplash = () => describeBenchlogWelcome(frameVersion);
	hooks.__benchlogRenderSetupOutro = (width, height) =>
		renderBenchlogFrame(width, height, frameVersion, "Setup saved");
	hooks.__benchlogDescribeSetupOutro = () => describeBenchlogWelcome(frameVersion);
	plugin(facePlugin);
	patchWelcome(frameVersion);
}

if (process.env.BENCHLOG_BRAND === "1") installBenchlogBrand();
