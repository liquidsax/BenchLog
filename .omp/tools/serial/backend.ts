/**
 * BenchLog serial sessions.
 *
 * The fixture backend replays `fixtures/firmware-boot.txt`. Host paths go
 * through `uart.py` (Python 3 + pyserial). `serial_flash` and `serial_reset`
 * are not implemented; RTT, SWD, and OpenOCD are out of scope.
 */
import { type BridgeFailure, type HostPortMeta, type UartRuntime, UartBridge } from "./uart-bridge.ts";

export const FIXTURE_PORT_ID = "fixture://firmware-boot";
export const SERIAL_FIXTURE_ENV = "BENCHLOG_SERIAL_FIXTURE";

const DEFAULT_MAX_LINES = 20;
const MAX_LINES_CAP = 200;
const MAX_WRITE_CHARS = 4096;
const DEFAULT_BAUD = 115200;
const MIN_BAUD = 50;
const MAX_BAUD = 4_000_000;
const UART_READ_TIMEOUT_MS = 400;
const UART_PROBE_SNIFF_MS = 500;

const BUNDLED_FIXTURE_URL = new URL("../../../fixtures/firmware-boot.txt", import.meta.url);

const UART_SCOPE_NOTE =
	"This cut is host UART via pyserial only. RTT, SWD, OpenOCD, flash, and reset are not implemented (serial_flash and serial_reset). An STM32 ST-LINK with no virtual COM port does not appear as a serial device.";

export interface UsbIdentity {
	description: string | null;
	manufacturer: string | null;
	product: string | null;
	vid: string | null;
	pid: string | null;
	serialNumber: string | null;
	hwid: string | null;
	location: string | null;
	interface: string | null;
}

export interface ListedPort {
	id: string;
	backend: "fixture" | "uart";
	description: string;
	usb?: UsbIdentity;
}

export interface OpenedSession {
	sessionId: string;
	port: string;
	backend: "fixture" | "uart";
	baud?: number;
	lineCount?: number;
}

export interface ReadChunk {
	sessionId: string;
	port: string;
	backend: "fixture" | "uart";
	text: string;
	lineCount: number;
	offset: number;
	eof: boolean;
}

export interface WriteAck {
	sessionId: string;
	port: string;
	backend: "fixture" | "uart";
	bytes: number;
	echoed?: string;
}

export interface FixtureSample {
	board: string | null;
	resetCause: string | null;
	clock: string | null;
	sram: string | null;
	flash: string | null;
	uart: string | null;
	firmware: string | null;
	prompt: string | null;
}

export type SniffKind = "empty" | "at" | "ascii-boot" | "ascii" | "mixed" | "binary";

export interface Sniff {
	byteCount: number;
	kind: SniffKind;
	clues: string[];
	textPreview: string;
	printableRatio: number | null;
}

export interface ProbeReport {
	backend: "fixture" | "uart";
	port: string;
	sessionId: string | null;
	baud: number | null;
	usb: UsbIdentity;
	unknowns: string[];
	baudHint: string;
	sniff: Sniff;
	sniffDisposition: "fixture-sample" | "buffered-for-serial-read" | "temporary-open-consumed";
	sample: FixtureSample | null;
	runtime: UartRuntime | null;
	notes: string[];
}

export type SerialResult<T> = { ok: true; value: T } | { ok: false; error: string; details?: unknown };

interface FixtureSession {
	kind: "fixture";
	id: string;
	port: string;
	lines: string[];
	offset: number;
}

interface UartSession {
	kind: "uart";
	id: string;
	port: string;
	baud: number;
	handle: string;
	pendingLines: string[];
	offset: number;
}

type Session = FixtureSession | UartSession;

const AT_LINE = /(^|[\r\n])\s*AT(\+[A-Z0-9_]+)?(\s|$|[\r\n]|=|\?)/i;
const AT_RESP = /(^|[\r\n])(OK|ERROR|BUSY)\s*($|[\r\n])/;
const BOOT_STAMP = /\[\s*\d+\.\d+\]/;

