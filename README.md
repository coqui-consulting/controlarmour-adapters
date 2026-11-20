# ControlArmour adapters and SDK packages

Public, Apache-2.0 source for the parts of [ControlArmour](https://controlarmour.com) that run inside other
programs: the hook adapter for Claude Code, the Python package for agents built in-house, and the Node
package with the LangChain.js handler and the Cline plugin. ControlArmour itself is a separate, licensed
desktop application that runs on your own computer; these packages talk to it over its local agent API
and do nothing when it is not running.

| Folder | What it is | Install |
|---|---|---|
| `python/` | `controlarmour`: a client that follows the hook contract, a LangChain and LangGraph callback handler, OpenAI Agents SDK hooks, generic guards for CrewAI, smolagents, AutoGen and Pydantic AI, an Anthropic tool-loop guard, an OpenHands analyser. Standard library only, Python 3.9+. | `pip install controlarmour` |
| `node/` | `@controlarmour/agent`: the same client, a LangChain.js handler, and the Cline plugin (`@controlarmour/agent/cline`). No dependencies, Node 18+. | `npm install @controlarmour/agent` |
| `claude-code/` | The readable reference hook for Claude Code. The ControlArmour app installs its own binary as the hook; this is the same behaviour in plain Node, for anyone who wants to read it. | `node install.js` |

## The contract every package follows

- If ControlArmour is not running, every call is a no-op and your agent carries on.
- Once ControlArmour has answered a check, a lost connection blocks the action.
- After a licence lapse ControlArmour stops checking; your agent carries on.
- Stop and Pause from ControlArmour are honoured at the next check.
- Nothing you pass as content or output is stored: ControlArmour keeps sizes, line counts and timing.

Each folder has its own README with examples. Issues and pull requests are welcome here; the desktop
application is not in this repository.

Licence: Apache-2.0. ControlArmour is a product of Coqui Consulting LLC.
