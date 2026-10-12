/**
 * BenchLog UART and RTT tools. Discovered from `.omp/tools/serial/` when omp's
 * cwd is this repo. Parameters are JSON Schema via the host zod builder.
 * Approval tiers are declared here and resolved by omp's `resolveApproval`;
 * this module does not prompt on its own.
 *
 * Host UART needs Python 3 and pyserial
 * (`python3 -m pip install -r .omp/tools/serial/requirements.txt`).
 * The fixture ports do not. Hardware RTT needs OpenOCD and an ST-LINK.
 */
import {
	type OpenedSession,
	type ProbeReport,
	type ReadChunk,
	type SerialResult,
	type WriteAck,
	envRequestsFixture,
	getSerialHub,
	isFixturePort,
	isRttHardwarePort,
	resetSerialHub,
} from "./backend.ts";

/** Minimal slice of the host schema builder (`pi.zod` / `omp.zod`). */
interface Schema {
	describe(text: string): Schema;
	optional(): Schema;
}
interface SchemaBuilder {
	object(shape: Record<string, Schema>): Schema;
	string(): Schema;
	boolean(): Schema;
	number(): Schema;
}
interface ToolHost {
	zod: SchemaBuilder;
}

type ApprovalTier = "read" | "exec";

interface SerialTool {
	name: string;
	label: string;
	description: string;
	parameters: Schema;
	approval: ApprovalTier | ((args: unknown) => ApprovalTier);
	loadMode: "essential";
	strict: true;
	formatApprovalDetails?: (args: unknown) => string[];
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{ content: [{ type: "text"; text: string }]; details: unknown; isError?: boolean }>;
	onSession?: (event: { reason?: string }) => void;
}

/**
 * Fixture UART and fixture RTT stay read-tier. A host UART probe and any
 * OpenOCD/ST-LINK probe are exec. An unknown sessionId fails closed to exec.
 */
export function serialProbeApproval(args: unknown): ApprovalTier {
	const sessionId = stringField(args, "sessionId").trim();
	const port = stringField(args, "port").trim();
	if (sessionId !== "") {
		const hardware = getSerialHub().sessionTouchesHardware(sessionId);
		return hardware === false ? "read" : "exec";
	}
	if (port !== "" && isFixturePort(port) && !isRttHardwarePort(port)) return "read";
	if (port === "" && envRequestsFixture()) return "read";
	return "exec";
}

/**
 * Opening a fixture or a host UART stays read-tier, matching the UART cut.
 * Connecting OpenOCD (`rtt://`) is exec because it attaches to hardware.
 */
export function serialOpenApproval(args: unknown): ApprovalTier {
	const port = stringField(args, "port").trim();
	if (isRttHardwarePort(port)) return "exec";
	return "read";
}

export const SERIAL_TOOL_APPROVAL = {
	serial_list: "read",
	serial_open: serialOpenApproval,
	serial_read: "read",
	serial_write: "exec",
	serial_probe: serialProbeApproval,
} as const;