/** True when the environment asks `serial_open` to default to the fixture port. */
export function envRequestsFixture(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[SERIAL_FIXTURE_ENV];
	if (typeof raw !== "string") return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isFixturePort(port: string): boolean {
	const trimmed = port.trim();
	return trimmed === "fixture" || trimmed === FIXTURE_PORT_ID || trimmed.startsWith("fixture://");
}

function splitLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Classify a short capture. Empty input is `empty`; text with boot markers is `ascii-boot`. */
export function classifySniff(data: Uint8Array): Sniff {
	if (data.byteLength === 0) {
		return {
			byteCount: 0,
			kind: "empty",
			clues: ["no bytes during sniff"],
			textPreview: "",
			printableRatio: null,
		};
	}
	let printable = 0;
	for (const byte of data) {
		if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable++;
	}
	const ratio = printable / data.byteLength;
	const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
	const preview = text.length > 500 ? text.slice(0, 500) : text;
	const clues: string[] = [];
	let kind: SniffKind;
	if (ratio >= 0.9) {
		if (AT_LINE.test(text) || AT_RESP.test(text)) {
			kind = "at";
			clues.push("AT command or modem response");
		} else if (BOOT_STAMP.test(text) || /boot|u-boot|reset cause|firmware/i.test(text)) {
			kind = "ascii-boot";
			clues.push("ASCII boot banner");
		} else {
			kind = "ascii";
			clues.push("mostly printable ASCII");
		}
	} else if (ratio >= 0.5) {
		kind = "mixed";
		clues.push("mixed text and binary");
	} else {
		kind = "binary";
		clues.push("mostly non-printable bytes");
	}
	if (text.includes("STM32")) clues.push("STM32 token");
	if (/ST-?LINK/i.test(text)) clues.push("ST-LINK token");
	if (/u-boot/i.test(text)) clues.push("U-Boot token");
	if (text.includes("Linux version")) clues.push("Linux banner");
	return {
		byteCount: data.byteLength,
		kind,
		clues,
		textPreview: preview,
		printableRatio: Math.round(ratio * 1000) / 1000,
	};
}

export function parseFixtureSample(text: string): FixtureSample {
	const facts = new Map<string, string>();
	let firmware: string | null = null;
	let prompt: string | null = null;
	for (const line of splitLines(text)) {
		const body = line.replace(/^\[[^\]]*\]\s*/, "");
		const match = /^([A-Za-z0-9_ -]+):\s+(.+)$/.exec(body);
		if (match?.[1] && match[2]) facts.set(match[1].trim().toLowerCase(), match[2].trim());
		const image = /firmware image\s+(\S+)/i.exec(body);
		if (image?.[1]) firmware = image[1];
		if (!line.startsWith("[") && body.trim() !== "") prompt = body.trim();
	}
	return {
		board: facts.get("board") ?? null,
		resetCause: facts.get("reset cause") ?? null,
		clock: facts.get("clock") ?? null,
		sram: facts.get("sram") ?? null,
		flash: facts.get("flash") ?? null,
		uart: facts.get("uart0") ?? null,
		firmware,
		prompt,
	};
}

function usbUnknowns(usb: UsbIdentity, extra: string[] = []): string[] {
	const unknowns = [...extra];
	const fields: Array<keyof UsbIdentity> = [
		"description",
		"manufacturer",
		"product",
		"vid",
		"pid",
		"serialNumber",
		"hwid",
		"location",
		"interface",
	];
	for (const field of fields) {
		if (usb[field] === null) unknowns.push(`usb.${field}`);
	}
	return unknowns;
}

function usbFromMeta(meta: HostPortMeta): UsbIdentity {
	return {
		description: meta.description,
		manufacturer: meta.manufacturer,
		product: meta.product,
		vid: meta.vid,
		pid: meta.pid,
		serialNumber: meta.serialNumber,
		hwid: meta.hwid,
		location: meta.location,
		interface: meta.interface,
	};
}

