// @controlarmour/agent: the same contract as ControlArmour's own hooks, in
// Node. No dependencies. Licence: Apache-2.0.
//
//   import { ControlArmour, Blocked } from "@controlarmour/agent";
//   const ca = await ControlArmour.start({ title: "Nightly reconciliation", agent: "my-agent" });
//   await ca.step("Load bank export");
//   await ca.ask("shell", { command: "rm -r build" });   // throws Blocked when the person or the rules say no
//   await ca.command("rm -r build", { exitCode: 0 });
//   await ca.done();
//
// If ControlArmour is not running, every call is a no-op (fail open). Once
// ControlArmour has answered a check, a lost connection blocks the action
// (fail closed). A licence lapse (402) turns checking off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHECK_WAIT_MS = 110_000;
const MAX_APPROVAL_MS = 1_500_000;
const SHORT_MS = 3_000;
const POST_MS = 4_000;

export class Blocked extends Error {
  constructor(message) {
    super(message);
    this.name = "Blocked";
  }
}

export class Stopped extends Blocked {
  constructor(message) {
    super(message);
    this.name = "Stopped";
  }
}

export function dataDir() {
  if (process.env.CONTROLARMOUR_DATA_DIR) return process.env.CONTROLARMOUR_DATA_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ControlArmour");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ControlArmour");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ControlArmour");
}

export function readEndpoint() {
  try {
    const ep = JSON.parse(fs.readFileSync(path.join(dataDir(), "endpoint.json"), "utf8"));
    if (ep && ep.url && ep.ingestToken) return ep;
  } catch {
    /* not running */
  }
  return null;
}

const sid = (prefix, raw) => prefix + "-" + String(raw || "unknown").replace(/[^A-Za-z0-9._:@-]/g, "_").slice(0, 100);
const head = (s, n) => (s.length <= n ? s : s.slice(0, n) + "…");
const tail = (s, n) => (s.length <= n ? s : "…" + s.slice(-n));
const lines = (s) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);
const bytes = (s) => Buffer.byteLength(s, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LANGUAGES = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
  go: "go", rs: "rust", java: "java", kt: "kotlin", rb: "ruby", php: "php", cs: "csharp", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", swift: "swift", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  sql: "sql", html: "html", css: "css", scss: "scss", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", xml: "xml", txt: "text",
};
const languageOf = (p) => {
  const ext = path.extname(p).replace(/^\./, "").toLowerCase();
  return LANGUAGES[ext] || ext;
};

export class ControlArmour {
  /**
   * Prefer ControlArmour.start(): it registers the session. Instructions the
   * person types in ControlArmour queue in messages(); a framework adapter
   * cannot usually hand them to the model, so call it where your agent reads input.
   */
  constructor({ title = "", agent = "node", sessionId = "", cwd = "", pid = 0 } = {}) {
    this.ep = null;
    this.sid = sid("js", sessionId || `${process.pid}-${Math.floor(Date.now() / 1000)}`);
    this.cwd = cwd || process.cwd();
    this.title = title || `${path.basename(this.cwd)} (${agent})`;
    this.agent = agent;
    this.pid = pid || process.pid;
    this._seqAcked = 0;
    this._msgSeq = 0;
    this._step = 0;
    this._messages = [];
  }

  static async start(opts = {}) {
    const ca = new ControlArmour(opts);
    await ca._connect(readEndpoint());
    return ca;
  }

  /** Adopt an endpoint and register the session with it. */
  async _connect(ep) {
    if (!ep) return;
    this.ep = ep;
    await this.post([
      { type: "session", data: { title: this.title, agent: this.agent, pid: this.pid, cwd: this.cwd } },
      { type: "status", data: { status: "running" } },
    ]);
  }

  /** True when ControlArmour was running the last time this session spoke to it. */
  get connected() {
    return this.ep !== null;
  }

  // ---- transport
  async _request(method, p, body, timeoutMs = POST_MS) {
    if (!this.ep) {
      // ControlArmour may have started since: look again, once per call.
      const ep = readEndpoint();
      if (!ep) return { status: 0, json: null, lost: false };
      await this._connect(ep);
      if (!this.ep) return { status: 0, json: null, lost: false };
    }
    let r = await this._send(method, p, body, timeoutMs);
    if (r.status === 0 && !r.lost) {
      // Refused: the core may have restarted on another port.
      const ep = readEndpoint();
      if (ep && ep.url !== this.ep.url) {
        this.ep = ep;
        r = await this._send(method, p, body, timeoutMs);
      }
    }
    return r;
  }

