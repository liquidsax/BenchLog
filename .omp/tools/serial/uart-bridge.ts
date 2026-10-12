/**
 * Long-lived Python helper for host UART.
 *
 * Fixture sessions do not start this process. One JSON object per line, in and
 * out. The helper is `uart.py` next to this file and needs Python 3 + pyserial.
 */
import { Buffer } from "node:buffer";

const HELPER_PATH = `${import.meta.dir}/uart.py`;

export const PYTHON_INSTALL_HINT =
	"Install Python 3 and pyserial with: python3 -m pip install -r .omp/tools/serial/requirements.txt";

export interface HostPortMeta {
	device: string;
	description: string | null;
	manufacturer: string | null;
	product: string | null;
	serialNumber: string | null;
	vid: string | null;
	pid: string | null;
	hwid: string | null;
	location: string | null;
	interface: string | null;
}

export interface UartRuntime {
	python: string;
	pyserial: string | null;
}

export type BridgeFailure = {
	ok: false;
	error: string;
	code: string;
	meta?: HostPortMeta;
};

export type ListedHosts = { ok: true; ports: HostPortMeta[]; skipped: number; runtime: UartRuntime } | BridgeFailure;

export type OpenedHandle =
	| { ok: true; handle: string; port: string; baud: number; runtime: UartRuntime }
	| BridgeFailure;

export type ReadBytes = { ok: true; lines: string[]; raw: Uint8Array } | BridgeFailure;

export type WroteBytes = { ok: true; bytes: number } | BridgeFailure;

export type ProbedPort =
	| {
			ok: true;
			openedTemp: boolean;
			port: string;
			baud: number;
			lines: string[];
			raw: Uint8Array;
			meta: HostPortMeta;
			runtime: UartRuntime;
	  }
	| BridgeFailure;

type LineEvent = { type: "line"; line: string } | { type: "eof" } | { type: "timeout" };
type LineWaiter = (event: LineEvent) => void;

interface HelperChild {
	stdin: Bun.FileSink;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	kill: (signal?: NodeJS.Signals) => void;
	exitCode: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function rawField(record: Record<string, unknown>): string | undefined {
	const value = record.raw;
	return typeof value === "string" ? value : undefined;
}

function childEnv(): Record<string, string> {
	const env: Record<string, string> = { PYTHONUNBUFFERED: "1" };
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

export function resolvePython(): string | null {
	const override = process.env.BENCHLOG_SERIAL_PYTHON;
	if (typeof override === "string" && override.trim() !== "") return override.trim();
	return Bun.which("python3") ?? Bun.which("python");
}

function asMeta(value: unknown, fallbackPort: string): HostPortMeta {
	const record = isRecord(value) ? value : {};
	return {
		device: textField(record, "device") ?? fallbackPort,
		description: textField(record, "description"),
		manufacturer: textField(record, "manufacturer"),
		product: textField(record, "product"),
		serialNumber: textField(record, "serialNumber"),
		vid: textField(record, "vid"),
		pid: textField(record, "pid"),
		hwid: textField(record, "hwid"),
		location: textField(record, "location"),
		interface: textField(record, "interface"),
	};
}

function asPort(value: unknown): HostPortMeta | undefined {
	if (!isRecord(value)) return undefined;
	const device = textField(value, "device");
	if (!device) return undefined;
	return asMeta(value, device);
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
	return value;
}

function failure(code: string, error: string, meta?: HostPortMeta): BridgeFailure {
	return meta ? { ok: false, code, error, meta } : { ok: false, code, error };
}

const liveHelpers = new Set<Bun.Subprocess>();
let exitHooked = false;

function trackHelper(proc: Bun.Subprocess): void {
	liveHelpers.add(proc);
	// A one-shot script (the fixture demo) must be able to exit after the last
	// tool call. omp itself stays up for the session. The exit hook closes any
	// helper that outlives the process so a host port is not left open.
	proc.unref();
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", () => {
		for (const child of liveHelpers) {
			try {
				child.kill("SIGKILL");
			} catch {
				// The helper already exited.
			}
		}
	});
}

