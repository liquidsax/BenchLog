/**
 * SEGGER RTT over SWD, plus the error labels shared with host UART.
 *
 * `fixture://rtt-sample` replays `fixtures/rtt-sample.txt` and never starts
 * OpenOCD. Hardware ports are `rtt://stlink-N` (spawn OpenOCD) and
 * `rtt://openocd` (attach). The OpenOCD command sequence is a hypothesis;
 * see `openocd.ts`.
 */
import * as fs from "node:fs/promises";

export const RTT_FIXTURE_PORT_ID = "fixture://rtt-sample";
export const RTT_OPENOCD_PORT_ID = "rtt://openocd";

export const DEFAULT_RTT_SEARCH = "0x20000000:0x20000";
export const DEFAULT_RTT_ID = "SEGGER RTT";
export const DEFAULT_RTT_TARGET = "stm32f4x.cfg";
export const DEFAULT_RTT_INTERFACE = "interface/stlink.cfg";

const BUNDLED_RTT_FIXTURE = new URL("./fixtures/rtt-sample.txt", import.meta.url);

/**
 * ST-LINK USB product ids. Hypothesis drawn from OpenOCD's udev rules and
 * ST's public ST-LINK ids. A CDC VCP such as 0483:5740 is intentionally absent:
 * that device is a UART, not an RTT adapter.
 */
const STLINK_VID = "0483";
const STLINK_PIDS = new Map<string, string>([
	["3744", "ST-LINK/V1"],
	["3748", "ST-LINK/V2"],
	["374b", "ST-LINK/V2-1"],
	["374d", "STLINK-V3 loader"],
	["374e", "STLINK-V3"],
	["374f", "STLINK-V3"],
	["3752", "STLINK-V3"],
	["3753", "STLINK-V3"],
	["3754", "STLINK-V3"],
	["3755", "STLINK-V3"],
	["3757", "STLINK-V3"],
]);

export const OPENOCD_INSTALL_HINT =
	"Install OpenOCD with sudo apt install openocd, sudo dnf install openocd, sudo pacman -S openocd, or brew install openocd. On Linux, install the udev rules that ship with OpenOCD so the ST-LINK node is writable.";

export interface RttChannel {
	direction: "up" | "down";
	index: number;
	name: string;
	size: number;
	flags: number | null;
}

export interface RttSearch {
	address: string;
	size: number;
	id: string;
}

export interface RttIdentity {
	transport: "fixture" | "openocd-tcl" | "openocd-telnet";
	chip: string | null;
	adapter: string | null;
	controlBlock: string | null;
	channels: RttChannel[];
	openocd: string | null;
	search: RttSearch | null;
}

export interface StlinkAdapter {
	id: string;
	vid: string;
	pid: string;
	product: string | null;
	serialNumber: string | null;
	location: string | null;
}

export interface RttListedPort {
	id: string;
	description: string;
	usb: {
		description: string | null;
		manufacturer: string | null;
		product: string | null;
		vid: string | null;
		pid: string | null;
		serialNumber: string | null;
		hwid: string | null;
		location: string | null;
		interface: string | null;
	} | null;
}

export type RttProblem = "openocd-missing" | "no-stlink" | "no-rtt";

export function isRttFixturePort(port: string): boolean {
	return port.trim() === RTT_FIXTURE_PORT_ID;
}

export function isRttHardwarePort(port: string): boolean {
	return port.trim().startsWith("rtt://");
}

export function isRttPort(port: string): boolean {
	return isRttFixturePort(port) || isRttHardwarePort(port);
}

/** Classify OpenOCD log/reply text. The first matching label wins. */
export function classifyRttProblem(text: string): RttProblem | undefined {
	if (/no control block found|control block not available|rtt is not configured/i.test(text)) return "no-rtt";
	if (
		/no device found|libusb_error|could not open adapter|error: open failed|unable to open st-?link|failed to open st-?link|no debug probe|couldn't find an st-?link|unable to find a matching debug adapter/i.test(
			text,
		)
	) {
		return "no-stlink";
	}
	if (/openocd: not found|cannot find .*openocd/i.test(text)) return "openocd-missing";
	if (/posix_spawn|ENOENT|spawn openocd/i.test(text) && /openocd/i.test(text)) return "openocd-missing";
	return undefined;
}

