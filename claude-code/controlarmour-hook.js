#!/usr/bin/env node
// ControlArmour adapter for Claude Code hooks. Zero dependencies.
// Licence: Apache-2.0. Public source: the ControlArmour adapters repository.
//
// Claude Code runs this script on each hook event and passes JSON on stdin.
// It reports what the agent does to ControlArmour on this computer and asks
// ControlArmour before risky tool calls. If ControlArmour is not running
// (nothing listening), the hook stays silent and Claude Code carries on (fail
// open). Once ControlArmour has answered the connection, anything other than
// a clear "allow" — an error, an unreadable answer, a lost connection, a
// crash in this script — blocks the action (fail closed).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

// Each /check or /wait call returns within ~90 s ("pending" if the person has
// not answered yet) and the hook asks again, so a long approval never runs
// into a request timeout. install.js sets the hook timeout to 1800 s.
const CHECK_WAIT_MS = 110_000;
const MAX_APPROVAL_MS = 1_500_000; // the server's own limit is 600 s; this is a safety net

function dataDir() {
  if (process.env.CONTROLARMOUR_DATA_DIR) return process.env.CONTROLARMOUR_DATA_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ControlArmour");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ControlArmour");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ControlArmour");
}

function readEndpoint() {
  try {
    const ep = JSON.parse(fs.readFileSync(path.join(dataDir(), "endpoint.json"), "utf8"));
    if (ep && ep.url && ep.ingestToken) return ep;
  } catch { /* not running */ }
  return null;
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

function request(ep, method, p, body, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(ep.url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: p, method,
      headers: { Authorization: `Bearer ${ep.ingestToken}`, "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* ignore */ }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    // "refused" means nothing is listening (ControlArmour not running): the
    // caller may fail open. Any other failure after a connection was made
    // (reset, hang-up, timeout) means ControlArmour was there and may have
    // asked the person: the caller must fail closed.
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null, lost: true }); });
    req.on("error", (e) => resolve({ status: 0, json: null, lost: !(e && (e.code === "ECONNREFUSED" || e.code === "ENOENT" || e.code === "ENOTFOUND")) }));
    if (data) req.write(data);
    req.end();
  });
}

const sessionId = (cc) => "cc-" + String(cc || "unknown").replace(/[^A-Za-z0-9._:@-]/g, "_").slice(0, 100);
const tail = (s, n) => (s.length <= n ? s : "…" + s.slice(-n));
const head = (s, n) => (s.length <= n ? s : s.slice(0, n) + "…");

