// The Cline plugin against a stub core: skip with the reason on a refusal,
// defer to Cline's own approval when ControlArmour is still waiting.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { createPlugin } from "../src/cline.js";

const core = { events: [], checks: [], decision: { decision: "allow", category: "other" }, delayMs: 0, control: { seq: 0 } };
let server;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith("/control")) return send(200, core.control);
      if (req.url.endsWith("/events")) {
        core.events.push(...(body || []));
        return send(200, { control: { seq: 0 } });
      }
      if (req.url.endsWith("/check")) {
        core.checks.push(body);
        return setTimeout(() => send(200, core.decision), core.delayMs);
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-cline-"));
  fs.writeFileSync(path.join(dir, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, ingestToken: "tok" }));
  process.env.CONTROLARMOUR_DATA_DIR = dir;
});
after(() => server.close());
beforeEach(() => {
  core.events = [];
  core.checks = [];
  core.decision = { decision: "allow", category: "other" };
  core.delayMs = 0;
  core.control = { seq: 0 };
});

async function started() {
  const p = createPlugin({ budgetMs: 300 });
  await p.setup({}, { cwd: "/w/proj", session: { sessionId: "abc" }, onDispose() {} });
  return p;
}

test("registers the session and opens a step on run", async () => {
  const p = await started();
  assert.equal(core.events[0].type, "session");
  assert.equal(core.events[0].data.title, "proj (Cline)");
  assert.equal(core.events[0].data.agent, "cline");
  await p.hooks.beforeRun({ snapshot: { messages: [{ content: "fix the bug" }] } });
  assert.equal(core.events.at(-1).data.title, "fix the bug");
});

test("a refused tool is skipped with the reason; an allowed one runs and is recorded", async () => {
  const p = await started();
  core.decision = { decision: "deny", reason: "/x/Payroll is a protected folder", category: "protectedFolder" };
  const r = await p.hooks.beforeTool({ tool: { name: "write_to_file" }, toolCall: { id: "t1" }, input: { path: "/x/Payroll/a.csv", content: "x" } });
  assert.equal(r.skip, true);
  assert.match(r.reason, /protected folder/);
  assert.deepEqual(core.checks.at(-1).paths, ["/x/Payroll/a.csv"]);
  core.decision = { decision: "allow", category: "other" };
  const ok = await p.hooks.beforeTool({ tool: { name: "execute_command" }, toolCall: { id: "t2" }, input: { command: "npm test" } });
  assert.equal(ok, undefined);
  await p.hooks.afterTool({ toolCall: { id: "t2" }, result: "ok" });
  assert.equal(core.events.at(-1).type, "command");
  assert.equal(core.events.at(-1).data.cmd, "npm test");
});

test("when ControlArmour is still waiting, Cline is asked to require approval", async () => {
  const p = await started();
  core.delayMs = 800;
  core.decision = { decision: "allow", reason: "approved by the person", category: "deleteFiles" };
  const t0 = Date.now();
  const r = await p.hooks.beforeTool({ tool: { name: "execute_command" }, toolCall: { id: "t3" }, input: { command: "rm -r build" } });
  assert.ok(Date.now() - t0 < 700, "the hook answered within its budget");
  assert.deepEqual(r.policy, { autoApprove: false });
  await new Promise((d) => setTimeout(d, 900));
  assert.ok(core.events.some((e) => e.type === "note" && /allowed execute_command/.test(e.data.text)));
});

test("a refusal returns at once even when recording is slow; Stop stops the run", async () => {
  const p = await started();
  core.decision = { decision: "deny", reason: "no", category: "x" };
  const t0 = Date.now();
  const r = await p.hooks.beforeTool({ tool: { name: "execute_command" }, toolCall: { id: "t4" }, input: { command: "rm -r build" } });
  assert.equal(r.skip, true);
  assert.ok(Date.now() - t0 < 300);
  core.control = { seq: 5, stop: true };
  const s = await p.hooks.beforeTool({ tool: { name: "execute_command" }, toolCall: { id: "t5" }, input: { command: "ls" } });
  assert.equal(s.stop, true);
  assert.match(s.reason, /stopped/);
});
