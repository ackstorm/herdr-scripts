---
name: wake
description: Run a command, or resume this agent session, at a set time in a new hc terminal, in this folder. Use when asked to wake, resume or reopen this session later, to run something at a time, or to list or cancel wake jobs.
argument-hint: <when> [prompt]
---

# wake

Each job is a file in `~/.config/wake`; at the due time it opens an `hc` terminal in the folder it was set from. A past time is refused.
`wake.sh` below is `scripts/wake.sh` in this skill's folder (`${CLAUDE_SKILL_DIR}` in Claude Code).

```sh
wake.sh '<when>' "<command>"   # anything `date -d` reads: "+2 hours", "tomorrow 08:30"
wake.sh ls                     # jobs, due time, folder, armed or not
wake.sh rm <name>              # cancel one
```

## Rearm after a reboot

A reboot kills the waits; `~/.config/wake/wake.sh rearm` starts them again and runs overdue jobs
at once. Before the first job, check `crontab -l 2>/dev/null | grep -q 'wake.sh rearm'`. When it
finds nothing, ask the user whether to add this line to their crontab, and add it only on a yes:

```
@reboot sleep 60 && $HOME/.config/wake/wake.sh rearm
```

On a no, or when `crontab` fails, tell them to run `~/.config/wake/wake.sh rearm` at boot their own
way, and do not ask again in this session.

## Resume this session

Run from the project root, with double quotes so the id expands now.

| Agent | Job command | Close this session (after setting the job) |
|---|---|---|
| Claude Code | `<launch> --resume $CLAUDE_CODE_SESSION_ID '<prompt>'` | `kill -TERM <pid>`, the pid of `$PPID` once `ps -o args= -p $PPID` shows `claude` |
| opencode | `opencode -s $OPENCODE_SESSION_ID --prompt '<prompt>'` | `hc kill "$HC_TERMINAL_ID"` (set when it runs in an `hc` terminal) |
| Codex | `codex resume $CODEX_THREAD_ID '<prompt>'` | none from inside: ask the user to quit it |

```sh
wake.sh '<when>' "<job command>"
setsid nohup sh -c 'sleep 45; <close>' >/dev/null 2>&1 </dev/null &
```

- Claude Code's `<launch>` is the line that started this session, minus any resume flag:
  `ps -o args= -p $(ps -o ppid= -p $PPID)` (e.g. `ach-cli launch claude -- --dangerously-skip-permissions`).
  Plain `claude` wakes without the user's permission mode or ACH routing and stalls at the first
  prompt with nobody to answer.
- Codex: its sandbox hides `hc` and makes `~/.config/wake` read-only, so run `wake.sh` outside the
  sandbox (ask for escalated permissions).
- Two copies of one session must not run, so close this one once the wake is set, unless the user
  asks to keep it open: start the close line above and send the last reply inside those 45 s,
  saying it closes and when it comes back. Where it cannot close itself, remind the user to close
  it before the wake fires.
- Tell the user the due time with its zone (wake.sh prints it): workspaces run UTC unless `<when>`
  holds `TZ="Europe/Madrid"`.
- The prompt sits in single quotes: write it without apostrophes, or as `'\''`. A folder never
  opened before stops on the trust/MCP dialogs; Codex also stops when its hooks are new or changed.
- Never a one-shot mode (`claude -p`, `opencode run`, `codex exec`): it answers and exits.