// readForView reads a file for the live view: never a network path, a pipe
// or a device (opened without blocking, checked on the open handle).
function readForView(file, max) {
  if (/^(\\\\|\/\/)/.test(file)) return "";
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return "";
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch { return ""; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function lineCount(s) {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

// editMeasure counts the lines an edit takes out and puts in, and the bytes
// it puts in, from the agent's own edit (nothing is read from disk for this).
// With replace_all the count is the number of times the old text appeared in
// the file at that edit (Claude Code's own response carries the original;
// MultiEdit's edits are replayed on it in order, in memory, never stored).
function editMeasure(tool, ti, before) {
  let added = 0, removed = 0, bytes = 0;
  let text = before;
  const times = (e) => {
    const oldS = e && e.old_string, newS = e && e.new_string;
    if (!e || typeof oldS !== "string" || !oldS || !text) return 1;
    const n = text.split(oldS).length - 1;
    if (typeof newS === "string") text = e.replace_all === true ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    return e.replace_all === true ? Math.max(1, n) : 1;
  };
  const one = (oldS, newS, n = 1) => {
    if (typeof oldS === "string") removed += n * lineCount(oldS);
    if (typeof newS === "string") { added += n * lineCount(newS); bytes += n * Buffer.byteLength(newS, "utf8"); }
  };
  if (tool === "multiedit" && Array.isArray(ti.edits)) ti.edits.forEach((e) => e && one(e.old_string, e.new_string, times(e)));
  else if (tool === "notebookedit") one(undefined, ti.new_source);
  else one(ti.old_string, ti.new_string, times(ti));
  return { added, removed, bytes };
}

function langOf(file) {
  const ext = path.extname(file || "").toLowerCase().slice(1);
  return { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", go: "go", rs: "rust", java: "java",
    cs: "csharp", rb: "ruby", php: "php", sh: "bash", ps1: "powershell", json: "json", yml: "yaml", yaml: "yaml", md: "markdown",
    html: "html", css: "css", sql: "sql", c: "c", h: "c", cpp: "cpp", xml: "xml" }[ext] || "";
}

// Best effort: find the Claude Code process above this hook so ControlArmour
// can end it with "Stop everything". Only called at session start.
function findAgentPid() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
        { encoding: "utf8", timeout: 8000, windowsHide: true });
      const rows = JSON.parse(out);
      const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
      let p = byPid.get(process.pid);
      for (let i = 0; i < 6 && p; i++) {
        const name = String(p.Name || "").toLowerCase();
        const cmd = String(p.CommandLine || "").toLowerCase();
        if (p.ProcessId !== process.pid && (name.startsWith("claude") || (name.startsWith("node") && cmd.includes("claude")))) return p.ProcessId;
        p = byPid.get(p.ParentProcessId);
      }
    } else {
      let pid = process.ppid;
      for (let i = 0; i < 6 && pid > 1; i++) {
        const line = execFileSync("ps", ["-o", "ppid=,comm=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim();
        if (!line) break;
        const m = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
        if (!m) break;
        const comm = m[2].toLowerCase(), args = (m[3] || "").toLowerCase();
        if (comm.includes("claude") || (comm.startsWith("node") && args.includes("claude"))) return pid;
        pid = Number(m[1]);
      }
    }
  } catch { /* unknown */ }
  return 0;
}

// Per-session state: the last control seq acknowledged (ackSeq), the last
// message passed to the agent (msgSeq) and the prompt counter (step). Claude
// Code can run several hooks of one session at once (subagents), so every
// read-modify-write happens under a lock file, and numbers only ever go up.
function stateFile(sid) {
  const dir = path.join(dataDir(), "adapters", "state");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return path.join(dir, sid + ".json");
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
function loadState(sid) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(stateFile(sid), "utf8")); } catch { /* missing or damaged: start fresh */ }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  return { ackSeq: num(raw.ackSeq), msgSeq: num(raw.msgSeq), step: num(raw.step) };
}
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } }
function saveState(sid, st) {
  // write-then-rename so a concurrent hook never reads a half-written file;
  // Windows can refuse a rename for a moment while another process has the
  // file open, so retry briefly.
  const f = stateFile(sid), tmp = `${f}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(st)); } catch { return; }
  for (let i = 0; i < 20; i++) {
    try { fs.renameSync(tmp, f); return; } catch { sleepSync(25); }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}
// breakStale removes a lock left by a hook that died. Renaming is atomic,
// so of two hooks that both see the stale lock only one takes it away; if
// what it took turns out to be fresh (another hook had just re-created the
// lock), it is put back.
function breakStale(lock) {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= 10_000) return;
    const aside = `${lock}.${process.pid}.stale`;
    fs.renameSync(lock, aside);
    if (Date.now() - fs.statSync(aside).mtimeMs <= 10_000) {
      try { fs.linkSync(aside, lock); } catch { /* someone holds a newer lock */ }
    }
    fs.unlinkSync(aside);
  } catch { /* raced with another hook: fine */ }
}

// withState runs fn(state) under the session's lock and saves the result.
// A lock older than 10 s belongs to a hook that died and is broken.
function withState(sid, fn) {
  const lock = stateFile(sid) + ".lock";
  let held = false;
  for (let i = 0; i < 80 && !held; i++) {
    try { fs.closeSync(fs.openSync(lock, "wx")); held = true; } catch (e) {
      if (!e || e.code !== "EEXIST") break; // cannot lock at all: go on unlocked
      breakStale(lock);
      sleepSync(25);
    }
  }
  try {
    const st = loadState(sid);
    const out = fn(st);
    saveState(sid, st);
    return out;
  } finally {
    if (held) { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
  }
}

// Returns the person's instruction the first time any hook of this session
// sees it, else "".
function newMessage(control, sid) {
  if (!control || typeof control !== "object" || !control.message || typeof control.seq !== "number") return "";
  return withState(sid, (st) => {
    if (control.seq <= st.msgSeq) return "";
    st.msgSeq = control.seq;
    return String(control.message);
  });
}
const CONTEXT = (m) => `Message from the person watching via ControlArmour: ${m}`;

// Acknowledges a control change once. The server ignores an older ack, so
// two hooks acking the same change is harmless.
async function handleControl(ep, sid, control) {
  if (!control || typeof control !== "object" || typeof control.seq !== "number") return { stop: false, message: "" };
  const seen = loadState(sid).ackSeq;
  if (control.seq > seen) {
    const r = await request(ep, "POST", `/api/v1/agent/sessions/${sid}/ack`, { seq: control.seq, text: control.stop ? "stopping" : control.pause ? "pausing" : "noted" }, 3000);
    if (r.status >= 200 && r.status < 300) withState(sid, (st) => { if (control.seq > st.ackSeq) st.ackSeq = control.seq; });
  }
  return { stop: !!control.stop, message: control.message || "" };
}

// Set once ControlArmour is known to be running and a PreToolUse check is
// under way: from then on any failure, including a crash in this script,
// blocks the action.
let failClosed = false;
function blocked(why) {
  process.stderr.write(`ControlArmour: ${why} Not allowed; try again.\n`);
  process.exit(2);
}

async function main() {
  const input = readStdin();
  const ep = readEndpoint();
  if (!ep) return; // ControlArmour not running: do nothing
  const sid = sessionId(input.session_id);
  const ev = input.hook_event_name || "";
  if (ev === "PreToolUse") failClosed = true;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const post = (events, timeout = 4000) => request(ep, "POST", `/api/v1/agent/sessions/${sid}/events`, events, timeout);

  switch (ev) {
    case "SessionStart": {
      const r = await post([
        { type: "session", data: { title: `${path.basename(cwd) || "Claude Code"} (Claude Code)`, agent: "claude-code", pid: findAgentPid(), cwd } },
        { type: "status", data: { status: "waiting" } },
        { type: "note", data: { kind: "info", text: `Claude Code session started (${input.source || input.matcher || "startup"})` } },
      ]);
      if (r.status === 402) process.stderr.write("ControlArmour: " + (r.json && r.json.error ? r.json.error : "licence problem") + "\n");
      return;
    }
    case "UserPromptSubmit": {
      const prev = withState(sid, (st) => { const p = st.step; st.step = p + 1; return p; });
      const prompt = String(input.prompt || "");
      const events = [{ type: "status", data: { status: "running" } }];
      if (prev > 0) events.push({ type: "step", data: { id: String(prev), status: "done" } }); // close the last one if Stop never fired
      events.push({ type: "step", data: { id: String(prev + 1), title: head(prompt.replace(/\s+/g, " "), 90) || "Prompt", status: "running" } });
      const r = await post(events);
      const control = r.json && r.json.control;
      await handleControl(ep, sid, control);
      const m = newMessage(control, sid);
      if (m) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: CONTEXT(m) } }));
      return;
    }
    case "PreToolUse": {
      const tool = typeof input.tool_name === "string" && input.tool_name ? input.tool_name : "tool";
      const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
      const command = typeof ti.command === "string" ? ti.command : "";
      const paths = ["file_path", "path", "notebook_path"].map((k) => ti[k]).filter((v) => typeof v === "string");
      // A Glob pattern written as a full path names the folder it lists.
      if (typeof ti.pattern === "string" && /^(?:[\/\\~]|[A-Za-z]:[\/\\])/.test(ti.pattern) && /glob/i.test(tool)) paths.push(ti.pattern);
      let text = "";
      try { text = head(JSON.stringify(ti), 4000); } catch { /* ignore */ }
      const summary = command ? `${tool}: ${head(command, 160)}` : paths.length ? `${tool}: ${paths[0]}` : tool;
      // Honour a stop or pause already requested by the person.
      let message = "";
      const ctl = await request(ep, "GET", `/api/v1/agent/sessions/${sid}/control`, undefined, 3000);
      if (ctl.status === 200 && ctl.json) {
        message = newMessage(ctl.json, sid);
        const c = await handleControl(ep, sid, ctl.json);
        if (c.stop) { process.stderr.write("ControlArmour: the person stopped this agent. Do not continue; wait for new instructions.\n"); process.exit(2); }
        if (ctl.json.pause) {
          const until = Date.now() + 100_000;
          let paused = true;
          while (paused && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 2000));
            const again = await request(ep, "GET", `/api/v1/agent/sessions/${sid}/control`, undefined, 3000);
            if (again.status === 402) { paused = false; break; } // licence lapsed mid-pause: ControlArmour no longer works, carry on
            if (again.status !== 200 || !again.json) break;
            if (again.json.stop) { process.stderr.write("ControlArmour: the person stopped this agent.\n"); process.exit(2); }
            paused = !!again.json.pause;
            message = newMessage(again.json, sid) || message;
            await handleControl(ep, sid, again.json);
          }
          if (paused) { process.stderr.write("ControlArmour: this agent is paused by the person. Stop and wait for them to resume.\n"); process.exit(2); }
        }
      }
      let r = await request(ep, "POST", `/api/v1/agent/sessions/${sid}/check`, { tool, command, paths, text, summary, cwd, toolUseId: input.tool_use_id || undefined }, CHECK_WAIT_MS);
      if (r.status === 0 && !r.lost) { failClosed = false; return; } // nothing listening: ControlArmour is not running, fail open as documented
      // ControlArmour answered the connection and then went away mid-check:
      // it may have been asking the person. Fail closed.
      if (r.status === 0) blocked("lost contact while checking this action.");
      // Any other answer that is not a readable decision (wrong token, the
      // command too large to check, an internal error) blocks the action.
      if (r.status !== 200 || !r.json || typeof r.json.decision !== "string") {
        // If whatever answered is not ControlArmour (it crashed and left
        // endpoint.json behind, and another program took the port), this is
        // the same as ControlArmour not running: fail open, and say so.
        const h = await request(ep, "GET", "/api/v1/health", undefined, 3000);
        // Only a clear "not ControlArmour" (another program answered, or
        // nothing is listening any more) falls open. A health check that is
        // itself cut off or times out says nothing, so it blocks.
        if (h.status === 0 && h.lost) blocked("lost contact while checking this action.");
        if (!(h.status === 200 && h.json && h.json.app === "controlarmour")) {
          failClosed = false;
          process.stderr.write(`ControlArmour: something other than ControlArmour answers at ${ep.url}; not checking. Start ControlArmour again.\n`);
          return;
        }
        const why = r.json && r.json.error ? String(r.json.error) : `unexpected answer (${r.status})`;
        blocked(`could not check this action: ${why}.`);
      }
      // Once an approval has been asked for, the answer must come from a person:
      // keep waiting, and if the connection is lost, fail closed.
      const deadline = Date.now() + MAX_APPROVAL_MS;
      while (r.json.decision === "pending" && r.json.approvalId) {
        if (Date.now() > deadline) { process.stderr.write("ControlArmour: nobody answered the approval request. Not allowed.\n"); process.exit(2); }
        r = await request(ep, "POST", `/api/v1/agent/sessions/${sid}/approvals/${encodeURIComponent(r.json.approvalId)}/wait`, {}, CHECK_WAIT_MS);
        if (r.status === 402) { failClosed = false; process.stderr.write("ControlArmour: the licence has lapsed, so ControlArmour is no longer checking actions.\n"); return; }
        if (r.status !== 200 || !r.json || typeof r.json.decision !== "string") blocked("lost contact while waiting for the person's approval.");
      }
      if (r.json.decision !== "allow" && r.json.decision !== "deny") blocked(`could not check this action: unexpected decision "${r.json.decision}".`);
      if (r.json.decision === "deny") {
        process.stderr.write(`ControlArmour blocked this: ${r.json.reason || "not allowed by the house rules"}. Explain to the person and choose a different approach.\n`);
        process.exit(2);
      }
      if (r.json.approvalId || message) {
        const out = { hookEventName: "PreToolUse" };
        if (r.json.approvalId) { out.permissionDecision = "allow"; out.permissionDecisionReason = "Approved by the person via ControlArmour"; }
        if (message) out.additionalContext = CONTEXT(message);
        process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
      }
      return;
    }
    case "PostToolUse": {
      const tool = input.tool_name || "tool";
      const ti = input.tool_input || {};
      const tr = input.tool_response;
      const events = [];
      const file = ti.file_path || ti.notebook_path || ti.path;
      const lower = tool.toLowerCase();
      if (lower === "read" || lower === "glob" || lower === "grep" || lower === "ls") {
        if (file) events.push({ type: "file", data: { path: file, action: "read" } });
        // A search pattern can itself be sensitive: only its length is sent
        // (DECISION PENDING COUNSEL: record patterns or not).
        else if (ti.pattern) events.push({ type: "note", data: { kind: "info", text: `${tool}: a pattern of ${String(ti.pattern).length} characters` } });
      } else if (lower === "write") {
        const content = typeof ti.content === "string" ? ti.content : "";
        events.push({ type: "file", data: { path: file || "", action: "write", lines: lineCount(content), bytes: Buffer.byteLength(content, "utf8"), toolUseId: input.tool_use_id || undefined } });
        // live view only: ControlArmour never stores the content
        if (file && content.length <= 200_000) events.push({ type: "code", data: { path: file, language: langOf(file), content } });
      } else if (lower === "edit" || lower === "multiedit" || lower === "notebookedit") {
        // read for the live view only (never stored): a regular local file,
        // opened without blocking, at most 200 KB
        const content = file ? readForView(file, 200_000) : "";
        const tr0 = input.tool_response;
        const orig = tr0 && typeof tr0 === "object" && typeof tr0.originalFile === "string" ? tr0.originalFile : "";
        const em = editMeasure(lower, ti, orig);
        events.push({ type: "file", data: { path: file || "", action: "write", lines: lineCount(content), ...em, toolUseId: input.tool_use_id || undefined } });
        // live view only: ControlArmour never stores the content
        if (content) {
          const changed = [];
          const needle = typeof ti.new_string === "string" ? ti.new_string.split("\n")[0] : "";
          if (needle) content.split("\n").forEach((l, i) => { if (l.includes(needle) && changed.length < 50) changed.push(i + 1); });
          events.push({ type: "code", data: { path: file, language: langOf(file), content, changed } });
        }
      } else if (lower === "bash" || lower.includes("shell") || lower.includes("powershell")) {
        let out = "";
        let exit;
        if (typeof tr === "string") out = tr;
        else if (tr && typeof tr === "object") {
          out = [tr.stdout, tr.stderr, tr.output, tr.content].filter((x) => typeof x === "string").join("\n");
          if (typeof tr.exit_code === "number") exit = tr.exit_code;
          else if (typeof tr.exitCode === "number") exit = tr.exitCode;
          else if (tr.interrupted === true) exit = 130;
        }
        if (exit === undefined) exit = 0;
        // the output is for the live view only; ControlArmour stores its size
        events.push({ type: "command", data: { id: input.tool_use_id || undefined, kind: "shell", cwd, cmd: String(ti.command || ""), exit, out: tail(out, 4000),
          outBytes: Buffer.byteLength(out, "utf8"), outLines: lineCount(out) } });
      } else {
        events.push({ type: "note", data: { kind: "info", text: `Used ${tool}${file ? ": " + file : ""}` } });
      }
      const r = await post(events);
      await handleControl(ep, sid, r.json && r.json.control);
      const m = newMessage(r.json && r.json.control, sid);
      if (m) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: CONTEXT(m) } }));
      return;
    }
    case "Stop": {
      const events = [{ type: "status", data: { status: "waiting" } }];
      const step = loadState(sid).step;
      if (step) events.push({ type: "step", data: { id: String(step), status: "done" } });
      const r = await post(events);
      await handleControl(ep, sid, r.json && r.json.control);
      const m = newMessage(r.json && r.json.control, sid);
      if (m) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: CONTEXT(m) } }));
      return;
    }
    case "SessionEnd": {
      await post([{ type: "status", data: { status: "done" } }, { type: "note", data: { kind: "info", text: `Session ended (${input.reason || "exit"})` } }]);
      try { fs.unlinkSync(stateFile(sid)); } catch { /* ignore */ }
      return;
    }
    case "Notification": {
      await post([{ type: "note", data: { kind: "question", text: head(String(input.message || input.title || "Claude Code needs attention"), 500) } }]);
      return;
    }
    default:
      return;
  }
}

// An error thrown outside the main promise chain (inside a socket callback,
// say) is handled the same way.
for (const evName of ["uncaughtException", "unhandledRejection"]) {
  process.on(evName, (e) => {
    const msg = e && e.message ? e.message : String(e);
    if (failClosed) blocked(`the safety check failed (${msg}).`);
    process.stderr.write(`controlarmour-hook: ${msg}\n`);
    process.exit(0);
  });
}

main().then(() => process.exit(0), (e) => {
  const msg = e && e.message ? e.message : String(e);
  if (failClosed) blocked(`the safety check failed (${msg}).`);
  process.stderr.write(`controlarmour-hook: ${msg}\n`);
  process.exit(0);
});