function asChild(proc: Bun.Subprocess): HelperChild | undefined {
	const stdin = proc.stdin;
	const stdout = proc.stdout;
	const stderr = proc.stderr;
	if (
		stdin == null ||
		typeof stdin === "number" ||
		stdout == null ||
		typeof stdout === "number" ||
		stderr == null ||
		typeof stderr === "number"
	) {
		return undefined;
	}
	return {
		stdin,
		stdout,
		stderr,
		kill: signal => {
			proc.kill(signal);
		},
		get exitCode() {
			return proc.exitCode;
		},
	};
}

/**
 * One pyserial helper process. Requests are serialized. A timeout or a crash
 * kills the process so the next call starts a fresh one; open handles on the
 * old process are gone.
 */
export class UartBridge {
	#chain: Promise<void> = Promise.resolve();
	#proc: Bun.Subprocess | undefined;
	#child: HelperChild | undefined;
	#generation = 0;
	#lines: string[] = [];
	#waiters: LineWaiter[] = [];
	#eof = false;
	#disposed = false;
	#stderr = "";
	#nextId = 0;
	#runtime: UartRuntime | undefined;
	#pyserial = false;

	runtime(): UartRuntime | undefined {
		return this.#runtime;
	}

	dispose(): void {
		this.#disposed = true;
		this.#stop();
	}

	list(): Promise<ListedHosts> {
		return this.#exclusive(() => this.#list());
	}

	open(port: string, baud: number): Promise<OpenedHandle> {
		return this.#exclusive(() => this.#open(port, baud));
	}

	read(handle: string, maxLines: number, timeoutMs: number): Promise<ReadBytes> {
		return this.#exclusive(() => this.#read(handle, maxLines, timeoutMs));
	}

	write(handle: string, data: string): Promise<WroteBytes> {
		return this.#exclusive(() => this.#write(handle, data));
	}

	probe(input: { handle?: string; port?: string; baud?: number; sniffMs: number }): Promise<ProbedPort> {
		return this.#exclusive(() => this.#probe(input));
	}

	async #exclusive<T>(body: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(body, body);
		this.#chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #list(): Promise<ListedHosts> {
		const ready = await this.#ensure();
		if (!ready.ok) return ready;
		if (!this.#pyserial || !this.#runtime) {
			return failure("pyserial-missing", `pyserial is not installed. ${PYTHON_INSTALL_HINT}`);
		}
		const response = await this.#roundTrip({ op: "list" }, 5000);
		if (!response.ok) return response;
		const record = response.record;
		const ports: HostPortMeta[] = [];
		if (Array.isArray(record.ports)) {
			for (const entry of record.ports) {
				const port = asPort(entry);
				if (port) ports.push(port);
			}
		}
		const skipped = typeof record.skipped === "number" && Number.isFinite(record.skipped) ? record.skipped : 0;
		return { ok: true, ports, skipped, runtime: this.#runtime };
	}

	async #open(port: string, baud: number): Promise<OpenedHandle> {
		const ready = await this.#ensure();
		if (!ready.ok) return ready;
		if (!this.#pyserial || !this.#runtime) {
			return failure("pyserial-missing", `pyserial is not installed. ${PYTHON_INSTALL_HINT}`);
		}
		const response = await this.#roundTrip({ op: "open", port, baud }, 5000);
		if (!response.ok) return response;
		const handle = textField(response.record, "handle");
		const openedPort = textField(response.record, "port") ?? port;
		const openedBaud = response.record.baud;
		if (!handle || typeof openedBaud !== "number") {
			return failure("protocol", "UART helper open response was missing a handle.");
		}
		return { ok: true, handle, port: openedPort, baud: openedBaud, runtime: this.#runtime };
	}

