"""OpenAI Agents SDK: run hooks that report steps and tool calls, and a
helper that guards an agent's function tools so ControlArmour is asked
before each one runs.

    from controlarmour.openai_agents import ControlArmourHooks, guard_tools
    hooks = ControlArmourHooks(title="Order desk")
    guard_tools(agent, hooks.ca)
    await Runner.run(agent, "...", hooks=hooks)

The person's instructions from ControlArmour queue in ``hooks.ca.messages()``;
the Agents SDK gives hooks no way to hand them to the model, so read them
where your code builds the next input. Licence: Apache-2.0.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from .client import Blocked, ControlArmour

try:
    from agents import RunHooks  # type: ignore
except Exception:  # noqa: BLE001
    class RunHooks:  # type: ignore[no-redef]
        """Stand-in when the OpenAI Agents SDK is not installed."""


class ControlArmourHooks(RunHooks):
    """Observers: steps on agent start, tool calls recorded after they run.
    Every call to ControlArmour runs in a thread so the event loop stays free."""

    def __init__(self, title: str = "", agent: str = "openai-agents", client: Optional[ControlArmour] = None):
        super().__init__()
        self.ca = client or ControlArmour(title=title, agent=agent)

    async def on_agent_start(self, context: Any, agent: Any) -> None:
        await asyncio.to_thread(self.ca.step, f"Agent {getattr(agent, 'name', 'agent')} starts")

    async def on_tool_start(self, context: Any, agent: Any, tool: Any) -> None:
        await asyncio.to_thread(self.ca.note, f"Calling {getattr(tool, 'name', 'tool')}")

    async def on_tool_end(self, context: Any, agent: Any, tool: Any, result: Any) -> None:
        await asyncio.to_thread(self.ca.command, getattr(tool, "name", "tool"), 0, str(result), "", "tool")

    async def on_agent_end(self, context: Any, agent: Any, output: Any) -> None:
        await asyncio.to_thread(self.ca.post, [{"type": "status", "data": {"status": "waiting"}}])


def guard_tools(agent: Any, ca: ControlArmour) -> int:
    """Wrap every function tool on the agent so ControlArmour is asked first.
    Returns how many tools were wrapped (a tool is wrapped once).

    Hooks in the Agents SDK observe; they cannot refuse. The refusal happens
    here: a refused tool does not run and the model receives the reason as
    the tool's result, so it can explain and choose another approach.
    """
    n = 0
    for tool in getattr(agent, "tools", []) or []:
        orig = getattr(tool, "on_invoke_tool", None)
        if orig is None or getattr(orig, "_controlarmour_guarded", False):
            continue

        async def wrapped(ctx: Any, args_json: str, _orig: Any = orig, _tool: Any = tool) -> Any:
            name = getattr(_tool, "name", "tool")
            try:
                args = json.loads(args_json) if args_json else {}
            except Exception:  # noqa: BLE001
                args = {}
            if not isinstance(args, dict):
                args = {}
            command = next((str(args[k]) for k in ("command", "cmd", "query") if isinstance(args.get(k), str)), "")
            paths = [str(args[k]) for k in ("path", "file_path", "target_file") if isinstance(args.get(k), str)]
            try:
                await asyncio.to_thread(ca.ask, name, command, paths, args_json or "")
            except Blocked as e:
                return str(e)
            return await _orig(ctx, args_json)

        wrapped._controlarmour_guarded = True  # type: ignore[attr-defined]
        tool.on_invoke_tool = wrapped
        n += 1
    return n