export function formatOpenOcdMissing(detail: string): string {
	const extra = detail.trim() === "" ? "" : ` ${detail.trim().slice(0, 400)}`;
	return (
		`OpenOCD missing:${extra} RTT over SWD needs the openocd binary plus an ST-LINK. ` +
		`This is not a virtual COM port failure and not a missing SEGGER control block. ` +
		`${RTT_FIXTURE_PORT_ID} works with neither installed. ${OPENOCD_INSTALL_HINT}`
	);
}

export function formatNoStlink(detail: string): string {
	const extra = detail.trim() === "" ? "" : ` ${detail.trim().slice(0, 500)}`;
	return (
		`No ST-LINK:${extra} OpenOCD is installed but it did not open a debug adapter. ` +
		`This is not a virtual COM port failure and not a missing SEGGER control block. ` +
		`Check the USB cable and the udev rules shipped with OpenOCD.`
	);
}

export function formatNoRtt(search: RttSearch, detail: string): string {
	const extra = detail.trim() === "" ? "" : ` OpenOCD said: ${detail.trim().slice(0, 500)}`;
	return (
		`No RTT control block: OpenOCD started, but no block id ${JSON.stringify(search.id)} was found at ${search.address} ` +
		`for ${search.size} bytes.${extra} This is not a virtual COM port failure and the openocd binary did start. ` +
		`Widen BENCHLOG_RTT_SEARCH (address:size), set BENCHLOG_RTT_TARGET if this part is not the default, ` +
		`and confirm the firmware reaches SEGGER_RTT_Init before the search.`
	);
}

export function formatNoVcp(port: string, detail: string): string {
	const trimmed = detail.trim().replace(/\.+$/, "");
	const permission = /permission denied|access is denied|errno 13/i.test(trimmed)
		? " On Linux the user may need to be in the dialout group."
		: "";
	return (
		`No VCP: UART ${JSON.stringify(port)}: ${trimmed}.${permission} ` +
		`Host UART only opens a virtual COM port via pyserial. serial_flash and serial_reset are not implemented. ` +
		`An ST-LINK with no virtual COM port is not a UART. Use ${RTT_FIXTURE_PORT_ID}, or rtt://stlink-0 when OpenOCD and an ST-LINK are both present.`
	);
}

export function formatRttProblem(kind: RttProblem, search: RttSearch, detail: string): string {
	if (kind === "openocd-missing") return formatOpenOcdMissing(detail);
	if (kind === "no-stlink") return formatNoStlink(detail);
	return formatNoRtt(search, detail);
}

/** Parse `BENCHLOG_RTT_SEARCH` (`0x20000000:0x20000`). */
export function parseRttSearch(
	raw: string | undefined,
): { ok: true; address: string; size: number } | { ok: false; error: string } {
	const value = (raw && raw.trim() !== "" ? raw : (process.env.BENCHLOG_RTT_SEARCH ?? DEFAULT_RTT_SEARCH)).trim();
	const match = /^(0x[0-9a-fA-F]+|\d+):(0x[0-9a-fA-F]+|\d+)$/.exec(value);
	if (!match?.[1] || !match[2]) {
		return { ok: false, error: `RTT search must look like 0x20000000:0x20000. Got ${JSON.stringify(value)}.` };
	}
	const size = Number(match[2]);
	const addressNum = Number(match[1]);
	if (!Number.isSafeInteger(addressNum) || !Number.isSafeInteger(size) || size < 16 || size > 0x10_0000) {
		return {
			ok: false,
			error: `RTT search must be address:size, with size from 16 to 1048576. Got ${JSON.stringify(value)}.`,
		};
	}
	const address = match[1].toLowerCase().startsWith("0x") ? match[1] : `0x${addressNum.toString(16)}`;
	return { ok: true, address, size };
}

