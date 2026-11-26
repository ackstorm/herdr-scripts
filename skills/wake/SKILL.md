---
name: wake
description: Run a command, or resume this agent session, at a set time in a new hc terminal, in this folder. Use when asked to wake, resume or reopen this session later, to run something at a time, or to list or cancel wake jobs.
argument-hint: <when> [prompt]
---

# wake

Wake stores jobs in `~/.config/wake`. Commands open in a new `hc` terminal in the folder where you scheduled them.
`wake.sh` below is `scripts/wake.sh` in this skill's folder (`${CLAUDE_SKILL_DIR}` in Claude Code).

```sh
wake.sh '<when>' "<command>"   # anything `date -d` reads: "+2 hours", "tomorrow 08:30"
wake.sh ls                     # jobs, due time, folder, armed or not
wake.sh rm <name>              # cancel one
```

## Scheduling a session wake

Run the bundled script from the project folder with the user's requested time and prompt. For a delayed greeting, the prompt can be `Greet the user now.`

As soon as the job is armed, tell the user when the session will close, when it will resume (include the time zone), and how to cancel. Use the times and job name printed by the script.

> Wake is set for 12:10 CET. I’ll close this session in one minute, at 12:01 CET. Say “cancel” before then to stop both (job `wake-1126-1210`).

If the wake is less than one minute away when armed, tell the user the session stays open and when the prompt will arrive. If the user cancels or you spot a scheduling mistake, run `wake.sh rm <name>` immediately. The job handles closing the client.

## Codex in hc

Put a fresh, distinctive marker in one short progress message so Wake can identify this terminal.
Then run the bundled script once on the host from the project folder:

```sh
bash "<this skill's folder>/scripts/wake.sh" resume "+2 minutes" "Greet the user now." "<the marker you just displayed>"
```

For relative delays in seconds, minutes, hours or days, Wake uses the latest prompt timestamp for this thread when available. The one-minute cancellation window starts when the job is scheduled.

## Rearm after a reboot

A reboot kills the waits; `~/.config/wake/wake.sh rearm` starts them again and runs overdue jobs
at once. When setting up reboot recovery, or before the first generic, Claude Code or OpenCode job, check `crontab -l 2>/dev/null | grep -q 'wake.sh rearm'`. When it
finds nothing, ask the user whether to add this line to their crontab, and add it only on a yes:

```
@reboot sleep 60 && $HOME/.config/wake/wake.sh rearm
```

On a no, or when `crontab` fails, tell them to run `~/.config/wake/wake.sh rearm` at boot their own
way, and do not ask again in this session.

## Claude Code or OpenCode

Pass the prompt and the command that resumes this session. Shell-quote the session ID and prompt when constructing the command. For OpenCode, use the current session ID.

```sh
prompt='Greet the user now.'
printf -v resume_cmd 'opencode -s %q --prompt %q' "$OPENCODE_SESSION_ID" "$prompt"
wake.sh resume-agent '+2 minutes' "$prompt" "$resume_cmd"
```

For Claude Code, use its original launch command and flags followed by `--resume`, the session ID and the prompt. Preserve the launcher's routing and permission mode. This example assumes the session was launched with `claude` alone.

```sh
prompt='Greet the user now.'
printf -v resume_cmd 'claude --resume %q %q' "$CLAUDE_CODE_SESSION_ID" "$prompt"
wake.sh resume-agent '+2 minutes' "$prompt" "$resume_cmd"
```

Use an interactive resume command. A folder opened for the first time may ask for trust or MCP approval before it accepts the prompt.

Outside `hc`, identify the current client PID from the calling process’s ancestry and verify its name with `ps -o comm= -p "$client_pid"`. Pass that PID as the final argument to `resume-agent`. For a short wake, keep the command running in the foreground. Relay its confirmation as soon as it prints, then act on the prompt when the command returns it. Cancellation ends the wait without a prompt.
