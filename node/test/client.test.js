// Tests against a stub core. Run: node --test test/
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { Blocked, ControlArmour, Stopped } from "../src/index.js";
import { ControlArmourCallbackHandler } from "../src/langchain.js";

const core = { events: [], checks: [], acks: [], control: { seq: 0 }, decision: { decision: "allow", category: "other" }, hangUp: false, checkStatus: 200, healthApp: "controlarmour", waitStatus: 200, controls: [] };
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
      if (req.method === "GET" && req.url.endsWith("/control")) {
        if (core.controls.length) {
          const nxt = core.controls.shift();
          return typeof nxt === "number" ? send(nxt, { error: "gone" }) : send(200, nxt);
        }
        return send(200, core.control);
      }
      if (req.method === "GET" && req.url.endsWith("/health")) return send(200, { ok: true, app: core.healthApp });
      if (req.url.endsWith("/events")) {
        core.events.push(...(body || []));
        return send(200, { control: core.control });
      }
      if (req.url.endsWith("/ack")) {
        core.acks.push(body);
        res.writeHead(204);
        return res.end();
      }
      if (req.url.endsWith("/check")) {
        core.checks.push(body);
        if (core.hangUp) return req.socket.destroy();
        if (core.checkStatus !== 200) return send(core.checkStatus, { error: "broken" });
        return send(200, core.decision);
      }
      if (req.url.includes("/approvals/")) {
        if (core.waitStatus !== 200) return send(core.waitStatus, { error: "licence" });
        return send(200, { decision: "allow", approvalId: req.url.split("/").at(-2), reason: "approved by the person" });
      }
      send(404, { error: "nope" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-"));
  fs.writeFileSync(path.join(dir, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, ingestToken: "tok" }));
  process.env.CONTROLARMOUR_DATA_DIR = dir;
});

after(() => server.close());

beforeEach(() => {
  core.events = [];
  core.checks = [];
  core.acks = [];
  core.control = { seq: 0 };
  core.decision = { decision: "allow", category: "other" };
  core.hangUp = false;
  core.checkStatus = 200;
  core.healthApp = "controlarmour";
  core.waitStatus = 200;
  core.controls = [];
});

test("not running is a no-op", async () => {
  const saved = process.env.CONTROLARMOUR_DATA_DIR;
  process.env.CONTROLARMOUR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-empty-"));
  try {
    const ca = await ControlArmour.start({ title: "x" });
    assert.equal(ca.connected, false);
    await ca.step("a");
    const d = await ca.ask("shell", { command: "rm -rf /" });
    assert.equal(d.decision, "allow");
    await ca.done();
  } finally {
    process.env.CONTROLARMOUR_DATA_DIR = saved;
  }
});

test("session, steps and measurements", async () => {
  const ca = await ControlArmour.start({ title: "Nightly", agent: "bot", sessionId: "s1" });
  assert.equal(core.events[0].type, "session");
  assert.equal(core.events[0].data.title, "Nightly");
  await ca.step("Load   the\nexport");
  await ca.step("Match");
  await ca.file("/x/a.txt", { content: "one\ntwo\n" });
  await ca.command("go test ./...", { exitCode: 0, output: "ok\n" });
  await ca.note("looks fine", "confirmed");
  await ca.done();
  assert.deepEqual(
    core.events.map((e) => e.type),
    ["session", "status", "status", "step", "status", "step", "step", "file", "code", "command", "note", "step", "status"],
  );
  assert.deepEqual([core.events[3].data.id, core.events[3].data.title], ["1", "Load the export"]);
  const f = core.events[7].data;
  assert.deepEqual([f.lines, f.bytes, f.action], [2, 8, "write"]);
  const c = core.events[9].data;
  assert.deepEqual([c.cmd, c.exit, c.outLines], ["go test ./...", 0, 1]);
});

test("deny throws Blocked with the reason; pending waits for approval", async () => {
  const ca = await ControlArmour.start({ title: "x", sessionId: "s2" });
  core.decision = { decision: "deny", reason: "/x/Payroll is a protected folder", category: "protectedFolder" };
  await assert.rejects(ca.ask("delete_file", { paths: ["/x/Payroll/a.csv"] }), (e) => e instanceof Blocked && /protected folder/.test(e.message));
  assert.deepEqual(core.checks[0].paths, ["/x/Payroll/a.csv"]);
  core.decision = { decision: "pending", approvalId: "ap-1", category: "deleteFiles" };
  const d = await ca.ask("shell", { command: "rm -r build" });
  assert.equal(d.decision, "allow");
});

