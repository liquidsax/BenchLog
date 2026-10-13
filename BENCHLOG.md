# BenchLog

BenchLog is a trimmed, specialized agent for **板端串口观测与诊断** (board-side UART observation and firmware-log diagnosis). It is built on top of [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT).

oh-my-pi is itself a fork of [Pi](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/mariozechner), maintained by [Stencil Labs](https://stencil.so). Copyright and the MIT terms stay in [`LICENSE`](./LICENSE). Third-party notices stay in [`THIRD-PARTY-NOTICES.txt`](./THIRD-PARTY-NOTICES.txt). Do not strip those files.

This repository is not a CozeBasedCLI continuation. These patterns are banned:

- XML toolcall
- fake SQLite audit
- non-resumable sessions
- Coze lock-in

## Product package

The publishable unit is this repository's root `package.json` (`name`: `benchlog`, bin: `benchlog`). `bun install` / `npm install` at the root installs `@oh-my-pi/pi-coding-agent` and does not install the mirrored `packages/*` workspace. That workspace manifest is preserved as `package.omp-workspace.json` (lockfile: `bun.omp-workspace.lock`) so it can be restored by hand. It is not what a product install runs.

```sh
git clone https://github.com/liquidsax/BenchLog.git
cd BenchLog
bun install
bun run benchlog
```

Registry install, once published:

```sh
bun install -g benchlog
npm install -g benchlog
```

`benchlog` resolves `@oh-my-pi/pi-coding-agent`'s `src/cli.ts` and runs it with Bun. A global install may also link an `omp` bin from that dependency. Use `benchlog`: it applies `--fixture` and loads the serial tools. Plain `omp` is the harness without those BenchLog wrappers.

### Cut from the default install

| Stack | Why it is absent |
| --- | --- |
| `@huggingface/transformers`, `@huggingface/tokenizers` | Local embedding / tiny-model weights. Not used for serial diagnosis. |
| `sherpa-onnx` and `sherpa-onnx-*` | Speech runtime. Not used. |
| `onnxruntime-node`, `onnxruntime-web`, `onnxruntime-common`, `fastembed` | ONNX / embedding natives pulled by the stacks above. |
| `lucide-react`, `react`, `react-dom` | Icon and React UI for the omp-stats dashboard. The coding-agent TUI does not import them. `benchlog stats` still uses the stats server entry; rebuilding that dashboard UI from source needs the real packages. |

When this repo is the install root, `overrides` point those names at `vendor/omitted-optional` (an empty package that throws if imported). `scripts/prune-heavy-optionals.js` runs on `postinstall` and deletes those real trees if a parent install did not apply overrides. It leaves a package in place when the top-level project, or any unrelated installed package, already depends on it, so installing BenchLog into an app does not delete that app's `react`.

Still installed, and why:

- `@oh-my-pi/pi-natives` plus one host leaf (`@oh-my-pi/pi-natives-linux-x64` on linux x64). The x64 leaf contains both baseline and modern `.node` builds; the loader chooses at runtime. Dropping one without changing the loader can make the agent fail on the other ISA, so both stay.
- `puppeteer-core` and `axe-core`, because the published coding-agent depends on them. BenchLog does not drive the browser tool. They are not optional in the harness, and replacing them would mean forking that package.
- OpenTelemetry API and OTLP exporter packages. They are ordinary harness dependencies and small next to `pi-natives`.

`bunfig.toml` does **not** set `optional = false`. That would also skip the `pi-natives` platform leaf. It does exempt the pinned `@oh-my-pi/*` packages from the 3-day minimum release age, because `18.10.1` is the harness this package depends on and a fresh publish can be younger than that window.

Check the footprint (clean temp install, current OS/CPU):

```sh
bun scripts/check-install-size.ts
```

The budget is 500 MiB (`500 * 1024 * 1024` bytes) of `node_modules`. linux x64 is the target. The script fails if the tree is over budget, if a real heavy package listed above is present, or if the `pi-natives` host leaf is missing. `--self` measures the checkout you already installed. CI runs the clean install (`.github/workflows/benchlog-product.yml`).

### Models and NVIDIA NIM

Model setup is the harness. For NVIDIA NIM export `NVIDIA_API_KEY` (NGC personal key). Provider id `nvidia` calls `https://integrate.api.nvidia.com/v1`. See [docs/providers.md](./docs/providers.md) for other provider environment variables. BenchLog does not add a second model catalog.

### How serial tools load

The tools remain [`.omp/tools/serial/`](./.omp/tools/serial/index.ts). omp discovers `<cwd>/.omp/tools/serial/index.ts` when that file exists, which is this repository.

From any other working directory, `benchlog` passes `--extension <package>/benchlog-ext`. That directory's `tools/serial/index.ts` re-exports the same factory. Fixture logs are resolved from the real module URL: `fixtures/firmware-boot.txt` and `.omp/tools/serial/fixtures/rtt-sample.txt`.

`benchlog --fixture` sets `BENCHLOG_SERIAL_FIXTURE=1` and does not pass `--fixture` through. Published `@oh-my-pi/pi-coding-agent@18.10.1` does not define that flag. The mirrored tree still has a small local `--fixture` addition under `packages/coding-agent/` from earlier BenchLog work. The product CLI does not depend on it, and this package does not publish that fork.

Host UART still needs Python 3 and pyserial. Hardware RTT still needs OpenOCD and an ST-LINK. See the tool table below.

## Import

BenchLog was an empty GitHub repository with a one-line placeholder commit. That placeholder was replaced by a push of oh-my-pi's default branch (`main`), so the original commits and their ids stay in this history. The imported tip was `22a6a8230656cc87b6e5903a3a366965da35eba9`.

GitHub will not show a "Forked from" badge. That is intentional. Later pulls use a local `upstream` remote, documented below.

Only the default branch was imported. Other upstream branches and tags were not pushed.

## Remotes

GitHub does not store extra remotes. After you clone BenchLog, `origin` is this repository. Add `upstream` yourself:

```sh
git clone https://github.com/liquidsax/BenchLog.git
cd BenchLog
git remote add upstream https://github.com/can1357/oh-my-pi.git
git fetch upstream
```

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `https://github.com/liquidsax/BenchLog.git` | BenchLog |
| `upstream` | `https://github.com/can1357/oh-my-pi.git` | oh-my-pi |

Pull new upstream `main` commits with:

```sh
git fetch upstream
git merge upstream/main
```

Until BenchLog commits diverge from the imported tip, that merge is a fast-forward.

## Architecture

This import does not rewrite the product. The map below is the oh-my-pi surface BenchLog keeps. Paths are the upstream locations.

### Session

Resumable sessions are the coding-agent session model in [`docs/session.md`](./docs/session.md): JSONL entries, `id` / `parentId`, and a leaf pointer. Orchestration is [`packages/coding-agent/src/session/session-manager.ts`](./packages/coding-agent/src/session/session-manager.ts), with persistence and load next to it (`session-persistence.ts`, `session-loader.ts`, `session-entries.ts`).

The turn loop is [`packages/agent/src/agent-loop.ts`](./packages/agent/src/agent-loop.ts).

[`packages/coding-agent/src/session/sql-session-storage.ts`](./packages/coding-agent/src/session/sql-session-storage.ts) is upstream's real SQL session backend (Postgres, MySQL, or SQLite). It is not an audit log bolted on beside the session.

### Tools

Built-in tools live in [`packages/coding-agent/src/tools/`](./packages/coding-agent/src/tools/) and are assembled from [`packages/coding-agent/src/tools/index.ts`](./packages/coding-agent/src/tools/index.ts). Extra tools plug into that same pipeline; see [`docs/custom-tools.md`](./docs/custom-tools.md).

### Approval

Tool approval policy is resolved in [`packages/coding-agent/src/tools/approval.ts`](./packages/coding-agent/src/tools/approval.ts). Modes and tiers are described in [`docs/approval-mode.md`](./docs/approval-mode.md). When an ACP client is connected, [`packages/coding-agent/src/session/acp-permission-gate.ts`](./packages/coding-agent/src/session/acp-permission-gate.ts) asks before `bash`, `edit`, `delete`, and `move`.

### MCP

MCP support is [`packages/coding-agent/src/mcp/`](./packages/coding-agent/src/mcp/): per-project `.mcp.json`, stdio and HTTP transports, and [`tool-bridge.ts`](./packages/coding-agent/src/mcp/tool-bridge.ts), which turns MCP tools into custom tools on the same execution path. See [`docs/mcp-protocol-transports.md`](./docs/mcp-protocol-transports.md) and [`docs/mcp-runtime-lifecycle.md`](./docs/mcp-runtime-lifecycle.md).

### UART tools

The first cut is a project custom tool at [`.omp/tools/serial/`](./.omp/tools/serial/index.ts). omp discovers it when the working directory is this repo. Parameters are JSON Schema from the host zod builder. There is no XML toolcall path.

| Tool | Approval tier | What it does |
| --- | --- | --- |
| `serial_list` | `read` | Lists `fixture://firmware-boot`, `fixture://rtt-sample`, host UARTs pyserial can enumerate (`COM*`, `/dev/ttyACM*`, `/dev/ttyUSB*`, `cu.*`), and `rtt://stlink-N` when OpenOCD and an ST-LINK are both visible. Backends are `"fixture"`, `"uart"`, and `"rtt"`. |
| `serial_open` | `read` for a fixture or host UART; `exec` for `rtt://` | Opens the UART fixture, the RTT fixture, a host UART at 115200 8N1 (`baud` overridable), or an OpenOCD RTT session. Returns `sessionId` and `backend`. |
| `serial_read` | `read` | Reads the next lines from that session, including an already open RTT channel. |
| `serial_write` | `exec` | Fixture: appends a payload and an ack. UART: writes through pyserial. RTT: writes the OpenOCD RTT TCP channel. |
| `serial_probe` | `read` for either fixture; `exec` for a host UART or `rtt://` | UART: USB identity, unknowns, baud hint, sniff. RTT: chip, adapter, RTT buffer names and sizes, unknowns. |

`serial_flash` and `serial_reset` are not implemented. An STM32 ST-LINK with no virtual COM port is not a UART (`No VCP:`). RTT is the path that uses that adapter: OpenOCD over SWD, not pyserial. A missing `openocd` binary is `OpenOCD missing:`. A search that does not find the SEGGER block is `No RTT control block:`.

The UART sample is [`fixtures/firmware-boot.txt`](./fixtures/firmware-boot.txt). The RTT sample is [`.omp/tools/serial/fixtures/rtt-sample.txt`](./.omp/tools/serial/fixtures/rtt-sample.txt). Neither needs a board. Host UART needs Python 3 and pyserial. [`uart.py`](./.omp/tools/serial/uart.py) is the helper; the TypeScript hub keeps the session. Hardware RTT needs OpenOCD (`apt`, `dnf`, `pacman`, or `brew install openocd`) and an ST-LINK. The command sequence is documented as a hypothesis in [`.omp/tools/serial/README.md`](./.omp/tools/serial/README.md).

```sh
python3 -m pip install -r .omp/tools/serial/requirements.txt
bun scripts/benchlog-serial-demo.ts --fixture
bun scripts/benchlog-serial-demo.ts --rtt
```

If a host port exists, the same demo can open it (it does not write):

```sh
bun scripts/benchlog-serial-demo.ts --port /dev/ttyACM0
```

`--fixture` on `omp` sets `BENCHLOG_SERIAL_FIXTURE=1` before the session starts. The same variable works without the flag. When it is set, `serial_open` and `serial_probe` with no port use `fixture://firmware-boot`. Passing that port id opens the UART fixture even if the flag is off. `fixture://rtt-sample` opens the RTT sample whether or not the flag is set; it does not replace the UART default. A host path such as `/dev/ttyACM0` or `COM3` opens a real UART. `rtt://stlink-0` spawns OpenOCD when an ST-LINK was listed. The fixture paths do not need Python or OpenOCD.

Approval is omp's existing resolver ([`docs/approval-mode.md`](./docs/approval-mode.md)), not a separate prompt:

| Mode | `serial_list` / `serial_read` / fixture or UART `serial_open` | fixture `serial_probe` | host UART `serial_probe`, `rtt://` open, `rtt://` probe | `serial_write` |
| --- | --- | --- | --- | --- |
| `always-ask` | allow | allow | prompt | prompt |
| `write` | allow | allow | prompt (`exec` is outside the write-tier auto-approve) | prompt |
| `yolo` (schema default) | allow | allow | allow | allow |

`--approval-mode always-ask` is the way to see the write, host-probe, or RTT-connect prompt. `--yolo` / `--auto-approve` allow them. A user `tools.approval.serial_write: deny` still denies, including in `yolo`. An unknown `serial_probe` session id fails closed to `exec`.
