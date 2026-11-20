"""The client: the same contract as ControlArmour's own hooks, in Python.

Licence: Apache-2.0.
"""

from __future__ import annotations

import contextlib
import functools
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

# Each check or wait call returns within about 90 s ("pending" while the
# person has not answered) and the client asks again, so a long approval never
# runs into a request timeout.
CHECK_WAIT_S = 110
MAX_APPROVAL_S = 1500
SHORT_S = 3
POST_S = 4
PAUSE_MAX_S = 100
PAUSE_POLL_S = 2

# ControlArmour listens on loopback; a developer's HTTP proxy (http_proxy in
# the shell or CI) must never sit in between, or a dead proxy would look like
# "nothing listens" while the core is on.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Blocked(Exception):
    """ControlArmour refused the action (or contact was lost mid-check)."""


class Stopped(Blocked):
    """The person stopped this agent from ControlArmour."""


def data_dir() -> Path:
    env = os.environ.get("CONTROLARMOUR_DATA_DIR")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "ControlArmour"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "ControlArmour"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "ControlArmour"


def read_endpoint() -> Optional[dict]:
    try:
        ep = json.loads((data_dir() / "endpoint.json").read_text("utf-8"))
        if ep.get("url") and ep.get("ingestToken"):
            return ep
    except Exception:  # noqa: BLE001 - not running
        pass
    return None


_UNSAFE = re.compile(r"[^A-Za-z0-9._:@-]")

_LANGUAGES = {
    "py": "python", "js": "javascript", "mjs": "javascript", "cjs": "javascript", "ts": "typescript", "tsx": "tsx", "jsx": "jsx",
    "go": "go", "rs": "rust", "java": "java", "kt": "kotlin", "rb": "ruby", "php": "php", "cs": "csharp", "c": "c", "h": "c",
    "cpp": "cpp", "cc": "cpp", "hpp": "cpp", "swift": "swift", "sh": "bash", "bash": "bash", "zsh": "bash", "ps1": "powershell",
    "sql": "sql", "html": "html", "css": "css", "scss": "scss", "json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml",
    "md": "markdown", "xml": "xml", "txt": "text",
}


def _lang(path: str) -> str:
    ext = Path(path).suffix.lstrip(".").lower()
    return _LANGUAGES.get(ext, ext)


def _sid(prefix: str, raw: str) -> str:
    return prefix + "-" + _UNSAFE.sub("_", raw or "unknown")[:100]


