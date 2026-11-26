#!/usr/bin/env bash
# wake.sh: run a command at a set time in a new hc terminal, in the folder it was set from.
# Each job is a file in ~/.config/wake, so jobs survive a restart.
# At boot, `wake.sh rearm` starts their waits again, and runs overdue ones at once.
# Boot hooks call the copy in $dir/wake.sh: the plugin folder path changes with each version.
set -euo pipefail
PATH=$PATH:$HOME/.local/bin
dir=${WAKE_DIR:-$HOME/.config/wake}
mkdir -p "$dir"
exec 9<"$dir"
flock 9
if ! [ "$0" -ef "$dir/wake.sh" ]; then
  cp "$0" "$dir/wake.sh.tmp"
  mv "$dir/wake.sh.tmp" "$dir/wake.sh"
fi
flock -u 9

usage() {
  cat >&2 <<'EOF'
usage: wake.sh "<when>" "<command>"  run <command> at <when>, in a new hc terminal, in this folder
       wake.sh resume "<when>" "<prompt>" "<screen marker>"  reopen this interactive thread
       wake.sh resume-agent "<when>" "<prompt>" "<resume command>" [client-pid]
       wake.sh ls                    list the jobs
       wake.sh rm <name>             cancel one
       wake.sh rearm                 start the waits again (at boot)
<when> is anything `date -d` reads: "+2 hours", "tomorrow 08:30", 'TZ="Europe/Madrid" 08:30'.
EOF
  exit 2
}

# The first line of a session job also identifies its client and close time.
read_job() {
  {
    read -r due close_at agent term pid start boot
    IFS= read -r cwd
    IFS= read -r labels
    if [[ -n $agent ]]; then IFS= read -r encoded_prompt; fi
    cmd=$(cat)
  } <"$1"
}

# Older sleepers identify themselves by job name and carry the job path in argv.
legacy_worker() {
  local pid
  while read -r pid; do
    if grep -Fzxq -- "$dir/$1" "/proc/$pid/cmdline" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  done < <(pgrep -f "[w]ake-sleep $1 ")
  return 1
}
armed() { ! flock -n -x "$dir/$1" true || legacy_worker "$1" >/dev/null; }
when() { date -d "@$1" '+%F %T %Z'; }

arm() {
  local f=$1
  legacy_worker "${f##*/}" >/dev/null && return 0
  # The worker inherits the job lock. Rearm can only start one worker per file.
  (
    flock -n 8 || exit 0
    setsid -f bash "$dir/wake.sh" worker "$f" 9<&- </dev/null >/dev/null 2>&1
  ) 8<"$f"
}

wait_until() {
  local target=$1 f=$2 remaining
  while (( (remaining = target - $(date +%s)) > 0 )); do
    [[ "$f" -ef /dev/fd/8 ]] || exit 0
    sleep "$((remaining < 60 ? remaining : 60))"
  done
  flock 9
  [[ "$f" -ef /dev/fd/8 ]] || exit 0
  flock -u 9
}

