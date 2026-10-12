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

### UART tool plan

oh-my-pi does not ship a UART or serial tool. The BenchLog addition, not implemented in this import, is one tool on the existing tool path:

- a module under `packages/coding-agent/src/tools/`, registered from `tools/index.ts`, or a custom-tool module as in `docs/custom-tools.md`
- open a board serial port, capture firmware-log output, and keep that capture inside the resumable session
- declare an approval policy through `tools/approval.ts` so opening the port and writing to the board stay gated
- diagnose the captured log with the session plus the existing read and grep tools

Baud rate, port naming, and the tool schema are not chosen yet.
