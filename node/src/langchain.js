// LangChain.js and LangGraph.js: a callback handler that reports steps and
// tool calls, and asks ControlArmour before every tool call.
//
//   import { ControlArmourCallbackHandler } from "@controlarmour/agent/langchain";
//   const handler = await ControlArmourCallbackHandler.start({ title: "Support triage" });
//   await agent.invoke(input, { callbacks: [handler] });
//
// LangChain.js runs handleToolStart before the tool and awaits it, with
// awaitHandlers on and raiseError true so a Blocked thrown here stops the
// tool instead of being logged. The person's instructions from ControlArmour
// queue in handler.ca.messages(); a callback cannot hand them to the model,
// so read them where your code builds the next input. Licence: Apache-2.0.

import { ControlArmour } from "./index.js";

let BaseCallbackHandler = class {
  constructor() {}
};
try {
  ({ BaseCallbackHandler } = await import("@langchain/core/callbacks/base"));
} catch {
  /* LangChain is optional at import time */
}

const COMMAND_KEYS = ["command", "cmd", "query", "script"];
const PATH_KEYS = ["path", "file_path", "filePath", "target_file", "directory"];

export function splitInput(input) {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return { command: "", paths: [], text: input };
    }
  }
  if (!input || typeof input !== "object") return { command: "", paths: [], text: String(input ?? "") };
  const command = COMMAND_KEYS.map((k) => input[k]).find((v) => typeof v === "string") || "";
  const paths = PATH_KEYS.map((k) => input[k]).filter((v) => typeof v === "string" && !v.includes("://"));
  return { command, paths, text: JSON.stringify(input) };
}

export class ControlArmourCallbackHandler extends BaseCallbackHandler {
  name = "controlarmour";
  awaitHandlers = true;
  raiseError = true;

  constructor(ca) {
    super();
    this.ca = ca;
    this._tools = new Map();
  }

  static async start({ title = "", agent = "langchain", client } = {}) {
    return new ControlArmourCallbackHandler(client || (await ControlArmour.start({ title, agent })));
  }

  async handleChainStart(chain, inputs, runId, parentRunId) {
    if (parentRunId) return;
    const text = inputs && typeof inputs === "object" ? inputs.input : inputs;
    await this.ca.step(text ? String(text).slice(0, 90) : "Run");
  }

  async handleChainEnd(outputs, runId, parentRunId) {
    if (parentRunId) return;
    await this.ca.post([{ type: "status", data: { status: "waiting" } }]);
  }

  async handleToolStart(tool, input, runId, parentRunId, tags, metadata, runName) {
    // `tool` is the serialised form ({lc, type, id: [...namespace, className]}), which
    // has no name; LangChain passes the tool's name as runName.
    const name = runName || tool?.name || (Array.isArray(tool?.id) ? tool.id[tool.id.length - 1] : "tool");
    const { command, paths, text } = splitInput(input);
    this._tools.set(runId, { name, command });
    await this.ca.ask(name, { command, paths, text });
  }

  async handleToolEnd(output, runId) {
    const { name, command } = this._tools.get(runId) || { name: "tool", command: "" };
    this._tools.delete(runId);
    await this.ca.command(command || name, { exitCode: 0, output: typeof output === "string" ? output : JSON.stringify(output ?? ""), kind: "tool" });
  }

  async handleToolError(err, runId) {
    const { name, command } = this._tools.get(runId) || { name: "tool", command: "" };
    this._tools.delete(runId);
    await this.ca.command(command || name, { exitCode: 1, output: String(err?.message || err), kind: "tool" });
  }

  async handleAgentAction(action) {
    if (action?.log) await this.ca.note(String(action.log).slice(0, 500), "inference");
  }
}
