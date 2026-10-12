# BenchLog

BenchLog is a trimmed, specialized agent for **板端串口观测与诊断** (board-side UART observation and firmware-log diagnosis). It is built on top of [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT).

oh-my-pi is itself a fork of [Pi](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/mariozechner), maintained by [Stencil Labs](https://stencil.so). Copyright and the MIT terms stay in [`LICENSE`](./LICENSE). Third-party notices stay in [`THIRD-PARTY-NOTICES.txt`](./THIRD-PARTY-NOTICES.txt). Do not strip those files.

This repository is not a CozeBasedCLI continuation. These patterns are banned:

- XML toolcall
- fake SQLite audit
- non-resumable sessions
- Coze lock-in

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
| `serial_list` | `read` | Lists `fixture://firmware-boot`. Real host ports are not enumerated. |
| `serial_open` | `read` | Opens the fixture boot log. Auto-approved in every omp approval mode. |
| `serial_read` | `read` | Reads the next lines from that session. Auto-approved in every mode. |
| `serial_write` | `exec` | Appends a payload and a fixture ack. Prompts unless the mode allows `exec`. |

`serial_flash` and `serial_reset` are not implemented.

The sample capture is [`fixtures/firmware-boot.txt`](./fixtures/firmware-boot.txt). No board is required.

```sh
bun scripts/benchlog-serial-demo.ts --fixture
```

`--fixture` on `omp` sets `BENCHLOG_SERIAL_FIXTURE=1` before the session starts. The same variable works without the flag. When it is set, `serial_open` with no port opens `fixture://firmware-boot`. Passing that port id opens the fixture even if the flag is off. A real device path such as `/dev/ttyUSB0` is refused.

Approval is omp's existing resolver ([`docs/approval-mode.md`](./docs/approval-mode.md)), not a separate prompt:

| Mode | `serial_list` / `serial_open` / `serial_read` | `serial_write` |
| --- | --- | --- |
| `always-ask` | allow | prompt |
| `write` | allow | prompt (`exec` is outside the write-tier auto-approve) |
| `yolo` (schema default) | allow | allow |

`--approval-mode always-ask` is the way to see the write prompt. `--yolo` / `--auto-approve` allow the write. A user `tools.approval.serial_write: deny` still denies, including in `yolo`.