	async #read(handle: string, maxLines: number, timeoutMs: number): Promise<ReadBytes> {
		const ready = await this.#ensure();
		if (!ready.ok) return ready;
		const response = await this.#roundTrip({ op: "read", handle, maxLines, timeoutMs }, timeoutMs + 1500);
		if (!response.ok) return response;
		const lines = stringList(response.record.lines);
		const raw = rawField(response.record);
		if (!lines || raw === undefined) return failure("protocol", "UART helper read response was missing lines.");
		return { ok: true, lines, raw: new Uint8Array(Buffer.from(raw, "base64")) };
	}

	async #write(handle: string, data: string): Promise<WroteBytes> {
		const ready = await this.#ensure();
		if (!ready.ok) return ready;
		const response = await this.#roundTrip({ op: "write", handle, data }, 4000);
		if (!response.ok) return response;
		const bytes = response.record.bytes;
		if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
			return failure("protocol", "UART helper write response was missing a byte count.");
		}
		return { ok: true, bytes };
	}

	async #probe(input: { handle?: string; port?: string; baud?: number; sniffMs: number }): Promise<ProbedPort> {
		const ready = await this.#ensure();
		if (!ready.ok) return ready;
		if (!this.#pyserial || !this.#runtime) {
			return failure("pyserial-missing", `pyserial is not installed. ${PYTHON_INSTALL_HINT}`);
		}
		const response = await this.#roundTrip(
			{
				op: "probe",
				...(input.handle ? { handle: input.handle } : {}),
				...(input.port ? { port: input.port } : {}),
				...(input.baud !== undefined ? { baud: input.baud } : {}),
				sniffMs: input.sniffMs,
			},
			input.sniffMs + 3000,
		);
		if (!response.ok) return response;
		const lines = stringList(response.record.lines);
		const raw = rawField(response.record);
		const port = textField(response.record, "port");
		const baud = response.record.baud;
		if (!lines || raw === undefined || !port || typeof baud !== "number") {
			return failure(
				"protocol",
				"UART helper probe response was incomplete.",
				asMeta(response.record.meta, input.port ?? ""),
			);
		}
		return {
			ok: true,
			openedTemp: response.record.openedTemp === true,
			port,
			baud,
			lines,
			raw: new Uint8Array(Buffer.from(raw, "base64")),
			meta: asMeta(response.record.meta, port),
			runtime: this.#runtime,
		};
	}

	async #ensure(): Promise<{ ok: true } | BridgeFailure> {
		if (this.#disposed) return failure("closed", "UART helper is closed.");
		if (this.#child && this.#child.exitCode === null && this.#runtime) return { ok: true };
		const python = resolvePython();
		if (!python) {
			return failure("python-missing", `Python 3 is required for host UART. ${PYTHON_INSTALL_HINT}`);
		}
		const spawned = this.#spawn(python);
		if (!spawned.ok) return spawned;
		const ping = await this.#roundTrip({ op: "ping" }, 3000);
		if (!ping.ok) {
			this.#stop();
			return ping;
		}
		const version = textField(ping.record, "python") ?? python;
		const pyserialVersion = textField(ping.record, "pyserialVersion");
		this.#pyserial = ping.record.pyserial === true;
		this.#runtime = { python: version, pyserial: pyserialVersion };
		return { ok: true };
	}

	#spawn(python: string): { ok: true } | BridgeFailure {
		this.#stop();
		this.#eof = false;
		this.#lines = [];
		this.#stderr = "";
		const generation = this.#generation;
		let proc: Bun.Subprocess;
		try {
			proc = Bun.spawn([python, "-u", HELPER_PATH], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv(),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return failure("python-missing", `Could not start ${python}: ${message}. ${PYTHON_INSTALL_HINT}`);
		}
		const child = asChild(proc);
		if (!child) {
			proc.kill("SIGKILL");
			return failure("protocol", "UART helper pipes were not available.");
		}
		trackHelper(proc);
		this.#proc = proc;
		this.#child = child;
		void this.#pumpStdout(child.stdout, generation);
		void this.#pumpStderr(child.stderr, generation);
		return { ok: true };
	}

	async #roundTrip(
		body: Record<string, unknown>,
		timeoutMs: number,
	): Promise<{ ok: true; record: Record<string, unknown> } | BridgeFailure> {
		const child = this.#child;
		if (!child || child.exitCode !== null) {
			return failure("exited", this.#exitError("UART helper is not running."));
		}
		const id = ++this.#nextId;
		const payload = `${JSON.stringify({ ...body, id })}\n`;
		try {
			const wrote = child.stdin.write(payload);
			if (wrote instanceof Promise) await wrote;
			await child.stdin.flush();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#stop();
			return failure("exited", this.#exitError(`UART helper write failed: ${message}`));
		}
		const event = await this.#nextLine(timeoutMs);
		if (event.type === "timeout") {
			this.#stop();
			return failure("timeout", `UART helper timed out after ${timeoutMs}ms.`);
		}
		if (event.type === "eof") {
			return failure("exited", this.#exitError("UART helper exited."));
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.line);
		} catch {
			this.#stop();
			return failure("protocol", `UART helper returned non-JSON: ${event.line.slice(0, 180)}`);
		}
		if (!isRecord(parsed)) {
			this.#stop();
			return failure("protocol", "UART helper returned a non-object.");
		}
		if (parsed.id !== id) {
			this.#stop();
			return failure("protocol", `UART helper response id ${String(parsed.id)} did not match ${id}.`);
		}
		if (parsed.ok !== true) {
			const error = textField(parsed, "error") ?? "UART helper failed";
			const code = textField(parsed, "code") ?? "helper";
			const meta = isRecord(parsed.meta) ? asMeta(parsed.meta, textField(parsed, "port") ?? "") : undefined;
			return failure(code, error, meta);
		}
		return { ok: true, record: parsed };
	}

	#exitError(fallback: string): string {
		const stderr = this.#stderr.trim();
		if (stderr === "") return fallback;
		return `${fallback} ${stderr.slice(-500)}`;
	}

	#stop(): void {
		this.#generation++;
		const proc = this.#proc;
		const child = this.#child;
		this.#proc = undefined;
		this.#child = undefined;
		if (proc) liveHelpers.delete(proc);
		this.#runtime = undefined;
		this.#pyserial = false;
		this.#eof = true;
		this.#lines = [];
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const waiter of waiters) waiter({ type: "eof" });
		if (child && child.exitCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				// The helper already exited.
			}
		}
	}

	async #nextLine(timeoutMs: number): Promise<LineEvent> {
		if (this.#lines.length > 0) {
			const line = this.#lines.shift();
			if (line !== undefined) return { type: "line", line };
		}
		if (this.#eof) return { type: "eof" };
		const { promise, resolve } = Promise.withResolvers<LineEvent>();
		let settled = false;
		const finish = (event: LineEvent) => {
			if (settled) {
				if (event.type === "line") this.#lines.push(event.line);
				return;
			}
			settled = true;
			resolve(event);
		};
		const waiter: LineWaiter = event => {
			clearTimeout(timer);
			finish(event);
		};
		const timer = setTimeout(() => {
			const index = this.#waiters.indexOf(waiter);
			if (index >= 0) this.#waiters.splice(index, 1);
			finish({ type: "timeout" });
		}, timeoutMs);
		this.#waiters.push(waiter);
		return promise;
	}

	#pushLine(event: LineEvent, generation: number): void {
		if (generation !== this.#generation) return;
		if (event.type === "eof") {
			this.#eof = true;
			const waiter = this.#waiters.shift();
			if (waiter) waiter(event);
			return;
		}
		if (event.type !== "line") return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter(event);
		else this.#lines.push(event.line);
	}

	async #pumpStdout(stream: ReadableStream<Uint8Array>, generation: number): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (generation === this.#generation) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, "");
					buffer = buffer.slice(newline + 1);
					if (line.length > 0) this.#pushLine({ type: "line", line }, generation);
					newline = buffer.indexOf("\n");
				}
			}
		} catch {
			// The process was killed.
		} finally {
			this.#pushLine({ type: "eof" }, generation);
		}
	}

	async #pumpStderr(stream: ReadableStream<Uint8Array>, generation: number): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			while (generation === this.#generation) {
				const { value, done } = await reader.read();
				if (done) break;
				this.#stderr = `${this.#stderr}${decoder.decode(value, { stream: true })}`.slice(-4000);
			}
		} catch {
			// The process was killed.
		}
	}
}
