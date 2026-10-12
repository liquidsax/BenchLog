#!/usr/bin/env python3
"""Host UART helper for BenchLog.

The TypeScript tools spawn this process and speak one JSON object per line on
stdin and stdout. Fixture sessions never start it.

Requires Python 3 and pyserial:

    python3 -m pip install -r .omp/tools/serial/requirements.txt

RTT, SWD, OpenOCD, flash, and reset are out of scope. This process only
lists, opens, reads, writes, and sniffs host serial ports.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:  # pyserial is optional at import time so the error is structured
    serial = None
    list_ports = None

MAX_PENDING = 65536
PYSERIAL_HINT = (
    "pyserial is not installed. Install Python 3 and pyserial with: "
    "python3 -m pip install -r .omp/tools/serial/requirements.txt"
)

HANDLES: dict[str, dict[str, object]] = {}
NEXT_HANDLE = 1


def reply(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def clean(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if text == "" or text.lower() == "n/a":
        return None
    return text


def hex_id(value: object) -> str | None:
    if value is None:
        return None
    try:
        return f"0x{int(value):04x}"
    except (TypeError, ValueError):
        return None


def port_meta(info: object) -> dict[str, str | None]:
    return {
        "device": clean(getattr(info, "device", None)) or "",
        "description": clean(getattr(info, "description", None)),
        "manufacturer": clean(getattr(info, "manufacturer", None)),
        "product": clean(getattr(info, "product", None)),
        "serialNumber": clean(getattr(info, "serial_number", None)),
        "vid": hex_id(getattr(info, "vid", None)),
        "pid": hex_id(getattr(info, "pid", None)),
        "hwid": clean(getattr(info, "hwid", None)),
        "location": clean(getattr(info, "location", None)),
        "interface": clean(getattr(info, "interface", None)),
    }


def include_port(info: object) -> bool:
    """Host ports a BenchLog user can open: USB serial, COM, ttyACM/ttyUSB, cu.*.

    Motherboard ttyS* entries and Bluetooth callout ports are hidden. Callers
    can still open those paths explicitly.
    """
    device = clean(getattr(info, "device", None)) or ""
    name = device.replace("\\", "/").split("/")[-1]
    lowered = name.lower()
    description = (clean(getattr(info, "description", None)) or "").lower()
    blob = f"{lowered} {description}"
    if "bluetooth" in blob or "blth" in blob:
        return False
    if getattr(info, "vid", None) is not None:
        return True
    upper = name.upper()
    if len(upper) > 3 and upper.startswith("COM") and upper[3:].isdigit():
        return True
    if name.startswith(("ttyACM", "ttyUSB", "ttyAMA")):
        return True
    if lowered.startswith("cu."):
        return True
    if lowered.startswith("tty.") and any(token in lowered for token in ("usb", "uart", "serial", "modem", "slab", "wch")):
        return True
    return False


def pyserial_missing() -> dict[str, object] | None:
    if serial is None or list_ports is None:
        return {"ok": False, "code": "pyserial-missing", "error": PYSERIAL_HINT}
    return None


def lookup_meta(port: str) -> dict[str, str | None]:
    empty: dict[str, str | None] = {
        "device": port,
        "description": None,
        "manufacturer": None,
        "product": None,
        "serialNumber": None,
        "vid": None,
        "pid": None,
        "hwid": None,
        "location": None,
        "interface": None,
    }
    if list_ports is None:
        return empty
    try:
        infos = list(list_ports.comports())
    except Exception:
        return empty
    for info in infos:
        if getattr(info, "device", None) == port:
            return port_meta(info)
    return empty


def find_sep(pending: bytearray, start: int = 0) -> tuple[int, int] | None:
    index = start
    while index < len(pending):
        byte = pending[index]
        if byte == 10:
            return index, 1
        if byte == 13:
            if index + 1 >= len(pending):
                return None
            if pending[index + 1] == 10:
                return index, 2
            return index, 1
        index += 1
    return None


def take_lines(pending: bytearray, max_lines: int, flush_partial: bool) -> tuple[list[str], bytes]:
    lines: list[str] = []
    consumed = bytearray()
    while len(lines) < max_lines:
        found = find_sep(pending)
        if found is None:
            break
        cut, width = found
        raw = bytes(pending[:cut])
        taken = bytes(pending[: cut + width])
        del pending[: cut + width]
        consumed.extend(taken)
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        lines.append(raw.decode("utf-8", errors="replace"))
    if flush_partial and pending and len(lines) < max_lines:
        raw = bytes(pending)
        consumed.extend(raw)
        pending.clear()
        text = raw.decode("utf-8", errors="replace")
        if text.endswith("\r"):
            text = text[:-1]
        lines.append(text)
    return lines, bytes(consumed)


def open_port(path: str, baud: int) -> object:
    if serial is None:
        raise RuntimeError(PYSERIAL_HINT)
    port = serial.Serial()
    port.port = path
    port.baudrate = baud
    port.bytesize = serial.EIGHTBITS
    port.parity = serial.PARITY_NONE
    port.stopbits = serial.STOPBITS_ONE
    port.timeout = 0.05
    port.write_timeout = 1.0
    # Apply cleared modem lines at open so DTR does not reset boards that wire it to reset.
    # Setting them before open stores the flag; pyserial applies it once the fd exists.
    port.dtr = False
    port.rts = False
    try:
        port.exclusive = True
    except (AttributeError, ValueError):
        pass
    try:
        port.open()
    except serial.SerialException as exc:
        message = str(exc).lower()
        if "exclusive" not in message and "lock" not in message:
            raise
        port.exclusive = False
        port.open()
    return port


def read_slot(slot: dict[str, object], max_lines: int, timeout_ms: int, flush_partial: bool) -> tuple[list[str], bytes]:
    port = slot["ser"]
    pending = slot["pending"]
    if not isinstance(pending, bytearray):
        raise RuntimeError("serial buffer is missing")
    deadline = time.monotonic() + max(timeout_ms, 0) / 1000.0
    while time.monotonic() < deadline and len(pending) < MAX_PENDING:
        if _complete_lines(pending) >= max_lines:
            break
        try:
            waiting = port.in_waiting  # type: ignore[attr-defined]
            chunk = port.read(waiting if waiting else 1)  # type: ignore[attr-defined]
        except Exception as exc:
            raise serial.SerialException(str(exc)) from exc
        if chunk:
            pending.extend(chunk)
            continue
        if _complete_lines(pending) > 0:
            break
    return take_lines(pending, max_lines, flush_partial)


def _complete_lines(pending: bytearray) -> int:
    count = 0
    start = 0
    while True:
        found = find_sep(pending, start)
        if found is None:
            return count
        cut, width = found
        count += 1
        start = cut + width


def op_ping() -> dict[str, object]:
    version = None
    if serial is not None:
        version = getattr(serial, "VERSION", None)
    return {
        "ok": True,
        "pyserial": serial is not None and list_ports is not None,
        "pyserialVersion": version if isinstance(version, str) else None,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
    }


def op_list() -> dict[str, object]:
    missing = pyserial_missing()
    if missing is not None:
        return missing
    assert list_ports is not None
    try:
        infos = list(list_ports.comports())
    except Exception as exc:
        return {"ok": False, "code": "list-failed", "error": str(exc)}
    ports: list[dict[str, str | None]] = []
    skipped = 0
    for info in infos:
        if not include_port(info):
            skipped += 1
            continue
        ports.append(port_meta(info))
    return {"ok": True, "ports": ports, "skipped": skipped}


def op_open(req: dict[str, object]) -> dict[str, object]:
    global NEXT_HANDLE
    missing = pyserial_missing()
    if missing is not None:
        return missing
    port = req.get("port")
    if not isinstance(port, str) or port.strip() == "":
        return {"ok": False, "code": "bad-arg", "error": "port is required"}
    baud = req.get("baud", 115200)
    if not isinstance(baud, int) or isinstance(baud, bool):
        return {"ok": False, "code": "bad-arg", "error": "baud must be an integer"}
    path = port.strip()
    try:
        opened = open_port(path, baud)
    except Exception as exc:
        return {"ok": False, "code": "open-failed", "error": str(exc), "meta": lookup_meta(path)}
    handle = f"h{NEXT_HANDLE}"
    NEXT_HANDLE += 1
    HANDLES[handle] = {"ser": opened, "pending": bytearray(), "port": path, "baud": baud}
    return {"ok": True, "handle": handle, "port": path, "baud": baud}


def _slot(handle: object) -> tuple[dict[str, object] | None, dict[str, object] | None]:
    if not isinstance(handle, str) or handle not in HANDLES:
        return None, {"ok": False, "code": "bad-handle", "error": "unknown serial handle"}
    return HANDLES[handle], None


def op_read(req: dict[str, object]) -> dict[str, object]:
    slot, error = _slot(req.get("handle"))
    if error is not None or slot is None:
        return error or {"ok": False, "code": "bad-handle", "error": "unknown serial handle"}
    max_lines = req.get("maxLines", 20)
    timeout_ms = req.get("timeoutMs", 400)
    if not isinstance(max_lines, int) or isinstance(max_lines, bool) or max_lines < 1:
        return {"ok": False, "code": "bad-arg", "error": "maxLines must be a positive integer"}
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or timeout_ms < 0:
        return {"ok": False, "code": "bad-arg", "error": "timeoutMs must be a non-negative integer"}
    try:
        lines, raw = read_slot(slot, min(max_lines, 200), timeout_ms, True)
    except Exception as exc:
        return {"ok": False, "code": "io", "error": str(exc)}
    return {"ok": True, "lines": lines, "raw": base64.b64encode(raw).decode("ascii")}


def op_write(req: dict[str, object]) -> dict[str, object]:
    slot, error = _slot(req.get("handle"))
    if error is not None or slot is None:
        return error or {"ok": False, "code": "bad-handle", "error": "unknown serial handle"}
    data = req.get("data")
    if not isinstance(data, str) or data == "":
        return {"ok": False, "code": "bad-arg", "error": "data must be a non-empty string"}
    raw = data.encode("utf-8")
    port = slot["ser"]
    try:
        written = port.write(raw)  # type: ignore[attr-defined]
        port.flush()  # type: ignore[attr-defined]
    except Exception as exc:
        return {"ok": False, "code": "io", "error": str(exc)}
    nbytes = written if isinstance(written, int) else len(raw)
    return {"ok": True, "bytes": nbytes}


def op_close(req: dict[str, object]) -> dict[str, object]:
    handle = req.get("handle")
    if not isinstance(handle, str) or handle not in HANDLES:
        return {"ok": False, "code": "bad-handle", "error": "unknown serial handle"}
    slot = HANDLES.pop(handle)
    port = slot["ser"]
    try:
        port.close()  # type: ignore[attr-defined]
    except Exception as exc:
        return {"ok": False, "code": "io", "error": str(exc)}
    return {"ok": True}


def op_probe(req: dict[str, object]) -> dict[str, object]:
    handle = req.get("handle") if isinstance(req.get("handle"), str) else None
    port_name = req.get("port") if isinstance(req.get("port"), str) else None
    opened_temp = False
    if handle is None:
        opened = op_open(req)
        if opened.get("ok") is not True:
            if port_name and "meta" not in opened:
                opened["meta"] = lookup_meta(port_name)
            return opened
        handle = str(opened["handle"])
        opened_temp = True
        port_name = str(opened.get("port") or port_name or "")
    slot, error = _slot(handle)
    if error is not None or slot is None:
        return error or {"ok": False, "code": "bad-handle", "error": "unknown serial handle"}
    sniff_ms = req.get("sniffMs", 500)
    if not isinstance(sniff_ms, int) or isinstance(sniff_ms, bool) or sniff_ms < 0:
        sniff_ms = 500
    path = str(slot["port"])
    baud = slot["baud"] if isinstance(slot["baud"], int) else 115200
    try:
        lines, raw = read_slot(slot, 40, sniff_ms, True)
    except Exception as exc:
        if opened_temp:
            op_close({"handle": handle})
        return {"ok": False, "code": "io", "error": str(exc), "meta": lookup_meta(path)}
    if opened_temp:
        op_close({"handle": handle})
        returned_handle: str | None = None
    else:
        returned_handle = handle
    return {
        "ok": True,
        "handle": returned_handle,
        "openedTemp": opened_temp,
        "port": path,
        "baud": baud,
        "meta": lookup_meta(path),
        "lines": lines,
        "raw": base64.b64encode(raw).decode("ascii"),
    }


def op_shutdown() -> dict[str, object]:
    for handle in list(HANDLES):
        op_close({"handle": handle})
    return {"ok": True}


def dispatch(req: dict[str, object]) -> dict[str, object]:
    op = req.get("op")
    if op == "ping":
        return op_ping()
    if op == "list":
        return op_list()
    if op == "open":
        return op_open(req)
    if op == "read":
        return op_read(req)
    if op == "write":
        return op_write(req)
    if op == "close":
        return op_close(req)
    if op == "probe":
        return op_probe(req)
    if op == "shutdown":
        return op_shutdown()
    return {"ok": False, "code": "bad-op", "error": f"unknown op {op!r}"}


def serve() -> None:
    for line in sys.stdin:
        text = line.strip()
        if text == "":
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            reply({"id": None, "ok": False, "code": "bad-json", "error": "invalid JSON"})
            continue
        if not isinstance(parsed, dict):
            reply({"id": None, "ok": False, "code": "bad-json", "error": "request must be an object"})
            continue
        try:
            result = dispatch(parsed)
        except Exception as exc:
            result = {"ok": False, "code": "internal", "error": str(exc)}
        result["id"] = parsed.get("id")
        reply(result)
        if parsed.get("op") == "shutdown":
            return


class _FakePort:
    def __init__(self, device: str, description: str = "", vid: int | None = None) -> None:
        self.device = device
        self.description = description
        self.vid = vid
        self.pid = 0x5740 if vid is not None else None
        self.manufacturer = None
        self.product = None
        self.serial_number = None
        self.hwid = None
        self.location = None
        self.interface = None


def self_test() -> None:
    cases = [
        (_FakePort("/dev/ttyUSB0"), True),
        (_FakePort("/dev/ttyACM0", "ST-LINK"), True),
        (_FakePort("/dev/ttyAMA0"), True),
        (_FakePort("COM3"), True),
        (_FakePort("/dev/cu.usbmodem1101"), True),
        (_FakePort("/dev/tty.usbserial-1410"), True),
        (_FakePort("/dev/ttyS0"), False),
        (_FakePort("/dev/ttyS0", vid=0x0483), True),
        (_FakePort("/dev/cu.Bluetooth-Incoming-Port"), False),
        (_FakePort("/dev/cu.BLTH"), False),
        (_FakePort("/dev/tty.Bluetooth-Incoming-Port", "Bluetooth"), False),
    ]
    failures: list[str] = []
    for info, expected in cases:
        got = include_port(info)
        if got != expected:
            failures.append(f"{info.device} vid={info.vid}: expected {expected} got {got}")
    if failures:
        reply({"ok": False, "failures": failures})
        sys.exit(1)
    reply({"ok": True, "checked": len(cases)})


def pty_peer() -> None:
    """Hold a pseudo-terminal so tests can open the slave with pyserial.

    The first stdout line is {"path": "/dev/pts/N"}. Later stdin lines are
    written to the master (they appear as RX). Bytes read from the master are
    answered with b"ack:<line>\\n".
    """
    import pty
    import select

    master, slave = pty.openpty()
    path = os.ttyname(slave)
    sys.stdout.write(json.dumps({"path": path}) + "\n")
    sys.stdout.flush()
    os.set_blocking(master, False)
    os.set_blocking(sys.stdin.fileno(), False)
    incoming = b""
    stdin_buf = b""
    while True:
        readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.5)
        for fd in readable:
            if fd == sys.stdin.fileno():
                try:
                    chunk = os.read(fd, 4096)
                except BlockingIOError:
                    continue
                if chunk == b"":
                    return
                stdin_buf += chunk
                while b"\n" in stdin_buf:
                    line, stdin_buf = stdin_buf.split(b"\n", 1)
                    if line == b"quit":
                        return
                    os.write(master, line + b"\n")
            else:
                try:
                    data = os.read(master, 4096)
                except BlockingIOError:
                    continue
                if data == b"":
                    return
                incoming += data
                while True:
                    split_at = None
                    width = 1
                    for index, byte in enumerate(incoming):
                        if byte == 10:
                            split_at = index
                            width = 1
                            break
                        if byte == 13:
                            split_at = index
                            width = 2 if index + 1 < len(incoming) and incoming[index + 1] == 10 else 1
                            break
                    if split_at is None:
                        break
                    line = incoming[:split_at]
                    incoming = incoming[split_at + width :]
                    os.write(master, b"ack:" + line + b"\n")


def main() -> None:
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "--self-test":
            self_test()
            return
        if arg == "--pty-peer":
            pty_peer()
            return
        reply({"ok": False, "error": f"unknown argument {arg}"})
        sys.exit(2)
    serve()


if __name__ == "__main__":
    main()
