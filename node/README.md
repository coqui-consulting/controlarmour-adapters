# @controlarmour/agent

Report what your Node agent does to ControlArmour on this computer and ask it before risky actions.
No dependencies; Node 18 or newer. Part of the Developer plan. Licence: Apache-2.0.

```bash
npm install @controlarmour/agent
```

## Any agent

```js
import { ControlArmour, Blocked } from "@controlarmour/agent";

const ca = await ControlArmour.start({ title: "Nightly reconciliation", agent: "my-agent" });
await ca.step("Load bank export");
await ca.file("exports/bank-oct.csv", { action: "read", lines: 412 });

try {
  await ca.ask("shell", { command: "rm -r build" });       // asks first; throws Blocked when refused
  await run("rm -r build");
  await ca.command("rm -r build", { exitCode: 0 });
} catch (e) {
  if (e instanceof Blocked) console.log(e.message);         // the reason, for the person
  else throw e;
}

for (const msg of ca.messages()) console.log("The person says:", msg);
await ca.done();
```

`ca.guard("send_email", fn)` wraps an async function so it is asked about before every call and recorded after.

## LangChain.js and LangGraph.js

```js
import { ControlArmourCallbackHandler } from "@controlarmour/agent/langchain";
const handler = await ControlArmourCallbackHandler.start({ title: "Support triage" });
await agent.invoke({ input: "..." }, { callbacks: [handler] });
```

A refused tool call throws `Blocked` from the handler and never runs.

## The rules it follows

- If ControlArmour is not running, every call is a no-op and your agent carries on.
- Once ControlArmour has answered a check, a lost connection blocks the action (`Blocked`).
- After a licence lapse ControlArmour stops checking; your agent carries on.
- Stop and Pause from ControlArmour are honoured at the next `ask` (`Stopped`, a wait while paused).
- Nothing you pass as content or output is stored: ControlArmour keeps sizes and line counts.
- A pending approval is waited for inside `ask`, in ControlArmour, for up to 25 minutes.
- Instructions the person types in ControlArmour queue in `ca.messages()`. The LangChain handler cannot
  hand them to the model for you; the Cline plugin passes them on as context before each run and tool.

## Cline

```bash
cline plugin install @controlarmour/agent/cline
```

`beforeTool` asks ControlArmour and skips a refused tool with the reason; Stop ends the run. Cline gives a
hook three seconds, so when ControlArmour is still waiting for the person the plugin asks Cline to require
the person's approval too and records ControlArmour's answer when it comes. Set the session's
`hookErrorMode` to `"throw"` if a hook failure must stop the run rather than let it continue.
