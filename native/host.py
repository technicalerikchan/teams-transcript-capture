"""Local-only Chromium Native Messaging writer; accepts two fixed destinations."""
import hashlib
import json
import os
from pathlib import Path
import struct
import sys

HOST_NAME = "com.teams_transcript_capture.writer"
MAX_MESSAGE = 8 * 1024 * 1024


def load_routes():
    config = json.loads(Path(__file__).with_name("routes.json").read_text())
    return {key: Path(config[key]).expanduser() for key in ("cdk", "tao")}


def destination(routes, route):
    if route not in ("cdk", "tao"):
        raise ValueError("Unknown route; choose CDK or Tao in the extension")
    folder = routes[route]
    # Do not silently create a disconnected OneDrive root if the mount is absent.
    if not folder.parent.is_dir():
        raise ValueError("OneDrive folder unavailable; start OneDrive and retry")
    if folder.is_symlink():
        raise ValueError("Transcript destination must not be a symlink")
    folder.mkdir(mode=0o700, exist_ok=True)
    return folder


def write_transcript(routes, msg):
    name, content = msg.get("name"), msg.get("content")
    if not isinstance(name, str) or not name.endswith(".md") or len(name.encode("utf-8")) > 240:
        raise ValueError("Invalid Markdown filename")
    if name in (".", "..") or any(c in name for c in '/\\:') or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("Filename may not contain paths or control characters")
    if not isinstance(content, str) or not content or len(content.encode("utf-8")) > MAX_MESSAGE // 2:
        raise ValueError("Empty or oversized transcript")
    folder = destination(routes, msg.get("route"))
    data = content.encode("utf-8")
    for number in range(1000):
        candidate = folder / (name if number == 0 else f"{Path(name).stem} ({number}).md")
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            # Idempotent retry, including worker shutdown after a successful write.
            if candidate.is_file() and not candidate.is_symlink() and candidate.read_bytes() == data:
                return candidate
            continue
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            candidate.unlink(missing_ok=True)
            raise
        try:
            (folder / "minutes").mkdir(mode=0o700, exist_ok=True)
        except OSError:
            pass  # transcript is already durably written
        return candidate
    raise ValueError("Too many filename collisions")


def handle(msg, routes):
    if not isinstance(msg, dict):
        raise ValueError("Expected an object")
    if msg.get("action") == "ping":
        return {"ok": True, "routes": {key: {"path": str(path), "available": path.parent.is_dir()} for key, path in routes.items()}}
    if msg.get("action") != "write":
        raise ValueError("Unsupported action")
    path = write_transcript(routes, msg)
    return {"ok": True, "route": msg["route"], "path": str(path), "sha256": hashlib.sha256(msg["content"].encode()).hexdigest()}


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            raise EOFError("Truncated native message")
        data.extend(chunk)
    return bytes(data)


def main():
    # Chromium supplies the caller origin. No arbitrary extension may use this host.
    allowed = json.loads(Path(__file__).with_name("allowed_origins.json").read_text())
    if len(sys.argv) < 2 or sys.argv[1] not in allowed:
        return 1
    routes = load_routes()
    while True:
        header = sys.stdin.buffer.read(4)
        if not header:
            return 0
        if len(header) != 4:
            return 1
        size = struct.unpack("<I", header)[0]
        if size > MAX_MESSAGE:
            return 1
        try:
            msg = json.loads(read_exact(sys.stdin.buffer, size))
            result = handle(msg, routes)
        except Exception as error:
            result = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        payload = json.dumps(result, ensure_ascii=False).encode("utf-8")
        sys.stdout.buffer.write(struct.pack("<I", len(payload)) + payload)
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    sys.exit(main())