def _head(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "…"


def _tail(s: str, n: int) -> str:
    return s if len(s) <= n else "…" + s[-n:]


def _lines(s: str) -> int:
    if not s:
        return 0
    n = s.count("\n") + 1
    return n - 1 if s.endswith("\n") else n


class _Response:
    def __init__(self, status: int, body: Any, lost: bool = False):
        self.status, self.json, self.lost = status, body, lost

    def str(self, key: str) -> str:
        return self.json.get(key, "") if isinstance(self.json, dict) and isinstance(self.json.get(key), str) else ""


class ControlArmour:
    """One agent session. Create it once; it is safe to use from several threads.

    Instructions the person types in ControlArmour queue in ``messages()``;
    a framework adapter cannot usually hand them to the model, so call it
    yourself where your agent reads input.
    """

    def __init__(self, title: str = "", agent: str = "python", session_id: str = "", cwd: str = "", pid: int = 0):
        self._lock = threading.Lock()
        self._seq_acked = 0
        self._msg_seq = 0
        self._step = 0
        self._messages: list[str] = []
        self.sid = _sid("py", session_id or f"{os.getpid()}-{int(time.time())}")
        self.cwd = cwd or os.getcwd()
        self._title = title or f"{Path(self.cwd).name} ({agent})"
        self._agent, self._pid = agent, pid or os.getpid()
        self._ep: Optional[dict] = None
        self._connect(read_endpoint())

    def _connect(self, ep: Optional[dict]) -> None:
        """Adopt an endpoint and register the session with it."""
        if not ep:
            return
        self._ep = ep
        self.post([
            {"type": "session", "data": {"title": self._title, "agent": self._agent, "pid": self._pid, "cwd": self.cwd}},
            {"type": "status", "data": {"status": "running"}},
        ])

    # ---- transport
    @property
    def connected(self) -> bool:
        """True when ControlArmour was running the last time this session spoke to it."""
        return self._ep is not None

    def _request(self, method: str, path: str, body: Any = None, timeout: float = POST_S) -> _Response:
        if not self._ep:
            # ControlArmour may have started since: look again, once per call.
            ep = read_endpoint()
            if not ep:
                return _Response(0, None)
            self._connect(ep)
            if not self._ep:
                return _Response(0, None)
        r = self._send(method, path, body, timeout)
        if r.status == 0 and not r.lost:
            # Refused: the core may have restarted on another port.
            ep = read_endpoint()
            if ep and ep.get("url") != self._ep.get("url"):
                self._ep = ep
                r = self._send(method, path, body, timeout)
        return r

    def _send(self, method: str, path: str, body: Any, timeout: float) -> _Response:
        assert self._ep is not None
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self._ep["url"] + path, data=data, method=method,
                                     headers={"Authorization": "Bearer " + self._ep["ingestToken"], "Content-Type": "application/json"})
        try:
            with _opener.open(req, timeout=timeout) as r:  # noqa: S310 - loopback only
                raw = r.read()
                return _Response(r.status, json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            try:
                return _Response(e.code, json.loads(e.read() or b"null"))
            except Exception:  # noqa: BLE001
                return _Response(e.code, None)
        except urllib.error.URLError as e:
            # Nothing listens (refused) or no such host: not running. Anything
            # else (timeout, reset) is contact lost.
            refused = isinstance(getattr(e, "reason", None), (ConnectionRefusedError, socket.gaierror))
            return _Response(0, None, lost=not refused)
        except (ConnectionRefusedError, socket.gaierror):
            return _Response(0, None, lost=False)
        except Exception:  # noqa: BLE001 - timeout, reset: contact was made and lost
            return _Response(0, None, lost=True)

    def post(self, events: list[dict]) -> dict:
        """Send events; returns the current control (stop, pause, message)."""
        r = self._request("POST", f"/api/v1/agent/sessions/{self.sid}/events", events)
        control = r.json.get("control") if isinstance(r.json, dict) else None
        self._handle_control(control)
        return control or {}

    # ---- control from the person
    def _handle_control(self, control: Optional[dict]) -> None:
        if not isinstance(control, dict) or not isinstance(control.get("seq"), int):
            return
        seq = control["seq"]
        with self._lock:
            need_ack = seq > self._seq_acked
            if control.get("message") and seq > self._msg_seq:
                self._msg_seq = seq
                self._messages.append(str(control["message"]))
        if need_ack:
            text = "stopping" if control.get("stop") else "pausing" if control.get("pause") else "noted"
            r = self._request("POST", f"/api/v1/agent/sessions/{self.sid}/ack", {"seq": seq, "text": text}, SHORT_S)
            if 200 <= r.status < 300:
                with self._lock:
                    self._seq_acked = max(self._seq_acked, seq)

    def messages(self) -> list[str]:
        """Instructions the person sent since you last asked (each delivered once)."""
        with self._lock:
            out, self._messages = self._messages, []
            return out

    def _control(self) -> _Response:
        r = self._request("GET", f"/api/v1/agent/sessions/{self.sid}/control", None, SHORT_S)
        if r.status == 200 and isinstance(r.json, dict):
            self._handle_control(r.json)
        return r

    def control(self) -> dict:
        """The current control: {"stop": bool, "pause": bool, "message": str}."""
        r = self._control()
        return r.json if r.status == 200 and isinstance(r.json, dict) else {}

    def wait_if_paused(self, max_wait: float = PAUSE_MAX_S) -> None:
        """Honour Pause: block until resumed; raise Stopped on Stop. Losing
        the core while paused keeps the agent paused (fail closed)."""
        r = self._control()
        c = r.json if r.status == 200 and isinstance(r.json, dict) else {}
        if c.get("stop"):
            raise Stopped("the person stopped this agent")
        until = time.time() + max_wait
        while c.get("pause") and time.time() < until:
            time.sleep(PAUSE_POLL_S)
            r = self._control()
            if r.status == 402:
                return  # the licence lapsed: nothing is checked any more
            if r.status != 200 or not isinstance(r.json, dict):
                break  # still paused as far as we know
            c = r.json
            if c.get("stop"):
                raise Stopped("the person stopped this agent")
        if c.get("pause"):
            raise Blocked("this agent is paused by the person")

    # ---- what the agent reports
    def step(self, title: str, note: str = "") -> int:
        """Start a step (closes the previous one)."""
        with self._lock:
            prev, self._step = self._step, self._step + 1
            cur = self._step
        events: list[dict] = [{"type": "status", "data": {"status": "running"}}]
        if prev:
            events.append({"type": "step", "data": {"id": str(prev), "status": "done"}})
        events.append({"type": "step", "data": {"id": str(cur), "title": _head(" ".join(str(title).split()), 90) or "Step", "status": "running", "note": note}})
        self.post(events)
        return cur

    def file(self, path: str, action: str = "write", content: Optional[str] = None, lines: Optional[int] = None) -> None:
        """A file the agent read or changed. Content is for the live view only; ControlArmour never stores it."""
        d: dict[str, Any] = {"path": path, "action": action}
        if content is not None:
            d["lines"], d["bytes"] = _lines(content), len(content.encode("utf-8"))
        elif lines is not None:
            d["lines"] = lines
        events: list[dict] = [{"type": "file", "data": d}]
        if content is not None and action != "read" and len(content) <= 200_000:
            events.append({"type": "code", "data": {"path": path, "language": _lang(path), "content": content}})
        self.post(events)

    def command(self, cmd: str, exit_code: int = 0, output: str = "", cwd: str = "", kind: str = "shell", id: str = "") -> None:
        """A command the agent ran. The output is for the live view; ControlArmour stores its size."""
        d: dict[str, Any] = {"kind": kind, "cwd": cwd or self.cwd, "cmd": cmd, "exit": exit_code, "out": _tail(output, 4000),
                             "outBytes": len(output.encode("utf-8")), "outLines": _lines(output)}
        if id:
            d["id"] = id
        self.post([{"type": "command", "data": d}])

    def note(self, text: str, kind: str = "info") -> None:
        """kind: info, inference, confirmed, verify, question or warning."""
        self.post([{"type": "note", "data": {"kind": kind, "text": _head(text, 500)}}])

    def done(self, status: str = "done") -> None:
        """End the session: done, failed or stopped."""
        events: list[dict] = [{"type": "status", "data": {"status": status}}]
        with self._lock:
            if self._step:
                events.insert(0, {"type": "step", "data": {"id": str(self._step), "status": "done" if status == "done" else "failed"}})
        self.post(events)

    # ---- asking first
    def ask(self, tool: str, command: str = "", paths: Optional[list[str]] = None, text: str = "", summary: str = "", category: str = "") -> dict:
        """Ask ControlArmour before an action. Returns the decision; raises Blocked / Stopped.

        tool names are matched by ControlArmour's rules (delete, send, pay,
        fetch, write, read …); a shell command is analysed as such. A pending
        approval is waited for here, in ControlArmour, up to 25 minutes.
        """
        if not self._ep and not read_endpoint():
            return {"decision": "allow", "reason": "ControlArmour is not running"}
        self.wait_if_paused()
        paths = paths or []
        body = {"tool": tool, "command": command, "paths": paths, "text": _head(text, 4000), "cwd": self.cwd,
                "summary": summary or (f"{tool}: {_head(command, 160)}" if command else f"{tool}: {paths[0]}" if paths else tool)}
        if category:
            body["category"] = category
        r = self._request("POST", f"/api/v1/agent/sessions/{self.sid}/check", body, CHECK_WAIT_S)
        if r.status == 0 and not r.lost:
            return {"decision": "allow", "reason": "ControlArmour is not running"}
        if r.status == 0:
            raise Blocked("ControlArmour: lost contact while checking this action. Not allowed; try again.")
        if r.status != 200 or not r.str("decision"):
            # The check route answers 200 with allow and a licence reason after
            # a lapse (never 402), so anything else is looked into: is it
            # ControlArmour at all?
            h = self._request("GET", "/api/v1/health", None, SHORT_S)
            if h.status == 0 and h.lost:
                raise Blocked("ControlArmour: lost contact while checking this action. Not allowed; try again.")
            if not (h.status == 200 and h.str("app") == "controlarmour"):
                return {"decision": "allow", "reason": "something other than ControlArmour answers; not checking"}
            raise Blocked(f"ControlArmour: could not check this action: {r.str('error') or f'unexpected answer ({r.status})'}.")
        deadline = time.time() + MAX_APPROVAL_S
        while r.str("decision") == "pending" and r.str("approvalId"):
            if time.time() > deadline:
                raise Blocked("ControlArmour: nobody answered the approval request. Not allowed.")
            r = self._request("POST", f"/api/v1/agent/sessions/{self.sid}/approvals/{r.str('approvalId')}/wait", {}, CHECK_WAIT_S)
            if r.status == 402:
                return {"decision": "allow", "reason": "the licence has lapsed"}
            if r.status != 200 or not r.str("decision"):
                raise Blocked("ControlArmour: lost contact while waiting for the person's approval.")
        if r.str("decision") == "deny":
            raise Blocked(f"ControlArmour blocked this: {r.str('reason') or 'not allowed by the house rules'}. Explain to the person and choose a different approach.")
        if r.str("decision") != "allow":
            raise Blocked(f"ControlArmour: unexpected decision {r.str('decision')!r}.")
        return r.json

    @contextlib.contextmanager
    def check(self, tool: str, **kw: Any) -> Iterator[dict]:
        """`with ca.check("shell", command=...)`: asks first; the body runs only when allowed."""
        yield self.ask(tool, **kw)

    def guard(self, tool: str = "", command_from: Optional[Callable[..., str]] = None, paths_from: Optional[Callable[..., list[str]]] = None) -> Callable:
        """Decorator: ask before every call of the function, then record it as a command."""

        def wrap(fn: Callable) -> Callable:
            name = tool or fn.__name__

            @functools.wraps(fn)
            def inner(*a: Any, **k: Any) -> Any:
                command = command_from(*a, **k) if command_from else ""
                paths = paths_from(*a, **k) if paths_from else []
                self.ask(name, command=command, paths=paths, text=_head(json.dumps({"args": [repr(x) for x in a], "kwargs": {kk: repr(v) for kk, v in k.items()}}), 4000))
                try:
                    out = fn(*a, **k)
                except Exception as e:  # noqa: BLE001
                    self.command(command or name, exit_code=1, output=str(e), kind="tool")
                    raise
                self.command(command or name, exit_code=0, output="" if out is None else str(out), kind="tool")
                return out

            return inner

        return wrap