function describeHostPort(meta: HostPortMeta): string {
	const names = [meta.manufacturer, meta.product].filter((part): part is string => part !== null);
	const unique = [...new Set(names)];
	const title = unique.length > 0 ? unique.join(" ") : (meta.description ?? "host serial device");
	const id = meta.vid && meta.pid ? `${meta.vid}:${meta.pid}` : "";
	const serialNumber = meta.serialNumber ? `sn ${meta.serialNumber}` : "";
	return [title, id, serialNumber].filter(part => part !== "").join(" ");
}

function fixtureUsb(): UsbIdentity {
	return {
		description: "BenchLog fixture UART console (no host device)",
		manufacturer: "BenchLog",
		product: "benchlog-fixture",
		vid: null,
		pid: null,
		serialNumber: null,
		hwid: FIXTURE_PORT_ID,
		location: null,
		interface: "uart0",
	};
}

function uartFailure(port: string, detail: string): string {
	const trimmed = detail.trim().replace(/\.+$/, "");
	const permission = /permission denied|access is denied|errno 13/i.test(trimmed)
		? " On Linux the user may need to be in the dialout group."
		: "";
	return `UART ${JSON.stringify(port)}: ${trimmed}.${permission} ${UART_SCOPE_NOTE}`;
}

function bridgeFailure(port: string, failed: BridgeFailure): SerialResult<never> {
	const usb = failed.meta ? usbFromMeta(failed.meta) : undefined;
	const details = usb
		? {
				error: failed.error,
				code: failed.code,
				port,
				usb,
				unknowns: usbUnknowns(usb),
				notes: [UART_SCOPE_NOTE],
			}
		: undefined;
	return { ok: false, error: uartFailure(port, failed.error), ...(details ? { details } : {}) };
}

/**
 * Process-local serial sessions. Tools in one omp process share a hub so
 * `serial_open` and later `serial_read` / `serial_write` / `serial_probe` see
 * the same capture.
 */
export class SerialHub {
	#sessions = new Map<string, Session>();
	#nextId = 1;
	#bridge: UartBridge | undefined;
	#disposed = false;
	readonly #fixtureText: string | undefined;

	constructor(fixtureText?: string) {
		this.#fixtureText = fixtureText;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#bridge?.dispose();
		this.#bridge = undefined;
		this.#sessions.clear();
	}

	sessionBackend(sessionId: string): "fixture" | "uart" | undefined {
		return this.#sessions.get(sessionId.trim())?.kind;
	}

	async list(): Promise<{ ports: ListedPort[]; fixtureDefault: boolean; uartError?: string; skipped?: number }> {
		const ports: ListedPort[] = [
			{
				id: FIXTURE_PORT_ID,
				backend: "fixture",
				description: "Sample firmware boot log shipped at fixtures/firmware-boot.txt",
			},
		];
		const listed = await this.#hosts().list();
		if (!listed.ok) {
			return { fixtureDefault: envRequestsFixture(), ports, uartError: listed.error };
		}
		for (const meta of listed.ports) {
			ports.push({
				id: meta.device,
				backend: "uart",
				description: describeHostPort(meta),
				usb: usbFromMeta(meta),
			});
		}
		return { fixtureDefault: envRequestsFixture(), ports, skipped: listed.skipped };
	}

	async open(input: { port?: string; fixture?: boolean; baud?: number }): Promise<SerialResult<OpenedSession>> {
		const baud = normalizeBaud(input.baud);
		if (!baud.ok) return baud;
		const requested = input.port?.trim() ?? "";
		if (requested === "" || isFixturePort(requested)) {
			return this.#openFixture(requested, input.fixture);
		}
		return this.#openUart(requested, baud.value);
	}

	async read(input: { sessionId?: string; maxLines?: number }): Promise<SerialResult<ReadChunk>> {
		const session = this.#require(input.sessionId);
		if (!session.ok) return session;
		const maxLines = normalizeMaxLines(input.maxLines);
		if (!maxLines.ok) return maxLines;
		if (session.value.kind === "fixture") return this.#readFixture(session.value, maxLines.value);
		return this.#readUart(session.value, maxLines.value);
	}

