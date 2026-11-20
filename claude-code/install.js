#!/usr/bin/env node
// Connects Claude Code on this computer to ControlArmour by adding hook
// entries to ~/.claude/settings.json (a backup is written first).
//   node install.js            add the hooks (safe to run again)
//   node install.js --uninstall  remove them
//   node install.js --project   write to ./.claude/settings.json instead of the user file
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.resolve(__dirname, "controlarmour-hook.js");
const MARK = "controlarmour-hook.js";
const EVENTS = { SessionStart: 120, UserPromptSubmit: 30, PreToolUse: 1800, PostToolUse: 60, Stop: 30, SessionEnd: 30, Notification: 30 };

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const project = args.includes("--project");
const dir = project ? path.join(process.cwd(), ".claude") : path.join(os.homedir(), ".claude");
const file = path.join(dir, "settings.json");

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8");
  try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}. Fix the JSON first; nothing was changed.`);
    process.exit(1);
  }
  const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, bak);
  console.log(`Backup written: ${bak}`);
} else {
  fs.mkdirSync(dir, { recursive: true });
}
if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

const command = `node "${HOOK}"`;
const isOurs = (h) => h && h.type === "command" && typeof h.command === "string" && h.command.includes(MARK);

for (const [event, timeout] of Object.entries(EVENTS)) {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  // strip any earlier ControlArmour entries
  const kept = groups
    // an older flat shape ({type:"command",command}) is kept by wrapping it in a group
    .map((g) => (g && g.type === "command" && !Array.isArray(g.hooks) ? { matcher: "*", hooks: [g] } : g))
    .map((g) => ({ ...g, hooks: Array.isArray(g.hooks) ? g.hooks.filter((h) => !isOurs(h)) : [] }))
    .filter((g) => g.hooks.length > 0);
  if (!uninstall) kept.push({ matcher: "*", hooks: [{ type: "command", command, timeout }] });
  if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log(uninstall ? `ControlArmour hooks removed from ${file}` : `ControlArmour hooks added to ${file}\nHook script: ${HOOK}\nRestart Claude Code (or start a new session) for this to take effect.`);