  async _send(method, p, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.ep.url + p, {
        method,
        headers: { Authorization: "Bearer " + this.ep.ingestToken, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: r.status, json, lost: false };
    } catch (e) {
      // Nothing listens (refused) or no such host: not running. Anything else
      // (timeout, reset) is contact lost. A dual-stack host may report one
      // AggregateError holding a code per address.
      const notRunning = (c) => c === "ECONNREFUSED" || c === "ENOTFOUND" || c === "EAI_AGAIN";
      const cause = e?.cause ?? e;
      const codes = Array.isArray(cause?.errors) && cause.errors.length ? cause.errors.map((x) => x?.code) : [cause?.code];
      const refused = codes.every(notRunning);
      return { status: 0, json: null, lost: !refused };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send events; resolves to the current control (stop, pause, message). */
  async post(events) {
    const r = await this._request("POST", `/api/v1/agent/sessions/${this.sid}/events`, events);
    const control = r.json && typeof r.json === "object" ? r.json.control : null;
    await this._handleControl(control);
    return control || {};
  }

  // ---- control from the person
  async _handleControl(control) {
    if (!control || typeof control.seq !== "number") return;
    const seq = control.seq;
    if (seq > this._seqAcked) {
      const text = control.stop ? "stopping" : control.pause ? "pausing" : "noted";
      const r = await this._request("POST", `/api/v1/agent/sessions/${this.sid}/ack`, { seq, text }, SHORT_MS);
      if (r.status >= 200 && r.status < 300) this._seqAcked = seq;
    }
    if (control.message && seq > this._msgSeq) {
      this._msgSeq = seq;
      this._messages.push(String(control.message));
    }
  }

  /** Instructions the person sent since you last asked (each delivered once). */
  messages() {
    const out = this._messages;
    this._messages = [];
    return out;
  }

  async _control() {
    const r = await this._request("GET", `/api/v1/agent/sessions/${this.sid}/control`, undefined, SHORT_MS);
    if (r.status === 200 && r.json && typeof r.json === "object") await this._handleControl(r.json);
    return r;
  }

  /** The current control: { stop, pause, message }. */
  async control() {
    const r = await this._control();
    return r.status === 200 && r.json && typeof r.json === "object" ? r.json : {};
  }

  /**
   * Honour Pause: wait until resumed; throw Stopped on Stop. Losing the core
   * while paused keeps the agent paused (fail closed).
   */
  async waitIfPaused(maxWaitMs = 100_000) {
    let r = await this._control();
    let c = r.status === 200 && r.json && typeof r.json === "object" ? r.json : {};
    if (c.stop) throw new Stopped("the person stopped this agent");
    const until = Date.now() + maxWaitMs;
    while (c.pause && Date.now() < until) {
      await sleep(2000);
      r = await this._control();
      if (r.status === 402) return; // the licence lapsed: nothing is checked any more
      if (r.status !== 200 || !r.json || typeof r.json !== "object") break; // still paused as far as we know
      c = r.json;
      if (c.stop) throw new Stopped("the person stopped this agent");
    }
    if (c.pause) throw new Blocked("this agent is paused by the person");
  }

  // ---- what the agent reports
  /** Start a step (closes the previous one). */
  async step(title, note = "") {
    const prev = this._step;
    const cur = ++this._step;
    const events = [{ type: "status", data: { status: "running" } }];
    if (prev) events.push({ type: "step", data: { id: String(prev), status: "done" } });
    events.push({ type: "step", data: { id: String(cur), title: head(String(title).split(/\s+/).join(" ").trim(), 90) || "Step", status: "running", note } });
    await this.post(events);
    return cur;
  }

  /** A file the agent read or changed. Content is for the live view only; ControlArmour never stores it. */
  async file(p, { action = "write", content, lines: lineCount } = {}) {
    const d = { path: p, action };
    if (typeof content === "string") {
      d.lines = lines(content);
      d.bytes = bytes(content);
    } else if (typeof lineCount === "number") d.lines = lineCount;
    const events = [{ type: "file", data: d }];
    if (typeof content === "string" && action !== "read" && content.length <= 200_000) {
      events.push({ type: "code", data: { path: p, language: languageOf(p), content } });
    }
    await this.post(events);
  }

  /** A command the agent ran. The output is for the live view; ControlArmour stores its size. */
  async command(cmd, { exitCode = 0, output = "", cwd = "", kind = "shell", id = "" } = {}) {
    const d = { kind, cwd: cwd || this.cwd, cmd, exit: exitCode, out: tail(output, 4000), outBytes: bytes(output), outLines: lines(output) };
    if (id) d.id = id;
    await this.post([{ type: "command", data: d }]);
  }

  /** kind: info, inference, confirmed, verify, question or warning. */
  async note(text, kind = "info") {
    await this.post([{ type: "note", data: { kind, text: head(text, 500) } }]);
  }

  /** End the session: done, failed or stopped. */
  async done(status = "done") {
    const events = [{ type: "status", data: { status } }];
    if (this._step) events.unshift({ type: "step", data: { id: String(this._step), status: status === "done" ? "done" : "failed" } });
    await this.post(events);
  }

  // ---- asking first
  /**
   * Ask ControlArmour before an action. Resolves to the decision; throws
   * Blocked or Stopped. Tool names are matched by ControlArmour's rules
   * (delete, send, pay, fetch, write, read …); a shell command is analysed as
   * such. A pending approval is waited for here, in ControlArmour, up to 25 minutes.
   */
  async ask(tool, { command = "", paths = [], text = "", summary = "", category = "" } = {}) {
    if (!this.ep && !readEndpoint()) return { decision: "allow", reason: "ControlArmour is not running" };
    await this.waitIfPaused();
    const body = {
      tool,
      command,
      paths,
      text: head(text, 4000),
      cwd: this.cwd,
      summary: summary || (command ? `${tool}: ${head(command, 160)}` : paths.length ? `${tool}: ${paths[0]}` : tool),
    };
    if (category) body.category = category;
    let r = await this._request("POST", `/api/v1/agent/sessions/${this.sid}/check`, body, CHECK_WAIT_MS);
    const str = (k) => (r.json && typeof r.json[k] === "string" ? r.json[k] : "");
    if (r.status === 0 && !r.lost) return { decision: "allow", reason: "ControlArmour is not running" };
    if (r.status === 0) throw new Blocked("ControlArmour: lost contact while checking this action. Not allowed; try again.");
    if (r.status !== 200 || !str("decision")) {
      // The check route answers 200 with allow and a licence reason after a
      // lapse (never 402), so anything else is looked into: is it ControlArmour at all?
      const h = await this._request("GET", "/api/v1/health", undefined, SHORT_MS);
      if (h.status === 0 && h.lost) throw new Blocked("ControlArmour: lost contact while checking this action. Not allowed; try again.");
      if (!(h.status === 200 && h.json && h.json.app === "controlarmour")) return { decision: "allow", reason: "something other than ControlArmour answers; not checking" };
      throw new Blocked(`ControlArmour: could not check this action: ${str("error") || `unexpected answer (${r.status})`}.`);
    }
    const deadline = Date.now() + MAX_APPROVAL_MS;
    while (str("decision") === "pending" && str("approvalId")) {
      if (Date.now() > deadline) throw new Blocked("ControlArmour: nobody answered the approval request. Not allowed.");
      r = await this._request("POST", `/api/v1/agent/sessions/${this.sid}/approvals/${str("approvalId")}/wait`, {}, CHECK_WAIT_MS);
      if (r.status === 402) return { decision: "allow", reason: "the licence has lapsed" };
      if (r.status !== 200 || !str("decision")) throw new Blocked("ControlArmour: lost contact while waiting for the person's approval.");
    }
    if (str("decision") === "deny") {
      throw new Blocked(`ControlArmour blocked this: ${str("reason") || "not allowed by the house rules"}. Explain to the person and choose a different approach.`);
    }
    if (str("decision") !== "allow") throw new Blocked(`ControlArmour: unexpected decision ${JSON.stringify(str("decision"))}.`);
    return r.json;
  }

  /** Wrap an async function so ControlArmour is asked before every call and the call is recorded after. */
  guard(tool, fn, { commandFrom, pathsFrom } = {}) {
    const self = this;
    return async function guarded(...a) {
      const command = commandFrom ? commandFrom(...a) : "";
      const paths = pathsFrom ? pathsFrom(...a) : [];
      let text = "";
      try {
        text = JSON.stringify(a);
      } catch {
        text = "";
      }
      await self.ask(tool, { command, paths, text });
      try {
        const out = await fn.apply(this, a);
        await self.command(command || tool, { exitCode: 0, output: out == null ? "" : String(out), kind: "tool" });
        return out;
      } catch (e) {
        await self.command(command || tool, { exitCode: 1, output: String(e?.message || e), kind: "tool" });
        throw e;
      }
    };
  }
}
