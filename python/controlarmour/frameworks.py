"""Thin adapters for other frameworks, all built on one idea: ask
ControlArmour before a tool runs, record it after.

    from controlarmour.frameworks import guard_callable, guard_tools, ControlArmourSecurityAnalyzer

- ``guard_callable(ca, fn, tool=...)`` wraps any function or coroutine:
  CrewAI ``_run``, AutoGen ``FunctionTool`` functions, smolagents
  ``forward``, Pydantic AI tool functions, your own Anthropic tool loop.
- ``guard_tools(ca, tools)`` finds the callable on each tool object
  (``_run``, ``forward``, ``func``, ``fn``, ``run``) and wraps it in place.
- ``ControlArmourSecurityAnalyzer`` is an OpenHands SDK analyser: it asks
  ControlArmour about each action (waiting for the person's answer in
  ControlArmour when one is needed) and returns HIGH when ControlArmour says
  no, so ``ConfirmRisky(threshold=SecurityRisk.HIGH)`` makes OpenHands stop
  and ask the person. (OpenHands analysers rate; they cannot block, so this
  is the honest shape.)

The person's instructions from ControlArmour queue in ``ca.messages()``;
none of these frameworks lets an adapter hand them to the model, so read
them where your code builds the next input.

Licence: Apache-2.0.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
from typing import Any, Callable, Iterable, Optional

from .client import Blocked, ControlArmour

_COMMAND_KEYS = ("command", "cmd", "query", "script", "code")
_PATH_KEYS = ("path", "file_path", "filepath", "target_file", "directory", "dir_path")


def split_arguments(args: tuple, kwargs: dict) -> tuple[str, list[str], str]:
    """command, paths and a short text from a call's arguments."""
    command = next((str(kwargs[k]) for k in _COMMAND_KEYS if isinstance(kwargs.get(k), str)), "")
    if not command and len(args) == 1 and isinstance(args[0], str):
        command = args[0]
    paths = [str(kwargs[k]) for k in _PATH_KEYS if isinstance(kwargs.get(k), str) and "://" not in kwargs[k]]
    try:
        text = json.dumps({"args": [repr(a) for a in args], "kwargs": {k: repr(v) for k, v in kwargs.items()}})
    except Exception:  # noqa: BLE001
        text = ""
    return command, paths, text[:4000]


def guard_callable(ca: ControlArmour, fn: Callable, tool: str = "") -> Callable:
    """Return fn wrapped: ControlArmour is asked before each call (Blocked
    propagates, so the framework reports the reason) and the call is
    recorded after. Coroutine functions stay coroutine functions."""
    name = tool or getattr(fn, "__name__", "tool")

    def before(a: tuple, k: dict) -> str:
        command, paths, text = split_arguments(a, k)
        ca.ask(name, command=command, paths=paths, text=text)
        return command

    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def awrapped(*a: Any, **k: Any) -> Any:
            # ControlArmour calls are blocking HTTP; keep the event loop free.
            command = await asyncio.to_thread(before, a, k)
            try:
                out = await fn(*a, **k)
            except Exception as e:  # noqa: BLE001
                await asyncio.to_thread(ca.command, command or name, 1, str(e), "", "tool")
                raise
            await asyncio.to_thread(ca.command, command or name, 0, "" if out is None else str(out), "", "tool")
            return out
        return awrapped

    @functools.wraps(fn)
    def wrapped(*a: Any, **k: Any) -> Any:
        command = before(a, k)
        try:
            out = fn(*a, **k)
        except Exception as e:  # noqa: BLE001
            ca.command(command or name, exit_code=1, output=str(e), kind="tool")
            raise
        ca.command(command or name, exit_code=0, output="" if out is None else str(out), kind="tool")
        return out
    return wrapped


# The inner callable first (AutoGen's FunctionTool.run takes a pydantic model, its _func the arguments).
_CALL_ATTRS = ("_run", "forward", "_func", "func", "function", "fn", "run")


