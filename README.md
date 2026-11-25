# herdr-scripts

Small tools around [herdr](https://herdr.dev) and herdr-core (`hc`).

## wake

Runs a command at a set time in a new `hc` terminal, in the folder you set it from.
Jobs are files in `~/.config/wake`, so they survive a restart.

```sh
wake "+2 hours" "ping -c 3 example.com"
wake 'TZ="Europe/Madrid" tomorrow 08:30' "claude --resume $CLAUDE_CODE_SESSION_ID 'check last night backups'"
wake ls            # jobs, due time, folder, armed or not
wake rm <name>     # cancel one
wake rearm         # start the waits again; overdue jobs run at once
```

`<when>` is anything `date -d` reads. A time already past is refused.

- **Resume an agent session.** Run `wake` from inside the session, with the command in
  double quotes so `$CLAUDE_CODE_SESSION_ID` expands when you set it. Close the session
  before it fires, or two copies write to one conversation.
- **The command runs under `zsh -ic`**, so your aliases and `~/.zshrc` apply.
- **A job file goes only once `hc` opens its terminal.** A failed run is retried at the
  next `rearm`.
- **A machine that is off runs nothing.** At the next boot, `rearm` runs what came due.

Install (Linux; needs `hc`, `setsid`, GNU `date`):

```sh
git clone https://github.com/ackstorm/herdr-scripts ~/Projects/herdr-scripts
ln -s ~/Projects/herdr-scripts/bin/wake ~/.local/bin/wake
(crontab -l 2>/dev/null; echo '@reboot sleep 60 && $HOME/.local/bin/wake rearm') | crontab -
```

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
