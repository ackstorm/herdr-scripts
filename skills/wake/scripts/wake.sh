#!/usr/bin/env bash
# wake.sh: run a command at a set time in a new hc terminal, in the folder it was set from.
# Each job is a file in ~/.config/wake (due time, folder, labels, command), so jobs survive a
# restart: `wake.sh rearm` at boot starts their waits again, and runs overdue ones at once.
# Boot hooks call the copy in $dir/wake.sh: the plugin folder path changes with each version.
set -euo pipefail
PATH=$PATH:$HOME/.local/bin
dir=${WAKE_DIR:-$HOME/.config/wake}
mkdir -p "$dir"
[ "$0" -ef "$dir/wake.sh" ] || cp "$0" "$dir/wake.sh"

usage() {
  cat >&2 <<'EOF'
usage: wake.sh "<when>" "<command>"  run <command> at <when>, in a new hc terminal, in this folder
       wake.sh ls                    list the jobs
       wake.sh rm <name>             cancel one
       wake.sh rearm                 start the waits again (at boot)
<when> is anything `date -d` reads: "+2 hours", "tomorrow 08:30", 'TZ="Europe/Madrid" 08:30'.
EOF
  exit 2
}

read_job() { { read -r due; read -r cwd; read -r labels; cmd=$(cat); } <"$1"; }
armed() { pgrep -f "[w]ake-sleep $1 " >/dev/null; }
when() { date -d "@$1" '+%F %T %Z'; }

# The wait is its own session, so it outlives the shell and terminal that set it.
# The job file goes only once hc has opened the terminal: a failed run is retried at rearm.
arm() {
  local f=$1 name
  name=$(basename "$f")
  armed "$name" && return 0
  read_job "$f"
  # Short sleeps against the clock: sleep alone stops counting while the machine is suspended.
  # shellcheck disable=SC2016 # expanded by the inner sh
  setsid -f sh -c 'while n=$(date +%s); [ "$n" -lt "$1" ]; do s=$(($1 - n)); sleep $((s < 60 ? s : 60)); done
    hc run --bg --no-parent $6 --name "$2" --cwd "$3" -- zsh -ic "$4" >/dev/null && rm -f "$5"' \
    "wake-sleep $name" "$due" "$name" "$cwd" "$cmd" "$f" "$labels" </dev/null >/dev/null 2>&1
}

add() {
  local due name n=1
  due=$(date -d "$1" +%s) || usage
  ((due > $(date +%s))) || { echo "wake.sh: $(when "$due") has passed; try \"tomorrow ...\"" >&2; exit 2; }
  name=wake-$(date -d "@$due" +%m%d-%H%M)
  while [ -e "$dir/$name" ]; do n=$((n + 1)); name=wake-$(date -d "@$due" +%m%d-%H%M)-$n; done
  # herdr-app shows a terminal only in the workspace its labels name: take the setter's.
  labels=$(hc get "${HC_TERMINAL_ID:-}" --json 2>/dev/null |
    grep -oE '"(herdr\.space|ovis\.workspace)":"[^"]*"' | sed -E 's/"([^"]*)":"([^"]*)"/--label=\1=\2/' | tr '\n' ' ') || true
  printf '%s\n%s\n%s\n%s\n' "$due" "$PWD" "$labels" "$2" >"$dir/$name"
  arm "$dir/$name"
  echo "$name: $(when "$due"), in $PWD: $2"
}

case ${1:-} in
  ls)
    for f in "$dir"/wake-*; do
      [ -e "$f" ] || continue
      read_job "$f"
      state=armed; armed "$(basename "$f")" || state="not armed: wake.sh rearm"
      printf '%s  %s  (%s)\n  in %s: %s\n' "$(basename "$f")" "$(when "$due")" "$state" "$cwd" "$cmd"
    done ;;
  rm)
    [ $# -eq 2 ] && [ -e "$dir/$2" ] || { echo "wake.sh: no job ${2:-}" >&2; exit 2; }
    pkill -f "[w]ake-sleep $2 " || true
    rm -f "$dir/$2" ;;
  rearm)
    for f in "$dir"/wake-*; do [ -e "$f" ] && arm "$f"; done; true ;;
  "" | -h | --help) usage ;;
  *) [ $# -eq 2 ] || usage; add "$1" "$2" ;;
esac