work() {
  local f=$1 name=${1##*/} due close_at agent term pid start boot cwd labels cmd encoded_prompt
  [[ "$f" -ef /dev/fd/8 ]] || return 0
  read_job "$f"
  if (( close_at > 0 )); then
    wait_until "$close_at" "$f"
    if [[ $boot == "$(< /proc/sys/kernel/random/boot_id)" ]]; then
      handoff "$term" "$pid" "$start" "$agent" || true
    fi
  fi
  wait_until "$due" "$f"
  if [[ -n $agent && $close_at == 0 && $boot == "$(< /proc/sys/kernel/random/boot_id)" ]] &&
     [[ $(client_start "$pid") == "$start" ]]; then
    if [[ $term == - ]]; then
      # Outside hc the calling agent receives the prompt on stdout.
      [[ ${2:-} == interactive ]] || return 1
      jq -r . <<<"$encoded_prompt"
    else
      foreground_client "$term" "$pid"
      hc send "$term" -- "$(jq -r . <<<"$encoded_prompt")" >/dev/null
    fi
  else
    if (( close_at > 0 )) && [[ $boot == "$(< /proc/sys/kernel/random/boot_id)" ]]; then
      handoff "$term" "$pid" "$start" "$agent"
    fi
    local -a label_args
    read -ra label_args <<<"$labels"
    hc run --bg --no-parent "${label_args[@]}" --name "$name" --cwd "$cwd" -- zsh -ic "$cmd" >/dev/null
  fi
  flock 9
  if [[ "$f" -ef /dev/fd/8 ]]; then rm -f "$f"; fi
}

add() {
  local due name n=1 now close_at=0 labels notice
  due=$(date -d "$1" +%s) || usage
  # herdr-app shows a terminal only in the workspace its labels name: take the setter's.
  labels=$(hc get "${HC_TERMINAL_ID:-}" --json 2>/dev/null |
    grep -oE '"(herdr\.space|ovis\.workspace)":"[^"]*"' | sed -E 's/"([^"]*)":"([^"]*)"/--label=\1=\2/' | tr '\n' ' ') || true
  flock 9
  now=$(date +%s)
  ((due > now)) || { echo "wake.sh: $(when "$due") has passed; try \"tomorrow ...\"" >&2; exit 2; }
  name=wake-$(date -d "@$due" +%m%d-%H%M)
  while [ -e "$dir/$name" ]; do n=$((n + 1)); name=wake-$(date -d "@$due" +%m%d-%H%M)-$n; done
  {
    if [[ -n ${3:-} ]]; then
      close_at=$((now + 60))
      (( due >= close_at )) || close_at=0
      printf '%s %s %s %s %s %s %s\n' "$due" "$close_at" "$3" "$4" "$5" "$6" "$(< /proc/sys/kernel/random/boot_id)"
    else
      printf '%s\n' "$due"
    fi
    printf '%s\n%s\n' "$PWD" "$labels"
    if [[ -n ${3:-} ]]; then jq -cn --arg prompt "$7" '$prompt'; fi
    printf '%s\n' "$2"
  } >"$dir/$name"
  if [[ -z ${3:-} ]]; then
    notice="$name: $(when "$due"), in $PWD: $2"
  elif (( close_at )); then
    notice="Wake set for $(when "$due"). I'll close this session in one minute, at $(when "$close_at")."
  else
    notice="I'll keep this session open and deliver the prompt at $(when "$due")."
  fi
  if [[ -n ${3:-} ]]; then notice+=" Cancel with: wake.sh rm $name"; fi
  # Without an hc terminal, keep the short timer attached to the caller.
  if [[ ${4:-} == - && $close_at == 0 ]]; then
    (
      flock -n 8
      flock -u 9
      echo "$notice"
      work "$dir/$name" interactive
    ) 8<"$dir/$name"
  else
    arm "$dir/$name"
    echo "$notice"
  fi
}

client_start() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }

resume_thread() {
  local schedule=$1 prompt=$2 marker=$3 thread=${CODEX_THREAD_ID:?missing thread ID}
  local term pid start command history requested delay
  local -a matches=()
  [[ -n $marker && -n $prompt ]] || usage
  if [[ $schedule =~ ^\+[0-9]+[[:space:]]+(second|minute|hour|day)s?$ ]]; then
    history=${CODEX_HOME:-$HOME/.codex}/history.jsonl
    if [[ -r $history ]]; then
      requested=$(jq -n --arg id "$thread" 'reduce (inputs | select(.session_id == $id)) as $entry (null; $entry.ts) // empty' "$history")
      if [[ -n $requested ]]; then
        delay=${schedule#+}
        schedule="@$(date -d "$(date -u -d "@$requested" '+%F %T UTC') +$delay" +%s)"
      fi
    fi
  fi
  while read -r term; do
    pid=$(hc get "$term" --json | jq -r --arg id "$thread" '
      .foreground | select(.name == "codex") |
      select((.argv | index("resume")) as $i | $i == null or .argv[$i+1] == $id) | .pid') || continue
    [[ -n $pid ]] || continue
    if hc read "$term" --lines 80 | grep -F -- "$marker" >/dev/null; then
      matches+=("$term $pid")
    fi
  done < <(hc ls --json | jq -r '.terminals[].address | select(test("^t[0-9a-z]+$"))')
  if (( ${#matches[@]} != 1 )); then
    echo "wake.sh: expected one local client displaying '$marker', found ${#matches[@]}" >&2
    return 1
  fi
  read -r term pid <<< "${matches[0]}"
  start=$(client_start "$pid") || return 1
  printf -v command 'codex resume %q %q' "$thread" "$prompt"
  HC_TERMINAL_ID=$term add "$schedule" "$command" codex "$term" "$pid" "$start" "$prompt"
}

resume_agent() {
  local term=${HC_TERMINAL_ID:--} agent pid start
  if [[ $term == - ]]; then
    pid=${4:?provide the current client PID outside hc}
    [[ $pid =~ ^[1-9][0-9]*$ ]] || usage
    agent=$(cat "/proc/$pid/comm")
  else
    read -r agent pid < <(hc get "$term" --json | jq -er '.foreground | [.name, .pid] | @tsv')
  fi
  [[ $agent == claude || $agent == opencode ]] ||
    { echo "wake.sh: expected a Claude Code or OpenCode client" >&2; return 1; }
  start=$(client_start "$pid") || return 1
  add "$1" "$3" "$agent" "$term" "$pid" "$start" "$2"
}

foreground_client() {
  if [[ $(hc get "$1" --json | jq -r '.foreground.pid') != "$2" ]]; then
    echo "wake.sh: the client is still running outside the foreground of $1" >&2
    return 1
  fi
}

handoff() {
  local term=$1 pid=$2 start=$3 agent=${4:-codex} attempt
  [[ $(client_start "$pid") == "$start" ]] || return 0
  if [[ $term != - ]]; then foreground_client "$term" "$pid" || return 1; fi
  case "$term:$agent" in
    *:codex) hc keys "$term" / q u i t enter >/dev/null ;;
    *:claude|-:opencode) kill -TERM "$pid" ;;
    *:opencode) hc kill "$term" >/dev/null ;;
  esac || return 1
  for attempt in {1..20}; do
    [[ $(client_start "$pid") == "$start" ]] || return 0
    sleep 0.25
  done
  echo "wake.sh: the client in $term did not exit" >&2
  return 1
}

case ${1:-} in
  resume) [ $# -eq 4 ] || usage; resume_thread "$2" "$3" "$4" ;;
  resume-agent) [[ $# == 4 || $# == 5 ]] || usage; shift; resume_agent "$@" ;;
  worker) [ $# -eq 2 ] || usage; work "$2" ;;
  handoff) [ $# -eq 4 ] || usage; handoff "$2" "$3" "$4" ;;
  ls)
    flock 9
    for f in "$dir"/wake-*; do
      [ -e "$f" ] || continue
      read_job "$f"
      state=armed; armed "$(basename "$f")" || state="not armed: wake.sh rearm"
      printf '%s  %s  (%s)\n  in %s: %s\n' "$(basename "$f")" "$(when "$due")" "$state" "$cwd" "$cmd"
    done ;;
  rm)
    flock 9
    [[ $# == 2 && ${2:-} =~ ^wake-[0-9]{4}-[0-9]{4}(-[0-9]+)?$ && -f "$dir/$2" ]] || { echo "wake.sh: no job ${2:-}" >&2; exit 2; }
    if pid=$(legacy_worker "$2"); then kill "$pid" || true; fi
    rm -f "$dir/$2" ;;
  rearm)
    flock 9
    for f in "$dir"/wake-*; do [ -e "$f" ] && arm "$f"; done; true ;;
  "" | -h | --help) usage ;;
  *) [ $# -eq 2 ] || usage; add "$1" "$2" ;;
esac