	async write(input: { sessionId?: string; data?: string }): Promise<SerialResult<WriteAck>> {
		const session = this.#require(input.sessionId);
		if (!session.ok) return session;
		if (typeof input.data !== "string" || input.data.length === 0) {
			return { ok: false, error: "serial_write requires a non-empty data string." };
		}
		if (input.data.length > MAX_WRITE_CHARS) {
			return { ok: false, error: `serial_write data exceeds ${MAX_WRITE_CHARS} characters.` };
		}
		if (session.value.kind === "fixture") return this.#writeFixture(session.value, input.data);
		return this.#writeUart(session.value, input.data);
	}

	async probe(input: { sessionId?: string; port?: string; baud?: number }): Promise<SerialResult<ProbeReport>> {
		const sessionId = input.sessionId?.trim() ?? "";
		const port = input.port?.trim() ?? "";
		if (sessionId !== "") {
			const session = this.#require(sessionId);
			if (!session.ok) return session;
			if (session.value.kind === "fixture") return this.#probeFixture(session.value);
			return this.#probeUartSession(session.value);
		}
		if (port === "") {
			if (envRequestsFixture()) return this.#probeFixture(undefined);
			return {
				ok: false,
				error: `serial_probe needs a sessionId or a port. Pass ${FIXTURE_PORT_ID} or a host path such as /dev/ttyACM0.`,
			};
		}
		if (isFixturePort(port)) {
			const existing = [...this.#sessions.values()].find(session => session.kind === "fixture");
			return this.#probeFixture(existing?.kind === "fixture" ? existing : undefined);
		}
		const baud = normalizeBaud(input.baud);
		if (!baud.ok) return baud;
		const existing = [...this.#sessions.values()].find(session => session.kind === "uart" && session.port === port);
		if (existing?.kind === "uart") return this.#probeUartSession(existing);
		return this.#probeUartPort(port, baud.value);
	}

	async #openFixture(requested: string, fixtureFlag: boolean | undefined): Promise<SerialResult<OpenedSession>> {
		if (requested === "") {
			const useFixture = fixtureFlag === true || (fixtureFlag !== false && envRequestsFixture());
			if (!useFixture) {
				return {
					ok: false,
					error:
						`No port given. Pass a host UART path (for example /dev/ttyACM0 or COM3), pass ${FIXTURE_PORT_ID}, ` +
						`or run with --fixture / ${SERIAL_FIXTURE_ENV}=1 so serial_open defaults to the fixture boot log.`,
				};
			}
		}
		const existing = [...this.#sessions.values()].find(session => session.kind === "fixture");
		if (existing) return { ok: true, value: this.#opened(existing) };
		let text: string;
		try {
			text = await this.#loadFixtureText();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Fixture log is unreadable: ${message}` };
		}
		const session: FixtureSession = {
			kind: "fixture",
			id: `ser-${this.#nextId++}`,
			port: FIXTURE_PORT_ID,
			lines: splitLines(text),
			offset: 0,
		};
		this.#sessions.set(session.id, session);
		return { ok: true, value: this.#opened(session) };
	}

	async #openUart(port: string, baud: number): Promise<SerialResult<OpenedSession>> {
		const existing = [...this.#sessions.values()].find(session => session.kind === "uart" && session.port === port);
		if (existing?.kind === "uart") {
			if (existing.baud !== baud) {
				return {
					ok: false,
					error: `Port ${port} is already open at ${existing.baud} baud as ${existing.id}.`,
				};
			}
			return { ok: true, value: this.#opened(existing) };
		}
		const opened = await this.#hosts().open(port, baud);
		if (!opened.ok) return bridgeFailure(port, opened);
		const session: UartSession = {
			kind: "uart",
			id: `ser-${this.#nextId++}`,
			port: opened.port,
			baud: opened.baud,
			handle: opened.handle,
			pendingLines: [],
			offset: 0,
		};
		this.#sessions.set(session.id, session);
		return { ok: true, value: this.#opened(session) };
	}

	#readFixture(session: FixtureSession, maxLines: number): SerialResult<ReadChunk> {
		const start = session.offset;
		const slice = session.lines.slice(start, start + maxLines);
		session.offset = start + slice.length;
		return {
			ok: true,
			value: {
				sessionId: session.id,
				port: session.port,
				backend: "fixture",
				text: slice.join("\n"),
				lineCount: slice.length,
				offset: session.offset,
				eof: session.offset >= session.lines.length,
			},
		};
	}

	async #readUart(session: UartSession, maxLines: number): Promise<SerialResult<ReadChunk>> {
		const lines: string[] = [];
		while (lines.length < maxLines && session.pendingLines.length > 0) {
			const next = session.pendingLines.shift();
			if (next !== undefined) lines.push(next);
		}
		if (lines.length < maxLines) {
			const more = await this.#hosts().read(session.handle, maxLines - lines.length, UART_READ_TIMEOUT_MS);
			if (!more.ok) return bridgeFailure(session.port, more);
			lines.push(...more.lines);
		}
		session.offset += lines.length;
		return {
			ok: true,
			value: {
				sessionId: session.id,
				port: session.port,
				backend: "uart",
				text: lines.join("\n"),
				lineCount: lines.length,
				offset: session.offset,
				eof: false,
			},
		};
	}

	#writeFixture(session: FixtureSession, data: string): SerialResult<WriteAck> {
		const echoed = data.endsWith("\n") ? data.slice(0, -1) : data;
		session.lines.push(`[fixture] tx: ${echoed}`, "[fixture] rx: ack");
		return {
			ok: true,
			value: {
				sessionId: session.id,
				port: session.port,
				backend: "fixture",
				bytes: Buffer.byteLength(data),
				echoed,
			},
		};
	}

	async #writeUart(session: UartSession, data: string): Promise<SerialResult<WriteAck>> {
		const wrote = await this.#hosts().write(session.handle, data);
		if (!wrote.ok) return bridgeFailure(session.port, wrote);
		return {
			ok: true,
			value: {
				sessionId: session.id,
				port: session.port,
				backend: "uart",
				bytes: wrote.bytes,
			},
		};
	}

	async #probeFixture(session: FixtureSession | undefined): Promise<SerialResult<ProbeReport>> {
		let text: string;
		try {
			text = session ? session.lines.join("\n") : await this.#loadFixtureText();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Fixture log is unreadable: ${message}` };
		}
		const sample = parseFixtureSample(text);
		const sniff = classifySniff(new TextEncoder().encode(text));
		const declared = sample.uart;
		const baudMatch = declared ? /^(\d+)/.exec(declared) : null;
		const baud = baudMatch?.[1] ? Number(baudMatch[1]) : DEFAULT_BAUD;
		const usb = fixtureUsb();
		return {
			ok: true,
			value: {
				backend: "fixture",
				port: FIXTURE_PORT_ID,
				sessionId: session?.id ?? null,
				baud,
				usb,
				unknowns: usbUnknowns(usb, ["hostDevice"]),
				baudHint: declared
					? `fixture log declares uart0: ${declared}; baud was not measured on a host device`
					: "fixture log does not declare a baud; baud was not measured on a host device",
				sniff,
				sniffDisposition: "fixture-sample",
				sample,
				runtime: null,
				notes: ["Sample metadata parsed from the fixture capture. No host serial device was opened."],
			},
		};
	}

	async #probeUartSession(session: UartSession): Promise<SerialResult<ProbeReport>> {
		const probed = await this.#hosts().probe({
			handle: session.handle,
			port: session.port,
			baud: session.baud,
			sniffMs: UART_PROBE_SNIFF_MS,
		});
		if (!probed.ok) return bridgeFailure(session.port, probed);
		if (probed.lines.length > 0) session.pendingLines.push(...probed.lines);
		return { ok: true, value: this.#uartReport(session.port, session.id, probed, "buffered-for-serial-read") };
	}

	async #probeUartPort(port: string, baud: number): Promise<SerialResult<ProbeReport>> {
		const probed = await this.#hosts().probe({ port, baud, sniffMs: UART_PROBE_SNIFF_MS });
		if (!probed.ok) return bridgeFailure(port, probed);
		return { ok: true, value: this.#uartReport(probed.port, null, probed, "temporary-open-consumed") };
	}

	#uartReport(
		port: string,
		sessionId: string | null,
		probed: {
			baud: number;
			lines: string[];
			raw: Uint8Array;
			meta: HostPortMeta;
			runtime: UartRuntime;
			openedTemp: boolean;
		},
		disposition: "buffered-for-serial-read" | "temporary-open-consumed",
	): ProbeReport {
		const usb = usbFromMeta(probed.meta);
		const sniff = classifySniff(probed.raw);
		let baudHint: string;
		if (sniff.kind === "empty") {
			baudHint = `opened at ${probed.baud} 8N1; sniff was empty, so baud is unverified`;
		} else if (sniff.kind === "binary" || sniff.kind === "mixed") {
			baudHint = `opened at ${probed.baud} 8N1; the sniff is ${sniff.kind}, which can mean a non-text protocol or the wrong baud`;
		} else {
			baudHint = `opened at ${probed.baud} 8N1; the text sniff fits this baud, and baud was not autodetected`;
		}
		const notes =
			disposition === "buffered-for-serial-read"
				? [
						probed.lines.length > 0
							? "Sniffed bytes are queued for the next serial_read."
							: "No bytes arrived; the open session was left in place.",
					]
				: ["The port was opened only for this probe and then closed. Sniffed bytes were consumed from the wire."];
		return {
			backend: "uart",
			port,
			sessionId,
			baud: probed.baud,
			usb,
			unknowns: usbUnknowns(usb),
			baudHint,
			sniff,
			sniffDisposition: disposition,
			sample: null,
			runtime: probed.runtime,
			notes,
		};
	}

	async #loadFixtureText(): Promise<string> {
		if (this.#fixtureText !== undefined) return this.#fixtureText;
		return Bun.file(BUNDLED_FIXTURE_URL).text();
	}

	#hosts(): UartBridge {
		this.#bridge ??= new UartBridge();
		return this.#bridge;
	}

	#opened(session: Session): OpenedSession {
		if (session.kind === "fixture") {
			return {
				sessionId: session.id,
				port: session.port,
				backend: "fixture",
				lineCount: session.lines.length,
			};
		}
		return {
			sessionId: session.id,
			port: session.port,
			backend: "uart",
			baud: session.baud,
		};
	}

	#require(sessionId: string | undefined): SerialResult<Session> {
		if (typeof sessionId !== "string" || sessionId.trim() === "") {
			return { ok: false, error: "sessionId is required. Call serial_open first." };
		}
		const session = this.#sessions.get(sessionId.trim());
		if (!session) {
			return { ok: false, error: `No open serial session ${JSON.stringify(sessionId)}. Call serial_open first.` };
		}
		return { ok: true, value: session };
	}
}

function normalizeMaxLines(value: number | undefined): SerialResult<number> {
	if (value === undefined) return { ok: true, value: DEFAULT_MAX_LINES };
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
		return { ok: false, error: "maxLines must be a positive integer." };
	}
	return { ok: true, value: Math.min(value, MAX_LINES_CAP) };
}

function normalizeBaud(value: number | undefined): SerialResult<number> {
	if (value === undefined) return { ok: true, value: DEFAULT_BAUD };
	if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_BAUD || value > MAX_BAUD) {
		return { ok: false, error: `baud must be an integer from ${MIN_BAUD} to ${MAX_BAUD}.` };
	}
	return { ok: true, value };
}

let sharedHub: SerialHub | undefined;

export function getSerialHub(): SerialHub {
	sharedHub ??= new SerialHub();
	return sharedHub;
}

/** Drop process-local sessions and close any host UART helper. Tests and session shutdown call this. */
export function resetSerialHub(): void {
	const previous = sharedHub;
	sharedHub = new SerialHub();
	previous?.dispose();
}
