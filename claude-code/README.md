# ControlArmour adapter for Claude Code

Reports what Claude Code does to ControlArmour on this computer and asks it
before risky tool calls. No dependencies; needs Node 18 or newer.

This is the readable reference. The ControlArmour app installs its own
binary as the hook instead (`ControlArmour hook claude-code`, Go source in
`internal/hook`, same licence), so a customer's computer needs no Node; the
sandbox hook test gives identical results through both.

```
node install.js             # adds hooks to ~/.claude/settings.json (backup first)
node install.js --project   # per-project: ./.claude/settings.json
node install.js --uninstall
```

What it does on each hook:

| Hook | Reported to ControlArmour |
|---|---|
| SessionStart | registers the session (folder name, process id) |
| UserPromptSubmit | a new step (the prompt); delivers any instruction the person sent |
| PreToolUse | asks `/check`: house rules can block (exit 2) or pause for the person's answer; honours Stop and Pause |
| PostToolUse | files read/written, commands with output, the file being edited |
| Stop / SessionEnd | marks the step done, the session waiting or finished |
| Notification | a question note |

If ControlArmour is not running, or the licence has lapsed, the hook does
nothing and Claude Code continues normally.
