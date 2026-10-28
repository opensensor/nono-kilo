#!/usr/bin/env python3
"""Exercise the actual sandbox and Kilo runtime without model credentials."""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSIONS = json.loads((ROOT / "versions.json").read_text())


def binary(variable, default):
    resolved = shutil.which(os.environ.get(variable, default))
    if not resolved:
        raise RuntimeError(f"install {default} or set {variable}")
    return str(Path(resolved).absolute())


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


class Harness:
    def __init__(self, directory, nono, kilo):
        self.directory = Path(directory)
        self.nono, self.kilo = nono, kilo
        self.project = self.directory / "project"
        for item in ("config/kilo", "project", "outside"):
            (self.directory / item).mkdir(parents=True, exist_ok=True)
        self.env = {key: os.environ[key] for key in ("HOME", "PATH", "USER", "LOGNAME", "LANG") if key in os.environ}
        self.env.update(
            TERM="xterm-256color",
            XDG_CONFIG_HOME=str(self.directory / "config"),
            XDG_DATA_HOME=str(self.directory / "data"),
            XDG_STATE_HOME=str(self.directory / "state"),
            XDG_CACHE_HOME=str(self.directory / "cache"),
            KILO_DISABLE_MODELS_FETCH="true",
            KILO_DISABLE_AUTOUPDATE="true",
            KILO_DISABLE_DEFAULT_PLUGINS="true",
            KILO_DISABLE_EXTERNAL_SKILLS="true",
            GH_TOKEN="must-not-reach-the-child",
            AWS_SECRET_ACCESS_KEY="must-not-reach-the-child",
            OPENSENSOR_TEST_SECRET="must-not-reach-the-child",
        )
        # Avoid reading a user's config. The dedicated dirs above contain no login data.
        (self.directory / "config/kilo/kilo.json").write_text(json.dumps({"autoupdate": False, "share": "disabled"}))
        (self.directory / "outside/private.txt").write_text("not-for-the-agent\n")
        subprocess.run(["bash", str(ROOT / "bin/nono-kilo.sh"), "--prepare-only"], cwd=self.project, env=self.env, check=True)
        self.base = [nono, "run", "--profile", str(ROOT / "policy.json"), "--allow-cwd"]

    def run(self, command, *, block_net=True, timeout=35):
        args = self.base + (["--block-net"] if block_net else []) + ["--"] + command
        result = subprocess.run(args, cwd=self.project, env=self.env, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f"command failed ({result.returncode}): {command[0]}\n{result.stdout}\n{result.stderr}")
        return result.stdout

    def boundaries(self):
        code = r'''
import errno, os, pathlib
outside = pathlib.Path(__import__('sys').argv[1])
assert "GH_TOKEN" not in os.environ
assert "AWS_SECRET_ACCESS_KEY" not in os.environ
assert "OPENSENSOR_TEST_SECRET" not in os.environ
pathlib.Path("workspace.txt").write_text("allowed")
assert pathlib.Path("workspace.txt").read_text() == "allowed"
state = pathlib.Path(os.environ["XDG_STATE_HOME"])
assert state.name == "opensensor-kilo"
(state / "probe.txt").write_text("state allowed")
cache = pathlib.Path(os.environ["TMPDIR"])
assert cache.name == "tmp"
(cache / "probe.txt").write_text("temp allowed")
for path, operation in ((outside / "private.txt", "read"), (outside / "escape.txt", "write")):
    try:
        path.read_text() if operation == "read" else path.write_text("escaped")
    except PermissionError:
        pass
    else:
        raise AssertionError(f"outside {operation} was allowed")
protected = pathlib.Path(os.environ["XDG_CONFIG_HOME"]) / "nono" / "profiles" / "escape.json"
try:
    protected.write_text("{}")
except PermissionError:
    pass
else:
    raise AssertionError("installed nono profiles were writable")
print("workspace/state/temp allowed; unrelated files, profile writes, and ambient secrets denied")
'''
        print(self.run(["python3", "-c", code, str(self.directory / "outside")]).strip(), flush=True)
        if (self.directory / "outside/escape.txt").exists():
            raise RuntimeError("sandbox wrote outside the workspace")

    def runtime(self):
        version = self.run([self.kilo, "--version"]).strip()
        if version != VERSIONS["kilo"]:
            raise RuntimeError(f"expected Kilo {VERSIONS['kilo']}, got {version}")
        output = self.run([self.kilo, "debug", "paths"])
        if str(self.directory / "state/opensensor-kilo/kilo") not in output:
            raise RuntimeError(f"Kilo did not use the isolated state path:\n{output}")
        print(f"Kilo {version}: startup and XDG path checks passed", flush=True)

    def server(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        args = self.base + ["--", self.kilo, "serve", "--hostname", "127.0.0.1", "--port", str(port)]
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen(args, cwd=self.project, env=self.env, stdout=output, stderr=output)
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline and process.poll() is None:
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/global/health", timeout=1) as response:
                            health = json.load(response)
                        if health.get("healthy") is True:
                            print("Kilo headless HTTP health check passed", flush=True)
                            return
                    except (OSError, ValueError):
                        pass
                    time.sleep(0.15)
                output.seek(0)
                raise RuntimeError("Kilo server failed to become healthy:\n" + output.read().decode(errors="replace"))
            finally:
                stop(process)

    def tui(self):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
        args = self.base + ["--startup-timeout", "25", "--", self.kilo]
        process = subprocess.Popen(args, cwd=self.project, env=self.env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()
        try:
            deadline = time.monotonic() + 30
            entered_at = None
            while time.monotonic() < deadline and process.poll() is None:
                if select.select([master], [], [], 0.2)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    output.extend(chunk)
                    # Answer the terminal's standard queries during headless PTY checks.
                    if b"\x1b[6n" in chunk:
                        os.write(master, b"\x1b[1;1R")
                    if b"\x1b[c" in chunk or b"\x1b[0c" in chunk:
                        os.write(master, b"\x1b[?1;2c")
                if b"\x1b[?1049h" in output and entered_at is None:
                    entered_at = time.monotonic()
                # Require a stable live screen, not just the first escape sequence.
                if entered_at and time.monotonic() - entered_at > 3 and len(output) > 2000:
                    if b"Failed to initialize OpenTUI" in output:
                        break
                    print("Kilo TUI entered and maintained alternate-screen mode", flush=True)
                    return
            text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
            raise RuntimeError("Kilo TUI startup failed:\n" + text[-4000:])
        finally:
            # HUP the PTY first; the supervisor then closes its child session.
            os.close(master)
            stop(process)


def main():
    nono, kilo = binary("NONO_BIN", "nono"), binary("KILO_BIN", "kilo")
    actual = subprocess.check_output([nono, "--version"], text=True).strip()
    if actual != "nono " + VERSIONS["nono"]:
        raise RuntimeError(f"expected nono {VERSIONS['nono']}, got {actual}")
    subprocess.run([nono, "profile", "validate", str(ROOT / "policy.json")], check=True)
    # /tmp can overlap nono's inherited system grants and is unsuitable for its state.
    with tempfile.TemporaryDirectory(prefix=".nono-kilo-smoke-", dir=Path.home()) as directory:
        harness = Harness(directory, nono, kilo)
        harness.boundaries()
        harness.runtime()
        harness.server()
        harness.tui()
    print("All sandbox and runtime smoke checks passed", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Smoke check failed: {error}", file=sys.stderr)
        sys.exit(1)