export function rttSearchFromEnv(override?: string): { ok: true; value: RttSearch } | { ok: false; error: string } {
	const parsed = parseRttSearch(override);
	if (!parsed.ok) return parsed;
	const id = (process.env.BENCHLOG_RTT_ID ?? DEFAULT_RTT_ID).trim();
	if (id === "" || /[{}\r\n]/.test(id)) {
		return { ok: false, error: "BENCHLOG_RTT_ID must be a single-line control-block id without braces." };
	}
	return { ok: true, value: { address: parsed.address, size: parsed.size, id } };
}

export function rttTargetFromEnv(override?: string): string {
	const raw = (
		override && override.trim() !== "" ? override : (process.env.BENCHLOG_RTT_TARGET ?? DEFAULT_RTT_TARGET)
	).trim();
	return raw;
}

export function rttInterfaceFromEnv(): string {
	const raw = (process.env.BENCHLOG_RTT_INTERFACE ?? DEFAULT_RTT_INTERFACE).trim();
	return raw === "" ? DEFAULT_RTT_INTERFACE : raw;
}

export function rttChannelFromEnv(): { ok: true; value: number } | { ok: false; error: string } {
	const raw = process.env.BENCHLOG_RTT_CHANNEL;
	if (raw === undefined || raw.trim() === "") return { ok: true, value: 0 };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > 15) {
		return { ok: false, error: "BENCHLOG_RTT_CHANNEL must be an integer from 0 to 15." };
	}
	return { ok: true, value };
}

/**
 * OpenOCD `rtt channels` text. Direction comes from the `Up-channels:` /
 * `Down-channels:` headings. Each entry is `index: name size flags`.
 */
export function parseRttChannels(text: string): RttChannel[] {
	const channels: RttChannel[] = [];
	let direction: "up" | "down" | null = null;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (/^up-channels:?$/i.test(trimmed)) {
			direction = "up";
			continue;
		}
		if (/^down-channels:?$/i.test(trimmed)) {
			direction = "down";
			continue;
		}
		const match = /^(\d+):\s+(.+?)\s+(\d+)\s+(\d+)\s*$/.exec(trimmed);
		if (!match?.[1] || !match[2] || !match[3] || !match[4] || !direction) continue;
		channels.push({
			direction,
			index: Number(match[1]),
			name: match[2],
			size: Number(match[3]),
			flags: Number(match[4]),
		});
	}
	return channels;
}

export function parseChip(targetsText: string, flashText: string): string | null {
	const flash = /#\d+\s*:\s*(\S+)\s*(?:\(([^)]+)\))?/.exec(flashText);
	if (flash?.[1]) return flash[2] ? `${flash[1]} (${flash[2]})` : flash[1];
	for (const line of targetsText.split(/\r?\n/)) {
		const match = /^\s*\d+\*?\s+(\S+)/.exec(line);
		if (match?.[1] && !/^-+$/.test(match[1])) return match[1];
	}
	return null;
}

export function parseAdapter(text: string): string | null {
	const first = text
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(line => line !== "");
	if (!first) return null;
	if (/invalid command|unknown command|command not found|is not a valid|error:/i.test(first)) return null;
	if (first.length > 80) return null;
	return first;
}

export function parseControlBlock(text: string): string | null {
	const match = /control block found at (0x[0-9a-fA-F]+)/i.exec(text);
	return match?.[1] ?? null;
}

export function parseOpenOcdVersion(text: string): string | null {
	const match = /Open On-Chip Debugger\s+(\S+)/.exec(text);
	return match?.[1] ?? null;
}

export function scriptArg(kind: "interface" | "target", value: string): string {
	if (value.includes("/") || value.endsWith(".cfg")) {
		if (value.includes("/")) return value;
		return `${kind}/${value}`;
	}
	return `${kind}/${value}.cfg`;
}

function stripStamp(line: string): string {
	return line.replace(/^\[[^\]]*\]\s*/, "").trim();
}

