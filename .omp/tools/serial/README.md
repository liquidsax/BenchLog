# BenchLog serial tools

Project custom tools discovered from `.omp/tools/serial/` when omp's working directory is this repo. They do not modify the omp core.

| Tool | Approval | What it does |
| --- | --- | --- |
| `serial_list` | `read` | UART fixture, RTT fixture, host UARTs, and `rtt://stlink-N` when OpenOCD and an ST-LINK are both visible |
| `serial_open` | `read` for fixture and UART; `exec` for `rtt://` | Opens that port. `rtt://` starts or attaches OpenOCD |
| `serial_read` | `read` | Next lines from that session, including an already open RTT channel |
| `serial_write` | `exec` | Fixture ack, host UART bytes, or bytes on the RTT channel |
| `serial_probe` | `read` for either fixture; `exec` for a host UART or `rtt://` | USB or chip/adapter identity, RTT buffer names and sizes, explicit unknowns |

`serial_flash` and `serial_reset` are not implemented.

## Host UART

Python 3 and pyserial are required. The fixture paths do not use them.

```sh
python3 -m pip install -r .omp/tools/serial/requirements.txt
```

`uart.py` is a JSON-lines helper. The TypeScript hub keeps the session. Optional override: `BENCHLOG_SERIAL_PYTHON=/path/to/python3`.

Host opens are 8N1. `serial_list` shows USB serial devices, `COM*`, `/dev/ttyACM*`, `/dev/ttyUSB*`, `/dev/ttyAMA*`, and `cu.*`. It hides motherboard `ttyS*` ports and Bluetooth callouts; pass those paths to `serial_open` if you need them.

An STM32 ST-LINK with no virtual COM port is not a UART. That failure is `No VCP:`. It is not an OpenOCD install problem and not a missing RTT control block. Use the RTT backend below.

## Fixture

`fixture://firmware-boot` replays `fixtures/firmware-boot.txt`. `BENCHLOG_SERIAL_FIXTURE=1` (what `omp --fixture` sets) makes `serial_open` and `serial_probe` default to that UART log when no port is given.

`fixture://rtt-sample` replays `.omp/tools/serial/fixtures/rtt-sample.txt`. It is always listed. It does not become the default when `--fixture` is set; pass the port id.

```sh
bun scripts/benchlog-serial-demo.ts --fixture
bun scripts/benchlog-serial-demo.ts --rtt
bun test ./.omp/tools/serial/serial.test.ts
```

The `./` prefix matters: `bun test` does not scan dot-directories unless the path is explicit.

If a real UART exists:

```sh
bun scripts/benchlog-serial-demo.ts --port /dev/ttyACM0
```

## RTT / SWD

RTT does not need a virtual COM port. It needs OpenOCD on the host and an ST-LINK on USB (or the fixture port, which needs neither).

```sh
# Debian / Ubuntu
sudo apt install openocd
# Fedora
sudo dnf install openocd
# Arch
sudo pacman -S openocd
# macOS
brew install openocd
```

On Linux, install the udev rules shipped with OpenOCD so the ST-LINK node is writable. `serial_list` adds `rtt://stlink-0` only when `openocd` is on `PATH` (or `BENCHLOG_OPENOCD` points at a real file) and a USB device with ST VID `0483` and a known ST-LINK product id is visible. A CDC VCP such as `0483:5740` stays on the uart backend.

```sh
# spawn OpenOCD against the first detected ST-LINK (exec approval)
# serial_open port rtt://stlink-0
```

Optional environment:

| Variable | Default | Role |
| --- | --- | --- |
| `BENCHLOG_OPENOCD` | `openocd` on `PATH` | Binary. A path that does not exist is "OpenOCD missing", not a silent fallback |
| `BENCHLOG_RTT_INTERFACE` | `interface/stlink.cfg` | OpenOCD interface script |
| `BENCHLOG_RTT_TARGET` | `stm32f4x.cfg` | OpenOCD target script. This default is a guess |
| `BENCHLOG_RTT_SEARCH` | `0x20000000:0x20000` | Control-block search `address:size` |
| `BENCHLOG_RTT_ID` | `SEGGER RTT` | Control-block id string |
| `BENCHLOG_RTT_CHANNEL` | `0` | Channel index passed to `rtt server start` |
| `BENCHLOG_RTT_ATTACH` | unset | `host:port` Tcl, or `telnet://host:port`. Skips spawn and attaches to an already running OpenOCD |
| `BENCHLOG_RTT_SYSFS` | `/sys/bus/usb/devices` | USB sysfs root used to detect ST-LINK. Tests set this |

`serial_open` `target` and `rttSearch` override the target script and the search window for that call.

### OpenOCD wiring hypothesis

Discard this if a board needs a different sequence. The client does not flash and does not send `reset`.

Spawn:

```text
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg \
  -c "tcl port <free>" -c "telnet port disabled" -c "gdb port disabled" -c "init"
```

Then, on the Tcl RPC socket (commands and replies terminated by `0x1a`):

```text
rtt setup 0x20000000 131072 {SEGGER RTT}
resume
rtt start
rtt channels
rtt server start <port> 0
```

`rtt start` searches for the control block once. `rtt server start` is a different command: it opens the raw TCP bridge whose bytes `serial_read` and `serial_write` use. `resume` is best-effort so a core halted by `init` can reach `SEGGER_RTT_Init`. The 128KiB window is wider than the 2048-byte example in the OpenOCD manual because that window misses a block placed later in SRAM. Chip and adapter text come from `targets`, `flash banks`, and `adapter driver`.

`BENCHLOG_RTT_ATTACH=telnet://127.0.0.1:4444` sends the same commands to the telnet prompt instead of the Tcl socket. `rtt://openocd` is the attach port and requires `BENCHLOG_RTT_ATTACH`.

### Errors

| Label | Meaning |
| --- | --- |
| `No VCP:` | The path is a host UART and no virtual COM port opened. An ST-LINK without VCP is this case. |
| `OpenOCD missing:` | The `openocd` binary is absent, or nothing is listening on `BENCHLOG_RTT_ATTACH`. |
| `No ST-LINK:` | OpenOCD started but did not open a debug adapter. |
| `No RTT control block:` | OpenOCD is up and the adapter answered, but `rtt start` did not find the SEGGER block in the search window. |