function textResult(text: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function fail<T>(result: Extract<SerialResult<T>, { ok: false }>) {
	return textResult(result.error, result.details ?? { error: result.error }, true);
}

function formatOpen(value: OpenedSession): string {
	const parts = [`session ${value.sessionId}`, `port ${value.port}`, `backend ${value.backend}`];
	if (value.baud !== undefined) parts.push(`baud ${value.baud}`);
	if (value.lineCount !== undefined) parts.push(`lines ${value.lineCount}`);
	return parts.join(" ");
}

function formatRead(value: ReadChunk): string {
	const body = value.text.length > 0 ? value.text : "(no new lines)";
	return `session ${value.sessionId} port ${value.port} backend ${value.backend} offset ${value.offset} eof ${value.eof}\n${body}`;
}

function formatWrite(value: WriteAck): string {
	const head = `session ${value.sessionId} port ${value.port} backend ${value.backend} wrote ${value.bytes} bytes`;
	return value.echoed !== undefined ? `${head}\necho: ${value.echoed}` : head;
}

function formatProbe(value: ProbeReport): string {
	return JSON.stringify(value, null, 2);
}

function stringField(args: unknown, key: string): string {
	if (!args || typeof args !== "object" || !(key in args)) return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

const factory = (omp: ToolHost): SerialTool[] => {
	const z = omp.zod;
	const hub = () => getSerialHub();

	const list: SerialTool = {
		name: "serial_list",
		label: "Serial list",
		description:
			"List BenchLog serial ports. Always includes fixture://firmware-boot (UART boot log) and fixture://rtt-sample (SEGGER RTT log, no board). Also lists host UARTs when Python 3 and pyserial can enumerate them (COM ports, /dev/ttyACM*, /dev/ttyUSB*, cu.*), and rtt://stlink-N when both OpenOCD and an ST-LINK USB device are visible. A missing Python install or a missing OpenOCD binary does not hide the fixture ports. UART install: python3 -m pip install -r .omp/tools/serial/requirements.txt. RTT install: apt, dnf, pacman, or brew install openocd.",
		parameters: z.object({}),
		approval: SERIAL_TOOL_APPROVAL.serial_list,
		loadMode: "essential",
		strict: true,
		async execute() {
			const listed = await hub().list();
			const lines = listed.ports.map(port => `${port.id}  ${port.backend}  ${port.description}`);
			lines.push(`fixture default: ${listed.fixtureDefault ? "on" : "off"}`);
			if (listed.rttNote) lines.push(listed.rttNote);
			if (listed.uartError) lines.push(`uart enumeration: ${listed.uartError}`);
			else if (listed.skipped && listed.skipped > 0) {
				lines.push(
					`hid ${listed.skipped} host ports with no USB serial identity; pass the path to serial_open if you need one`,
				);
			}
			return textResult(lines.join("\n"), listed);
		},
	};

	const open: SerialTool = {
		name: "serial_open",
		label: "Serial open",
		description:
			"Open a BenchLog serial capture. Fixture ports and host UARTs are read-class. rtt:// ports are exec-class because they connect OpenOCD to an ST-LINK. Omit port when --fixture or BENCHLOG_SERIAL_FIXTURE=1 is set to open fixture://firmware-boot. fixture://rtt-sample opens the RTT sample with no OpenOCD. A host path such as /dev/ttyACM0 or COM3 opens a UART through pyserial at baud (default 115200, 8N1). rtt://stlink-0 spawns OpenOCD; rtt://openocd attaches to BENCHLOG_RTT_ATTACH. serial_flash and serial_reset are not implemented.",
		parameters: z.object({
			port: z
				.string()
				.optional()
				.describe(
					"fixture://firmware-boot, fixture://rtt-sample, rtt://stlink-0, rtt://openocd, or a host UART path such as /dev/ttyACM0 or COM3.",
				),
			fixture: z.boolean().optional().describe("When true and port is omitted, open the UART fixture boot log."),
			baud: z
				.number()
				.optional()
				.describe("Baud for a host UART. Default 115200. Ignored for fixture and rtt ports."),
			target: z
				.string()
				.optional()
				.describe("OpenOCD target config for rtt:// hardware, such as stm32f4x.cfg. Ignored for fixture and UART."),
			rttSearch: z
				.string()
				.optional()
				.describe(
					"RTT control-block search window address:size, such as 0x20000000:0x20000. Ignored unless the port is rtt://.",
				),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_open,
		loadMode: "essential",
		strict: true,
		formatApprovalDetails(args) {
			const port = stringField(args, "port");
			return [`port: ${port || "(default)"}`, `target: ${stringField(args, "target") || "(default)"}`];
		},
		async execute(_toolCallId, params) {
			const port = typeof params.port === "string" ? params.port : undefined;
			const fixture = typeof params.fixture === "boolean" ? params.fixture : undefined;
			const baud = typeof params.baud === "number" ? params.baud : undefined;
			const target = typeof params.target === "string" ? params.target : undefined;
			const rttSearch = typeof params.rttSearch === "string" ? params.rttSearch : undefined;
			const opened = await hub().open({ port, fixture, baud, target, rttSearch });
			if (!opened.ok) return fail(opened);
			return textResult(formatOpen(opened.value), opened.value);
		},
		onSession(event) {
			if (event.reason === "shutdown") resetSerialHub();
		},
	};

	const read: SerialTool = {
		name: "serial_read",
		label: "Serial read",
		description:
			"Read the next lines from an open BenchLog serial session. Read-class: omp auto-approves this tier, including an already open RTT session. Defaults to 20 lines. Works for both fixtures, a host UART, and an OpenOCD RTT channel. A quiet port returns no new lines. Does not write to the port.",
		parameters: z.object({
			sessionId: z.string().describe("Session id returned by serial_open."),
			maxLines: z.number().optional().describe("Maximum lines to return (1-200, default 20)."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_read,
		loadMode: "essential",
		strict: true,
		async execute(_toolCallId, params) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
			const maxLines = typeof params.maxLines === "number" ? params.maxLines : undefined;
			const chunk = await hub().read({ sessionId, maxLines });
			if (!chunk.ok) return fail(chunk);
			return textResult(formatRead(chunk.value), chunk.value);
		},
	};

	const write: SerialTool = {
		name: "serial_write",
		label: "Serial write",
		description:
			"Write bytes to an open BenchLog serial session. Exec-class: omp prompts in always-ask and write approval modes, and auto-approves in yolo (the schema default). Fixture UART and fixture RTT append the payload and an ack. A host UART write sends the bytes through pyserial. An RTT write sends them on the OpenOCD RTT TCP channel. It does not flash or reset a board.",
		parameters: z.object({
			sessionId: z.string().describe("Session id returned by serial_open."),
			data: z.string().describe("Bytes to write. A trailing newline is optional and is not added for you."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_write,
		loadMode: "essential",
		strict: true,
		formatApprovalDetails(args) {
			const data = stringField(args, "data");
			const preview = data.length > 120 ? `${data.slice(0, 120)}…` : data;
			return [`session: ${stringField(args, "sessionId")}`, `data: ${preview}`];
		},
		async execute(_toolCallId, params) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
			const data = typeof params.data === "string" ? params.data : undefined;
			const wrote = await hub().write({ sessionId, data });
			if (!wrote.ok) return fail(wrote);
			return textResult(formatWrite(wrote.value), wrote.value);
		},
	};

	const probe: SerialTool = {
		name: "serial_probe",
		label: "Serial probe",
		description:
			"Inspect a BenchLog port after serial_open, or by port path. UART results include USB identity, explicit unknowns, a baud hint, and a short sniff (AT, ASCII boot, ASCII, mixed, or binary). RTT results include chip, adapter, RTT buffer names and sizes, and the same unknowns list. Fixture sessions and fixture:// ports are read-class. A host UART probe and an rtt:// probe are exec-class because they touch hardware. Python 3 and pyserial are required for host UARTs. OpenOCD is required for rtt://. serial_flash and serial_reset are not part of this tool.",
		parameters: z.object({
			sessionId: z.string().optional().describe("Open session from serial_open. Preferred when already connected."),
			port: z
				.string()
				.optional()
				.describe("fixture://firmware-boot, fixture://rtt-sample, rtt://stlink-0, or a host UART path."),
			baud: z
				.number()
				.optional()
				.describe("Baud when probing a host UART that is not already open. Default 115200. Ignored for RTT."),
			target: z
				.string()
				.optional()
				.describe("OpenOCD target config when probing an rtt:// port that is not already open."),
			rttSearch: z
				.string()
				.optional()
				.describe("RTT search window address:size when probing an rtt:// port that is not already open."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_probe,
		loadMode: "essential",
		strict: true,
		formatApprovalDetails(args) {
			const sessionId = stringField(args, "sessionId");
			const port = stringField(args, "port");
			return [`session: ${sessionId || "(none)"}`, `port: ${port || "(session or fixture default)"}`];
		},
		async execute(_toolCallId, params) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
			const port = typeof params.port === "string" ? params.port : undefined;
			const baud = typeof params.baud === "number" ? params.baud : undefined;
			const target = typeof params.target === "string" ? params.target : undefined;
			const rttSearch = typeof params.rttSearch === "string" ? params.rttSearch : undefined;
			const probed = await hub().probe({ sessionId, port, baud, target, rttSearch });
			if (!probed.ok) return fail(probed);
			return textResult(formatProbe(probed.value), probed.value);
		},
	};

	return [list, open, read, write, probe];
};

export default factory;
