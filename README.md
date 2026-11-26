# herdr-scripts

Small tools around [herdr](https://herdr.dev) and herdr-core (`hc`).

## wake

Runs a command at a set time in a new `hc` terminal, in the folder you set it from.
For a session wake, the skill announces the close and resume times. You have one minute
to cancel before the client closes. Wakes less than a minute away deliver the prompt
in the open session.
Jobs are files in `~/.config/wake`, so they survive a restart. It ships as a Claude Code
plugin whose `wake` skill (`/wake <when> [prompt]`) runs it for you.

```sh
wake.sh "+2 hours" "ping -c 3 example.com"
wake.sh ls         # jobs, due time, folder, armed or not
wake.sh rm <name>  # cancel one
wake.sh rearm      # start the waits again; overdue jobs run at once
```

`<when>` is anything `date -d` reads. A time already past is refused.

- **Resume an agent session.** Use the [wake skill](skills/wake/SKILL.md) from the session you want to resume. Its confirmation includes the job name for `wake.sh rm <name>`.
- **The command runs under `zsh -ic`**, so your aliases and `~/.zshrc` apply.
- **A new terminal opens as a tab in the herdr-app workspace you set it from.** Set from outside
  herdr-app, it opens where the app does not show it: reach it with `hc attach`.
- **Wake removes the job after `hc` accepts the prompt or opens the terminal.** A failed run is retried at the
  next `rearm`.
- **A machine that is off runs nothing.** At the next boot, `rearm` runs what came due.

Install on Linux with `hc`, `setsid`, `flock`, and GNU `date`. Session wakes also use `jq`. The repository is the plugin, with a
manifest per agent at its root:

```sh
claude   plugin marketplace add ackstorm/herdr-scripts && claude plugin install herdr-scripts@herdr-scripts
codex    plugin marketplace add ackstorm/herdr-scripts && codex  plugin add     herdr-scripts@herdr-scripts
opencode plugin add herdr-scripts@git+https://github.com/ackstorm/herdr-scripts.git        # OpenCode 2
opencode plugin herdr-scripts@git+https://github.com/ackstorm/herdr-scripts.git --global   # OpenCode 1
pi       install git:github.com/ackstorm/herdr-scripts
agy      plugin install https://github.com/ackstorm/herdr-scripts                          # Antigravity
```

Re-running the install does not update Claude Code or Codex; refresh the marketplace first:

```sh
claude plugin marketplace update herdr-scripts  && claude plugin update herdr-scripts@herdr-scripts
codex  plugin marketplace upgrade herdr-scripts && codex  plugin add    herdr-scripts@herdr-scripts
```

Every run copies the script to `~/.config/wake/wake.sh`, a path that survives plugin updates: use
it from a shell (or link it into `~/.local/bin`) and from boot hooks.

**Rearm at boot.** The skill offers to add `@reboot sleep 60 && $HOME/.config/wake/wake.sh rearm`
to your crontab. Without cron, run `~/.config/wake/wake.sh rearm` at boot your own way (on a Coder
workspace, in its startup script).

## mods/remote-sync

A [Herdr app](https://herdr.dev) mod that keeps your agents' global config the same on
your remote machines (`hc machine ls`): it copies the paths listed in `config.json` and
links every agent's global instructions file to one source. On each remote it keeps the
keys that machine's own tools write (ACH marketplaces and plugins, herdr's status line).

```sh
ln -s ~/Projects/herdr-scripts/mods/remote-sync ~/.config/herdr-app/mods/remote-sync
cp ~/Projects/herdr-scripts/mods/remote-sync/config.example.json \
   ~/Projects/herdr-scripts/mods/remote-sync/config.json   # then edit it
```

`config.json`: `paths` lists files or folders relative to home, or `{ "from", "to" }`
pairs; `skip` lists paths and agent keys to leave alone.
