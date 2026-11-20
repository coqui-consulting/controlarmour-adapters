// ControlArmour plugin for Cline (in-process AgentPlugin). Cline runs each
// hook with a three-second limit and, by default, carries on as if a hook
// that overran had returned nothing. So every hook here answers inside a
// budget, whatever ControlArmour is doing: a plain answer (allow or refuse)
// arrives well inside it; when the person's approval is still pending, the
// plugin asks Cline to require the person's approval itself and records
// ControlArmour's answer when it comes. Set the session's hookErrorMode to
// "throw" for a run that must stop rather than continue on a hook failure.
//
//   cline plugin install @controlarmour/agent/cline      (or pluginPaths: [".../src/cline.js"])
//
// Licence: Apache-2.0.

import path from "node:path";

import { Blocked, ControlArmour, Stopped } from "./index.js";

const HOOK_BUDGET_MS = 2500;

const COMMAND_KEYS = ["command", "cmd", "query", "script"];
const PATH_KEYS = ["path", "file_path", "filePath", "target_file", "directory"];

function splitInput(input) {
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

function toolName(context) {
  return context?.tool?.name || context?.toolCall?.name || context?.toolCall?.function?.name || "tool";
}

/** Resolve to `fallback` when `promise` has not settled within `ms`. */
function within(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const quiet = (p) => p.catch(() => {});

/** Build the plugin. `options.budgetMs` is for tests. */
export function createPlugin(options = {}) {
  const budget = options.budgetMs ?? HOOK_BUDGET_MS;
  let ca = null;
  const calls = new Map();
  const PENDING = Symbol("pending");

  return {
    name: "controlarmour",
    manifest: { capabilities: ["hooks"] },

    async setup(api, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      ca = await within(
        ControlArmour.start({ title: `${path.basename(cwd)} (Cline)`, agent: "cline", sessionId: ctx?.session?.sessionId || "", cwd }),
        budget,
        null,
      );
      if (!ca) ca = new ControlArmour({ title: `${path.basename(cwd)} (Cline)`, agent: "cline", cwd }); // registers on first use
      ctx?.onDispose?.(() => {
        if (ca) quiet(ca.done("done"));
      });
    },

    hooks: {
      async beforeRun(context) {
        if (!ca) return;
        const text = context?.snapshot?.messages?.at?.(-1)?.content;
        await within(ca.step(typeof text === "string" && text ? text.slice(0, 90) : "Run"), budget, undefined);
        const msgs = ca.messages();
        if (msgs.length) return { appendContext: "The person says (from ControlArmour): " + msgs.join(" | ") };
      },

      async beforeTool(context) {
        if (!ca) return;
        const name = toolName(context);
        const { command, paths, text } = splitInput(context?.input);
        const id = context?.toolCall?.id || `${name}-${Date.now()}`;
        calls.set(id, { name, command });
        // Whatever happens below, the answer leaves within the budget: recording
        // never stands between a refusal and the return.
        const asking = ca.ask(name, { command, paths, text });
        const first = await within(asking.then((d) => ({ decision: d })).catch((e) => ({ error: e })), budget, PENDING);
        if (first === PENDING) {
          // The person is being asked in ControlArmour (or it is paused); let Cline ask too
          // and record the outcome when it comes.
          asking.then((d) => ca.note(`ControlArmour allowed ${name}${d?.reason ? " (" + d.reason + ")" : ""}`, "confirmed")).catch((e) => ca.note(String(e?.message || e), "warning")).catch(() => {});
          return { policy: { autoApprove: false }, appendContext: "ControlArmour is still deciding on this action; the person has been asked." };
        }
        if (first.error) {
          const e = first.error;
          const reason = e instanceof Blocked ? e.message : `ControlArmour: ${e?.message || e}`;
          calls.delete(id);
          quiet(ca.command(command || name, { exitCode: 1, output: "", kind: "tool" }));
          if (e instanceof Stopped) return { stop: true, reason };
          return { skip: true, reason };
        }
        const msgs = ca.messages();
        if (msgs.length) return { appendContext: "The person says (from ControlArmour): " + msgs.join(" | ") };
      },

      async afterTool(context) {
        if (!ca) return;
        const id = context?.toolCall?.id;
        const c = (id && calls.get(id)) || { name: toolName(context), command: "" };
        if (id) calls.delete(id);
        const result = context?.result;
        const out = typeof result === "string" ? result : result == null ? "" : JSON.stringify(result);
        const failed = Boolean(result && typeof result === "object" && (result.isError || result.error));
        await within(ca.command(c.command || c.name, { exitCode: failed ? 1 : 0, output: out, kind: "tool" }), budget, undefined);
      },

      async afterRun() {
        if (!ca) return;
        await within(ca.post([{ type: "status", data: { status: "waiting" } }]), budget, undefined);
      },
    },
  };
}

const plugin = createPlugin();
export default plugin;