/** Pull chip, adapter, and channel sizes out of the fixture capture. */
export function parseRttFixture(text: string): { chip: string | null; adapter: string | null; channels: RttChannel[] } {
	let chip: string | null = null;
	let adapter: string | null = null;
	const channels: RttChannel[] = [];
	for (const line of text.split(/\r?\n/)) {
		const body = stripStamp(line);
		const chipMatch = /^chip:\s+(.+)$/i.exec(body);
		if (chipMatch?.[1]) chip = chipMatch[1];
		const adapterMatch = /^adapter:\s+(.+)$/i.exec(body);
		if (adapterMatch?.[1]) {
			const value = adapterMatch[1].trim();
			adapter = /^(none|null|n\/a|-)$/i.test(value) ? null : value;
		}
		const channel = /^rtt (up|down) (\d+):\s+(.+?)\s+(\d+)(?:\s+(\d+))?\s*$/i.exec(body);
		if (channel?.[1] && channel[2] && channel[3] && channel[4]) {
			const direction = channel[1].toLowerCase() === "down" ? "down" : "up";
			channels.push({
				direction,
				index: Number(channel[2]),
				name: channel[3],
				size: Number(channel[4]),
				flags: channel[5] !== undefined ? Number(channel[5]) : null,
			});
		}
	}
	return { chip, adapter, channels };
}

export async function loadRttFixtureText(override?: string): Promise<string> {
	if (override !== undefined) return override;
	return Bun.file(BUNDLED_RTT_FIXTURE).text();
}

export async function resolveOpenOcd(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const override = env.BENCHLOG_OPENOCD;
	if (typeof override === "string" && override.trim() !== "") {
		const path = override.trim();
		if (await Bun.file(path).exists()) return path;
		return null;
	}
	return Bun.which("openocd");
}

function hexId(value: string): string {
	return `0x${value.toLowerCase()}`;
}

function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}

async function readTrimmed(path: string): Promise<string | null> {
	try {
		const text = (await Bun.file(path).text()).trim();
		return text === "" ? null : text;
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
}

async function detectFromSysfs(root: string): Promise<StlinkAdapter[]> {
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const found: StlinkAdapter[] = [];
	for (const name of names) {
		const dir = `${root}/${name}`;
		const vid = (await readTrimmed(`${dir}/idVendor`))?.toLowerCase() ?? null;
		const pid = (await readTrimmed(`${dir}/idProduct`))?.toLowerCase() ?? null;
		if (vid !== STLINK_VID || !pid || !STLINK_PIDS.has(pid)) continue;
		const serialNumber = await readTrimmed(`${dir}/serial`);
		const product = (await readTrimmed(`${dir}/product`)) ?? STLINK_PIDS.get(pid) ?? null;
		found.push({
			id: `rtt://stlink-${found.length}`,
			vid: hexId(vid),
			pid: hexId(pid),
			product,
			serialNumber,
			location: dir,
		});
	}
	return found;
}

async function detectFromLsusb(): Promise<StlinkAdapter[]> {
	const bin = Bun.which("lsusb");
	if (!bin) return [];
	const proc = Bun.spawn([bin], { stdout: "pipe", stderr: "ignore" });
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// lsusb already exited.
		}
	}, 1500);
	const stdout = proc.stdout;
	const text = stdout && typeof stdout !== "number" ? await new Response(stdout).text() : "";
	await proc.exited;
	clearTimeout(timer);
	const found: StlinkAdapter[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})(?:\s+(.*))?/.exec(line);
		if (!match?.[1] || !match[2]) continue;
		const vid = match[1].toLowerCase();
		const pid = match[2].toLowerCase();
		if (vid !== STLINK_VID || !STLINK_PIDS.has(pid)) continue;
		found.push({
			id: `rtt://stlink-${found.length}`,
			vid: hexId(vid),
			pid: hexId(pid),
			product: match[3]?.trim() || STLINK_PIDS.get(pid) || null,
			serialNumber: null,
			location: null,
		});
	}
	return found;
}

