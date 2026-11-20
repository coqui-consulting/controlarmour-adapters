"""LangChain and LangGraph: a callback handler that reports steps, tool
calls and files, and asks ControlArmour before every tool call.

    from controlarmour.langchain import ControlArmourCallbackHandler
    handler = ControlArmourCallbackHandler(title="Support triage")
    agent.invoke(..., config={"callbacks": [handler]})

Blocking: the handler raises Blocked from on_tool_start, which LangChain
propagates (the handler sets raise_error so it is not swallowed), so a
refused tool never runs. The person's instructions from ControlArmour queue
in ``handler.ca.messages()``; a callback cannot hand them to the model, so
read them where your code builds the next input. Licence: Apache-2.0.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from .client import ControlArmour

try:  # LangChain is optional at import time so this module can be imported without it.
    from langchain_core.callbacks.base import BaseCallbackHandler  # type: ignore
except Exception:  # noqa: BLE001
    class BaseCallbackHandler:  # type: ignore[no-redef]
        """Stand-in when LangChain is not installed."""


_COMMAND_KEYS = ("command", "cmd", "query", "script")
_PATH_KEYS = ("path", "file_path", "filepath", "target_file", "directory")


def _split(tool_input: Any) -> tuple[str, list[str], str]:
    """command, paths, text from whatever the tool received."""
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except Exception:  # noqa: BLE001
            return "", [], tool_input
    if not isinstance(tool_input, dict):
        return "", [], str(tool_input)
    command = next((str(tool_input[k]) for k in _COMMAND_KEYS if isinstance(tool_input.get(k), str)), "")
    paths = [str(tool_input[k]) for k in _PATH_KEYS if isinstance(tool_input.get(k), str) and "://" not in tool_input[k]]
    return command, paths, json.dumps(tool_input)


class ControlArmourCallbackHandler(BaseCallbackHandler):
    raise_error = True  # a Blocked must stop the tool, not be logged and ignored

    def __init__(self, title: str = "", agent: str = "langchain", client: Optional[ControlArmour] = None):
        super().__init__()
        self.ca = client or ControlArmour(title=title, agent=agent)
        self._tools: dict[str, tuple[str, str]] = {}

    # steps
    def on_chain_start(self, serialized: Any, inputs: Any, *, run_id: Any = None, parent_run_id: Any = None, **kw: Any) -> None:
        if parent_run_id is None:
            text = inputs.get("input") if isinstance(inputs, dict) else inputs
            self.ca.step(str(text)[:90] if text else "Run")

    def on_chain_end(self, outputs: Any, *, run_id: Any = None, parent_run_id: Any = None, **kw: Any) -> None:
        if parent_run_id is None:
            self.ca.post([{"type": "status", "data": {"status": "waiting"}}])

    # tools: ask first, record after
    def on_tool_start(self, serialized: Any, input_str: str, *, run_id: Any = None, inputs: Any = None, **kw: Any) -> None:
        name = (serialized or {}).get("name") or "tool"
        command, paths, text = _split(inputs if inputs is not None else input_str)
        self._tools[str(run_id)] = (name, command)
        self.ca.ask(name, command=command, paths=paths, text=text)

    def on_tool_end(self, output: Any, *, run_id: Any = None, **kw: Any) -> None:
        name, command = self._tools.pop(str(run_id), ("tool", ""))
        self.ca.command(command or name, exit_code=0, output=str(output), kind="tool")

    def on_tool_error(self, error: BaseException, *, run_id: Any = None, **kw: Any) -> None:
        name, command = self._tools.pop(str(run_id), ("tool", ""))
        self.ca.command(command or name, exit_code=1, output=str(error), kind="tool")

    def on_agent_action(self, action: Any, **kw: Any) -> None:
        log = getattr(action, "log", "")
        if log:
            self.ca.note(str(log)[:500], kind="inference")
