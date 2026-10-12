# BenchLog serial tools

Project custom tools discovered from `.omp/tools/serial/` when omp's working directory is this repo. They do not modify the omp core.

| Tool | Approval | What it does |
| --- | --- | --- |
| `serial_list` | `read` | Fixture port plus host UARTs pyserial can enumerate |
| `serial_open` | `read` | Fixture log, or a host port at 115200 8N1 (baud overridable) |
| `serial_read` | `read` | Next lines from that session |
| `serial_write` | `exec` | Fixture ack, or bytes on the host UART |
| `serial_probe` | `read` for fixture, `exec` for a host UART | USB identity, explicit unknowns, baud hint, short sniff |

## Host UART

Python 3 and pyserial are required. The fixture path does not use them.

```sh
python3 -m pip install -r .omp/tools/serial/requirements.txt
```

`uart.py` is a JSON-lines helper. The TypeScript hub keeps the session. Optional override: `BENCHLOG_SERIAL_PYTHON=/path/to/python3`.

Host opens are 8N1. `serial_list` shows USB serial devices, `COM*`, `/dev/ttyACM*`, `/dev/ttyUSB*`, `/dev/ttyAMA*`, and `cu.*`. It hides motherboard `ttyS*` ports and Bluetooth callouts; pass those paths to `serial_open` if you need them.

An STM32 ST-LINK with no virtual COM port has nothing for this cut to open. RTT, SWD, OpenOCD, flash, and reset are not implemented.

## Fixture

`fixture://firmware-boot` replays `fixtures/firmware-boot.txt`. `BENCHLOG_SERIAL_FIXTURE=1` (what `omp --fixture` sets) makes `serial_open` and `serial_probe` default to that log when no port is given.

```sh
bun scripts/benchlog-serial-demo.ts --fixture
bun test ./.omp/tools/serial/serial.test.ts
```

The `./` prefix matters: `bun test` does not scan dot-directories unless the path is explicit. The test file covers the fixture, a missing interpreter, a missing device path, and a pty looped through pyserial.

If a real port exists:

```sh
bun scripts/benchlog-serial-demo.ts --port /dev/ttyACM0
```
