/**
 * In-process UART session for BenchLog's first cut.
 *
 * The fixture backend replays `fixtures/firmware-boot.txt`. It does not open a
 * host serial device. `serial_flash` and `serial_reset` are not implemented.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURE_PORT_ID = "fixture://firmware-boot";
export const SERIAL_FIXTURE_ENV = "BENCHLOG_SERIAL_FIXTURE";

const DEFAULT_MAX_LINES = 20;
const MAX_LINES_CAP = 200;
const MAX_WRITE_CHARS = 4096;

const BUNDLED_FIXTURE_URL = new URL("../../../fixtures/firmware-boot.txt", import.meta.url);

export interface ListedPort {
	id: string;
	backend: "fixture";
	description: string;
}

export interface OpenedSession {
	sessionId: string;
	port: string;
	backend: "fixture";
	lineCount: number;
}

export interface ReadChunk {
	sessionId: string;
	port: string;
	text: string;
	lineCount: number;
	offset: number;
	eof: boolean;
}

export interface WriteAck {
	sessionId: string;
	port: string;
	bytes: number;
	echoed: string;
}

export type SerialResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface Session {
	id: string;
	port: string;
	lines: string[];
	offset: number;
}

function fixtureLogText(): string {
	return readFileSync(fileURLToPath(BUNDLED_FIXTURE_URL), "utf8");
}

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

/**
 * Process-local serial sessions. Tools in one omp process share a hub so
 * `serial_open` and later `serial_read` / `serial_write` see the same capture.
 */
export class SerialHub {
	#sessions = new Map<string, Session>();
	#nextId = 1;
	readonly #fixtureText: string | undefined;

	constructor(fixtureText?: string) {
		this.#fixtureText = fixtureText;
	}

	reset(): void {
		this.#sessions.clear();
		this.#nextId = 1;
	}

	list(): { ports: ListedPort[]; fixtureDefault: boolean } {
		return {
			fixtureDefault: envRequestsFixture(),
			ports: [
				{
					id: FIXTURE_PORT_ID,
					backend: "fixture",
					description: "Sample firmware boot log shipped at fixtures/firmware-boot.txt",
				},
			],
		};
	}

	open(input: { port?: string; fixture?: boolean }): SerialResult<OpenedSession> {
		const requested = input.port?.trim() ?? "";
		if (requested !== "" && !isFixturePort(requested)) {
			return {
				ok: false,
				error:
					`Real UART open is not in this cut (requested ${JSON.stringify(requested)}). ` +
					`Open ${FIXTURE_PORT_ID}, or omit port with --fixture / ${SERIAL_FIXTURE_ENV}=1. ` +
					"serial_flash and serial_reset are not implemented.",
			};
		}
		if (requested === "") {
			const useFixture = input.fixture === true || (input.fixture !== false && envRequestsFixture());
			if (!useFixture) {
				return {
					ok: false,
					error:
						`No port given. Pass ${FIXTURE_PORT_ID}, or run with --fixture / ${SERIAL_FIXTURE_ENV}=1 ` +
						"so serial_open defaults to the fixture boot log.",
				};
			}
		}

		const existing = [...this.#sessions.values()].find(session => session.port === FIXTURE_PORT_ID);
		if (existing) {
			return { ok: true, value: this.#opened(existing) };
		}

		let text: string;
		try {
			text = this.#fixtureText ?? fixtureLogText();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Fixture log is unreadable: ${message}` };
		}
		const session: Session = {
			id: `ser-${this.#nextId++}`,
			port: FIXTURE_PORT_ID,
			lines: splitLines(text),
			offset: 0,
		};
		this.#sessions.set(session.id, session);
		return { ok: true, value: this.#opened(session) };
	}

	read(input: { sessionId?: string; maxLines?: number }): SerialResult<ReadChunk> {
		const session = this.#require(input.sessionId);
		if (!session.ok) return session;
		const maxLines = normalizeMaxLines(input.maxLines);
		if (!maxLines.ok) return maxLines;
		const start = session.value.offset;
		const slice = session.value.lines.slice(start, start + maxLines.value);
		session.value.offset = start + slice.length;
		const eof = session.value.offset >= session.value.lines.length;
		return {
			ok: true,
			value: {
				sessionId: session.value.id,
				port: session.value.port,
				text: slice.join("\n"),
				lineCount: slice.length,
				offset: session.value.offset,
				eof,
			},
		};
	}

	write(input: { sessionId?: string; data?: string }): SerialResult<WriteAck> {
		const session = this.#require(input.sessionId);
		if (!session.ok) return session;
		if (typeof input.data !== "string" || input.data.length === 0) {
			return { ok: false, error: "serial_write requires a non-empty data string." };
		}
		if (input.data.length > MAX_WRITE_CHARS) {
			return { ok: false, error: `serial_write data exceeds ${MAX_WRITE_CHARS} characters.` };
		}
		const echoed = input.data.endsWith("\n") ? input.data.slice(0, -1) : input.data;
		session.value.lines.push(`[fixture] tx: ${echoed}`, "[fixture] rx: ack");
		return {
			ok: true,
			value: {
				sessionId: session.value.id,
				port: session.value.port,
				bytes: Buffer.byteLength(input.data),
				echoed,
			},
		};
	}

	#opened(session: Session): OpenedSession {
		return {
			sessionId: session.id,
			port: session.port,
			backend: "fixture",
			lineCount: session.lines.length,
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

let sharedHub: SerialHub | undefined;

export function getSerialHub(): SerialHub {
	sharedHub ??= new SerialHub();
	return sharedHub;
}

/** Drop process-local sessions. Tests and session shutdown call this. */
export function resetSerialHub(): void {
	sharedHub = new SerialHub();
}
