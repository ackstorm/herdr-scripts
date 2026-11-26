---
name: wake
description: Run a command, or resume this agent session, at a set time in a new hc terminal, in this folder. Use when asked to wake, resume or reopen this session later, to run something at a time, or to list or cancel wake jobs.
argument-hint: <when> [prompt]
---

# wake

Run `"${CLAUDE_SKILL_DIR}/wake"` (called `wake` below). Each job is a file in `~/.config/wake`; at the
due time it opens an `hc` terminal in the folder it was set from. A past time is refused.

```sh
wake '<when>' "<command>"   # <when>: anything `date -d` reads: "+2 hours", "tomorrow 08:30"
wake ls                     # jobs, due time, folder, armed or not
wake rm <name>              # cancel one
```

## Rearm after a reboot

A reboot kills the waits; `~/.config/wake/wake rearm` starts them again and runs overdue jobs
at once. Before the first job, check `crontab -l 2>/dev/null | grep -q 'wake rearm'`. When it
finds nothing, ask the user whether to add this line to their crontab, and add it only on a yes:

```
@reboot sleep 60 && $HOME/.config/wake/wake rearm
```

On a no, or when `crontab` fails, tell them to run `~/.config/wake/wake rearm` at boot their own
way, and do not ask again in this session.

## Resume this session

Run from the project root, with double quotes so the id expands now. `<launch>` is the line that
started this session, minus any resume flag: `ps -o args= -p $(ps -o ppid= -p $PPID)` (e.g.
`ach-cli launch claude -- --dangerously-skip-permissions`). Plain `claude` wakes without the
user's permission mode or ACH routing and stalls at the first prompt with nobody to answer.

```sh
wake '<when>' "<launch> --resume $CLAUDE_CODE_SESSION_ID '<prompt>'"
```

- Tell the user the due time with its zone (wake prints it): workspaces run UTC unless `<when>`
  holds `TZ="Europe/Madrid"`.
- Two copies of one session must not run. Asked to close it as well: check `ps -o args= -p $PPID`
  is this `claude`, run `setsid nohup sh -c 'sleep 45; kill -TERM <that pid>' >/dev/null 2>&1 </dev/null &`,
  and send the last reply inside those 45 s. Otherwise remind the user to close it before the wake fires.
- The prompt sits in single quotes: write it without apostrophes, or as `'\''`. A folder never
  opened before stops on the trust/MCP dialogs.
- Never `claude -p` here: it answers and exits.