test("guard asks first and records after", async () => {
  const ca = await ControlArmour.start({ title: "x", sessionId: "s3" });
  const calls = [];
  const send = ca.guard("send_email", async (to) => {
    calls.push(to);
    return "sent";
  }, { commandFrom: (to) => `mail ${to}` });
  assert.equal(await send("a@b"), "sent");
  assert.equal(core.checks.at(-1).tool, "send_email");
  assert.equal(core.events.at(-1).type, "command");
  core.decision = { decision: "deny", reason: "no", category: "sendMessages" };
  await assert.rejects(send("c@d"), Blocked);
  assert.deepEqual(calls, ["a@b"]);
});

test("stop, messages and acks", async () => {
  const ca = await ControlArmour.start({ title: "x", sessionId: "s4" });
  core.control = { seq: 3, message: "hold on" };
  await ca.step("go");
  assert.deepEqual(ca.messages(), ["hold on"]);
  assert.deepEqual(ca.messages(), []);
  assert.equal(core.acks.at(-1).seq, 3);
  core.control = { seq: 4, stop: true };
  await assert.rejects(ca.ask("shell", { command: "ls" }), Stopped);
});

test("lost contact fails closed", async () => {
  const ca = await ControlArmour.start({ title: "x", sessionId: "s5" });
  core.hangUp = true;
  await assert.rejects(ca.ask("shell", { command: "ls" }), (e) => e instanceof Blocked && /lost contact/.test(e.message));
});

test("LangChain handler blocks a tool before it runs", async () => {
  const h = await ControlArmourCallbackHandler.start({ client: await ControlArmour.start({ title: "LC", sessionId: "s6" }) });
  await h.handleChainStart({}, { input: "do the thing" }, "r0", undefined);
  core.decision = { decision: "deny", reason: "no", category: "deleteFiles" };
  await assert.rejects(h.handleToolStart({ name: "delete_file" }, '{"path": "/x/Payroll/a.csv"}', "r1"), Blocked);
  assert.equal(core.checks.at(-1).tool, "delete_file");
  assert.deepEqual(core.checks.at(-1).paths, ["/x/Payroll/a.csv"]);
  core.decision = { decision: "allow", category: "other" };
  await h.handleToolStart({ name: "search" }, "weather", "r2");
  await h.handleToolEnd("sunny", "r2");
  assert.equal(core.events.at(-1).data.cmd, "search");
});

test("nothing listens (closed port) fails open", async () => {
  const saved = process.env.CONTROLARMOUR_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-closed-"));
  // A port that was ours a moment ago and is now closed (fetch refuses "bad" low ports such as 9 outright).
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  fs.writeFileSync(path.join(dir, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, ingestToken: "tok" }));
  process.env.CONTROLARMOUR_DATA_DIR = dir;
  try {
    const ca = await ControlArmour.start({ title: "x", sessionId: "e1" });
    assert.equal((await ca.ask("shell", { command: "ls" })).decision, "allow");
  } finally {
    process.env.CONTROLARMOUR_DATA_DIR = saved;
  }
});

test("a broken check from ControlArmour blocks; from something else it opens", async () => {
  const ca = await ControlArmour.start({ title: "x", sessionId: "e3" });
  core.checkStatus = 500;
  await assert.rejects(ca.ask("shell", { command: "ls" }), (e) => e instanceof Blocked && /could not check/.test(e.message));
  core.healthApp = "someone-else";
  assert.equal((await ca.ask("shell", { command: "ls" })).decision, "allow");
});

test("a licence lapse during an approval opens", async () => {
  const ca = await ControlArmour.start({ title: "x", sessionId: "e5" });
  core.decision = { decision: "pending", approvalId: "ap-9", category: "deleteFiles" };
  core.waitStatus = 402;
  assert.equal((await ca.ask("shell", { command: "rm -r build" })).decision, "allow");
});

test("pause then resume; losing the core while paused stays paused", async () => {
  const ca = await ControlArmour.start({ title: "x", sessionId: "e6" });
  core.controls = [{ seq: 1, pause: true }, { seq: 2, pause: false }];
  const t0 = Date.now();
  assert.equal((await ca.ask("shell", { command: "ls" })).decision, "allow");
  assert.ok(Date.now() - t0 >= 1900, "one poll interval was waited");
  core.controls = [{ seq: 3, pause: true }, 500];
  await assert.rejects(ca.ask("shell", { command: "ls" }), (e) => e instanceof Blocked && /paused/.test(e.message));
});

test("LangChain.js: the tool name comes from runName, not the serialised tool", async () => {
  const h = await ControlArmourCallbackHandler.start({ client: await ControlArmour.start({ title: "LC", sessionId: "e8" }) });
  const serialised = { lc: 1, type: "not_implemented", id: ["langchain_core", "tools", "DynamicStructuredTool"] };
  core.decision = { decision: "deny", reason: "no", category: "deleteFiles" };
  await assert.rejects(h.handleToolStart(serialised, '{"path":"/x/Payroll/a.csv"}', "r9", undefined, [], {}, "delete_file"), Blocked);
  assert.equal(core.checks.at(-1).tool, "delete_file");
});