export async function detectStlinkAdapters(env: NodeJS.ProcessEnv = process.env): Promise<StlinkAdapter[]> {
	const override = env.BENCHLOG_RTT_SYSFS;
	if (typeof override === "string" && override.trim() !== "") return detectFromSysfs(override.trim());
	const fromSysfs = await detectFromSysfs("/sys/bus/usb/devices");
	if (fromSysfs.length > 0) return fromSysfs;
	return detectFromLsusb();
}

export function rttListNote(openocd: string | null, adapters: StlinkAdapter[]): string {
	const parts = [`${RTT_FIXTURE_PORT_ID} is always listed (no board and no OpenOCD).`];
	if (openocd) parts.push(`openocd: ${openocd}.`);
	else {
		parts.push(
			"OpenOCD missing: no openocd binary on PATH, or BENCHLOG_OPENOCD does not exist, so no rtt:// candidate is listed.",
		);
	}
	if (adapters.length === 0) parts.push("stlink: none.");
	else parts.push(`stlink: ${adapters.map(adapter => `${adapter.vid}:${adapter.pid}`).join(", ")}.`);
	if (openocd && adapters.length > 0) {
		parts.push(`rtt candidate: ${adapters.map(adapter => adapter.id).join(", ")}.`);
	} else if (!openocd && adapters.length > 0) {
		parts.push(
			"An ST-LINK is on USB but OpenOCD is not installed, so it is not an rtt port. This is not a virtual COM port failure.",
		);
	} else if (openocd && adapters.length === 0) {
		parts.push(
			"OpenOCD is installed but no ST-LINK USB device was detected. A ttyACM or ttyUSB VCP stays on the uart backend.",
		);
	}
	return parts.join(" ");
}

function fixturePort(): RttListedPort {
	return {
		id: RTT_FIXTURE_PORT_ID,
		description: "Sample SEGGER RTT log shipped at .omp/tools/serial/fixtures/rtt-sample.txt",
		usb: null,
	};
}

function adapterPort(adapter: StlinkAdapter): RttListedPort {
	const title = adapter.product ?? "ST-LINK";
	const serial = adapter.serialNumber ? ` sn ${adapter.serialNumber}` : "";
	return {
		id: adapter.id,
		description: `${title} ${adapter.vid}:${adapter.pid}${serial}`,
		usb: {
			description: title,
			manufacturer: "STMicroelectronics",
			product: adapter.product,
			vid: adapter.vid,
			pid: adapter.pid,
			serialNumber: adapter.serialNumber,
			hwid: `${adapter.vid}:${adapter.pid}`,
			location: adapter.location,
			interface: "swd",
		},
	};
}

export async function listRttPorts(env: NodeJS.ProcessEnv = process.env): Promise<{
	ports: RttListedPort[];
	note: string;
	openocd: string | null;
	adapters: StlinkAdapter[];
}> {
	let openocd: string | null = null;
	let adapters: StlinkAdapter[] = [];
	let failure = "";
	try {
		openocd = await resolveOpenOcd(env);
		adapters = await detectStlinkAdapters(env);
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	const ports = [fixturePort()];
	if (openocd) {
		for (const adapter of adapters) ports.push(adapterPort(adapter));
	}
	const attach = env.BENCHLOG_RTT_ATTACH;
	if (typeof attach === "string" && attach.trim() !== "") {
		ports.push({
			id: RTT_OPENOCD_PORT_ID,
			description: `Attach to an already running OpenOCD at ${attach.trim()}`,
			usb: null,
		});
	}
	const note =
		failure === ""
			? rttListNote(openocd, adapters)
			: `${rttListNote(openocd, adapters)} stlink detection failed: ${failure}`;
	return { ports, note, openocd, adapters };
}

export function rttUnknowns(info: RttIdentity, usbNulls: string[]): string[] {
	const unknowns = [...usbNulls];
	if (!info.chip) unknowns.push("chip");
	if (!info.adapter) unknowns.push("adapter");
	if (!info.controlBlock) unknowns.push("controlBlock");
	if (info.channels.length === 0) unknowns.push("rtt.channels");
	if (!info.openocd) unknowns.push("openocd.version");
	return unknowns;
}