def guard_tools(ca: ControlArmour, tools: Iterable[Any]) -> int:
    """Wrap the callable on each tool object in place. Returns how many were
    wrapped. Works for CrewAI (BaseTool._run), smolagents (Tool.forward),
    AutoGen (FunctionTool._func / .func), Pydantic AI (Tool.function) and
    plain functions."""
    n = 0
    for t in tools:
        if callable(t) and not hasattr(t, "__dict__"):
            continue
        if inspect.isfunction(t):
            continue  # a bare function has nothing to patch in place; use guard_callable
        name = getattr(t, "name", None) or type(t).__name__
        for attr in _CALL_ATTRS:
            fn = getattr(t, attr, None)
            if callable(fn) and not getattr(fn, "_controlarmour_guarded", False):
                g = guard_callable(ca, fn, tool=str(name))
                g._controlarmour_guarded = True  # type: ignore[attr-defined]
                try:
                    setattr(t, attr, g)
                except Exception:  # noqa: BLE001 - frozen pydantic model: try object.__setattr__
                    object.__setattr__(t, attr, g)
                n += 1
                break
    return n


def anthropic_tool_guard(ca: ControlArmour) -> Callable[[str, dict], None]:
    """For a hand-written Anthropic tool loop: call ``check(name, input)``
    before running each ``tool_use`` block; it raises Blocked with the reason
    to return as the ``tool_result`` (``is_error`` true)."""

    def check(name: str, tool_input: dict) -> None:
        command, paths, text = split_arguments((), tool_input or {})
        ca.ask(name, command=command, paths=paths, text=text)

    return check


try:  # OpenHands SDK is optional at import time.
    from openhands.sdk.security.analyzer import SecurityAnalyzerBase  # type: ignore
    from openhands.sdk.security.risk import SecurityRisk  # type: ignore
except Exception:  # noqa: BLE001
    class SecurityAnalyzerBase:  # type: ignore[no-redef]
        """Stand-in when the OpenHands SDK is not installed."""

    class SecurityRisk:  # type: ignore[no-redef]
        LOW, MEDIUM, HIGH, UNKNOWN = "LOW", "MEDIUM", "HIGH", "UNKNOWN"


class ControlArmourSecurityAnalyzer(SecurityAnalyzerBase):
    """conversation.set_security_analyzer(ControlArmourSecurityAnalyzer(title="..."))
    conversation.set_confirmation_policy(ConfirmRisky(threshold=SecurityRisk.HIGH))

    Each action is asked about. When ControlArmour needs the person's
    approval, the wait happens in ControlArmour (as for every connector). A
    refusal rates HIGH, so OpenHands stops and asks the person, with
    ControlArmour's reason in the record; an allow rates LOW.

    The OpenHands base class is a pydantic model, which refuses undeclared
    attributes; the client is kept outside its fields."""

    def __init__(self, title: str = "", client: Optional[ControlArmour] = None, **kw: Any):
        try:
            super().__init__(**kw)
        except TypeError:
            super().__init__()
        object.__setattr__(self, "_controlarmour", client or ControlArmour(title=title, agent="openhands"))

    @property
    def ca(self) -> ControlArmour:
        return self.__dict__["_controlarmour"]

    def security_risk(self, action: Any) -> Any:  # ActionEvent -> SecurityRisk
        name, tool_input = describe_action(action)
        command, paths, text = split_arguments((), tool_input)
        try:
            self.ca.ask(name, command=command, paths=paths, text=text or str(action)[:4000])
        except Blocked as e:
            self.ca.note(str(e)[:500], kind="warning")
            return SecurityRisk.HIGH
        return SecurityRisk.LOW


def describe_action(action: Any) -> tuple[str, dict]:
    """Tool name and arguments from an OpenHands ActionEvent (best effort)."""
    name = getattr(action, "tool_name", None) or getattr(action, "tool", None) or type(action).__name__
    act = getattr(action, "action", None)
    args: dict = {}
    for src in (act, action):
        if src is None:
            continue
        for attr in ("command", "path", "file_path", "content", "code", "url"):
            v = getattr(src, attr, None)
            if isinstance(v, str) and attr not in args:
                args[attr] = v
    if not args:
        raw = getattr(action, "tool_call", None)
        fa = getattr(raw, "arguments", None) or getattr(getattr(raw, "function", None), "arguments", None)
        if isinstance(fa, str):
            try:
                args = json.loads(fa)
            except Exception:  # noqa: BLE001
                args = {}
        elif isinstance(fa, dict):
            args = fa
    return str(name), args
