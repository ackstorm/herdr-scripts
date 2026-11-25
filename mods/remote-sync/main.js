
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  exec, hc, home, appHome, machines, knownAgents, readTextFile, writeTextFile,
  shared, setShared, theme, props, closeOverlay,
} from "herdr";

// Where each agent reads its global instructions, by knownAgents() key, relative to home.
// Each becomes a symlink to SOURCE. Agents herdr knows but absent here have no global
// file (kimi, cursor, q) or no verified one; gemini is excluded on purpose.
const LINKS = {
  claude: ".claude/CLAUDE.md",
  codex: ".codex/AGENTS.md",
  opencode: ".config/opencode/AGENTS.md",
  pi: ".pi/agent/AGENTS.md",
  amp: ".config/amp/AGENTS.md",
  copilot: ".copilot/copilot-instructions.md",
  crush: ".config/crush/CRUSH.md",
  grok: ".grok/AGENTS.md",
  kiro: ".kiro/steering/AGENTS.md",
};
const STATUS = "remote-sync.status";
const REQUEST = "remote-sync.request";
const INFO = "remote-sync.info";
const LOCAL = "this computer";
const EVERY = 15 * 60 * 1000;

// Every synced path is copied as this computer has it, except these files: the remote
// keeps the keys its own tools write there (ACH hydrate's marketplace and plugins, named
// per machine; herdr's status line command and opencode plugin), and this computer's home
// is rewritten to the remote's.
const isAch = (k) => /(^|@)ach-/.test(k);
const isHerdr = (p) => JSON.stringify(p).includes("herdr");
const pick = (o = {}, keep) => Object.fromEntries(Object.entries(o).filter(([k]) => keep(k)));
const REMOTE_KEYS = {
  ".claude/settings.json": (mine, theirs) => {
    for (const key of ["extraKnownMarketplaces", "enabledPlugins"])
      mine[key] = { ...pick(mine[key], (k) => !isAch(k)), ...pick(theirs[key], isAch) };
    if (isHerdr(theirs.statusLine ?? "")) mine.statusLine = { ...mine.statusLine, command: theirs.statusLine.command };
  },
  ".config/opencode/cli.json": (mine, theirs) => {
    const plugins = [...(mine.plugins ?? []).filter((p) => !isHerdr(p)), ...(theirs.plugins ?? []).filter(isHerdr)];
    if (plugins.length) mine.plugins = plugins; else delete mine.plugins;
  },
};

// Args: from to pairs. Prints "from<TAB>to" for each file, a folder expanded to its files.
const LIST = `cd && while [ $# -gt 1 ]; do f=$1 t=$2; shift 2
  if [ -d "$f" ]; then find "$f" -type f | while IFS= read -r p; do printf '%s\\t%s\\n' "$p" "$t\${p#"$f"}"; done
  elif [ -f "$f" ]; then printf '%s\\t%s\\n' "$f" "$t"; fi
done`;
const HASH = 'cd && sha256sum "$@" 2>/dev/null; true';
// A symlink on the remote never matches, so the pushed file replaces it.
const HASH_REMOTE = 'cd && for p; do [ -L "$p" ] || sha256sum "$p" 2>/dev/null; done; true';
// Backs up a remote file once, before the first push that changes it; a symlink there is
// replaced by the pushed file.
const BACKUP = `cd && d=$1; shift; for p; do
  if [ -e "$p" ] && ! ls "$p".bak-* >/dev/null 2>&1; then cp -p "$p" "$p.bak-$d"; fi
  if [ -L "$p" ]; then rm "$p"; fi
done; true`;
const STAGE = 'mktemp -d "${TMPDIR:-/tmp}/remote-sync.XXXXXX"';
const COPY = 'mkdir -p "$1/$(dirname "$3")" && cp -p "$HOME/$2" "$1/$3"';
// ponytail: content travels as one argument, capped at 128 KiB by the kernel; fine for settings files.
const WRITE = 'mkdir -p "$1/$(dirname "$2")" && printf %s "$3" > "$1/$2"';
// Files only, so tar never touches the remote's folder permissions (home included).
const SEND = `cd "$1" && find . -type f | tar -cf - -T - | hc exec --stdin --timeout 120 --on "$2" -- sh -c 'cd && tar -xf -'; r=$?; rm -rf "$1"; exit $r`;
// "+path" links path to the source (backing up a real file once); "-path" removes the
// link only if it is ours.
const LINK = `src="$HOME/.agents/AGENTS.md"; d=$1; shift
for a; do t="$HOME/\${a#?}"
  case $a in
  +*) [ "$(readlink "$t")" = "$src" ] && continue
      mkdir -p "$(dirname "$t")" || exit 1
      if [ -e "$t" ] && [ ! -L "$t" ] && ! ls "$t".bak-* >/dev/null 2>&1; then cp -p "$t" "$t.bak-$d" || exit 1; fi
      ln -sfn "$src" "$t" || exit 1 ;;
  -*) if [ -L "$t" ] && [ "$(readlink "$t")" = "$src" ]; then rm "$t" || exit 1; fi ;;
  esac
done`;

const configPath = () => `${appHome()}/mods/remote-sync/config.json`;
const today = () => new Date().toISOString().slice(0, 10);
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const pair = (e) => (typeof e === "string" ? { from: e, to: e } : e);
const connected = () => new Set([LOCAL, ...machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name)]);
const hashes = (out) => new Map(out.trim().split("\n").filter(Boolean).map((l) => {
  const [h, p] = l.split(/\s+/);
  return [p, h];
}));

async function sh(script, args, on) {
  const r = await exec("sh", ["-c", script, "sh", ...args], on ? { on } : {});
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
  return r.stdout;
}

// Only machines connected now are kept, so the count is of those.
function setStatus(name, value) {
  const keep = connected();
  const all = { ...(shared(STATUS) ?? {}), ...(name ? { [name]: value } : {}) };
  setShared(STATUS, pick(all, (n) => keep.has(n)));
}

// What the status bar needs besides per-machine results: machines syncing, config error.
function setInfo(busy, configError) {
  setShared(INFO, { busy: [...busy], configError });
}

export default class RemoteSync extends View {
  init(_props, cx) {
    this.panel = Boolean(props()?.panel);
    this.prev = new Map();
    this.busy = new Set();
    this.request = shared(REQUEST) ?? 0;
    cx.spawn(async (cx) => {
      await this.loadConfig();
      if (!this.panel) setInfo(this.busy, this.configError);
      cx.notify();
    });
    if (!this.panel) cx.timer.every(EVERY, (cx) => this.syncAll(cx));
  }

  async loadConfig() {
    try {
      this.configText = await readTextFile(configPath());
      if (this.configText === null) {
        this.configText = '{ "skip": [], "paths": [] }\n';
        await writeTextFile(configPath(), this.configText, null);
      }
      const config = JSON.parse(this.configText);
      if (!Array.isArray(config.skip)) throw new Error('"skip" must be a list of paths and agent keys');
      if (!Array.isArray(config.paths)) throw new Error('"paths" must be a list of paths or { from, to }');
      this.paths = config.paths.map(pair);
      if (this.paths.some((p) => !p.from || !p.to)) throw new Error("every path needs from and to");
      this.config = config;
      this.skip = new Set(config.skip);
      this.configError = null;
    } catch (e) {
      this.skip = null;
      this.configError = `config.json: ${e.message ?? e}`;
    }
  }

  syncAll(cx) {
    if (!this.skip) return;
    this.syncOne(null, cx);
    for (const m of machines()) if (m.name && m.layout === "ready") this.syncOne(m.name, cx);
  }

  // Called from render, so nothing may notify or set shared state before the first
  // await: a spawned task runs synchronously until then, and both throw during render.
  syncOne(name, cx) {
    const label = name ?? LOCAL;
    if (this.busy.has(label)) return;
    this.busy.add(label);
    cx.spawn(async (cx) => {
      await null;
      setInfo(this.busy, this.configError);
      try {
        if (name) {
          const ls = JSON.parse((await hc(["machine", "ls", "--json"])).stdout);
          if (ls.machines.find((m) => m.name === name)?.temporary) return;
          await this.push(name);
        }
        const agents = await knownAgents(name ? { on: name } : {});
        const installed = agents.filter((a) => a.installed).map((a) => a.key);
        const args = Object.entries(LINKS).map(([key, path]) =>
          (installed.includes(key) && !this.skip.has(key) ? "+" : "-") + path);
        await sh(LINK, [today(), ...args], name);
        setStatus(label, { ok: true, at: Date.now(), installed, known: agents.map((a) => a.key) });
      } catch (e) {
        setStatus(label, { ...(shared(STATUS)?.[label] ?? {}), ok: false, at: Date.now(), error: String(e.message ?? e) });
      } finally {
        this.busy.delete(label);
        setInfo(this.busy, this.configError);
        cx.notify();
      }
    });
  }

  async push(name) {
    const on = this.paths.filter((p) => !this.skip.has(p.to)).flatMap((p) => [p.from, p.to]);
    const files = (await sh(LIST, on)).split("\n").filter(Boolean).map((l) => l.split("\t"));
    if (!files.length) return;
    const mine = hashes(await sh(HASH, files.map(([f]) => f)));
    const theirs = hashes(await sh(HASH_REMOTE, files.map(([, t]) => t), name));
    const remoteHome = (await sh('echo "$HOME"', [], name)).trim();
    const changed = [];
    for (const [from, to] of files) {
      const merge = REMOTE_KEYS[to];
      if (!merge) {
        if (mine.get(from) !== theirs.get(to)) changed.push([from, to]);
        continue;
      }
      const local = JSON.parse((await readTextFile(`${home()}/${from}`)).replaceAll(`${home()}/`, `${remoteHome}/`));
      const remote = await readTextFile(`${remoteHome}/${to}`, { on: name });
      merge(local, remote ? JSON.parse(remote) : {});
      const want = `${JSON.stringify(local, null, 2)}\n`;
      if (want !== remote) changed.push([from, to, want]);
    }
    if (!changed.length) return;
    const stage = (await sh(STAGE, [])).trim();
    for (const [from, to, want] of changed)
      await (want === undefined ? sh(COPY, [stage, from, to]) : sh(WRITE, [stage, to, want]));
    await sh(BACKUP, [today(), ...changed.map(([, to]) => to)], name);
    await sh(SEND, [stage, name]);
  }

  async toggle(key) {
    const skip = new Set(this.skip);
    if (skip.has(key)) skip.delete(key); else skip.add(key);
    // Saving config.json reloads every copy of the mod, which syncs again.
    const config = { ...this.config, skip: [...skip].sort() };
    await writeTextFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, this.configText);
  }

  render(cx) {
    return this.panel ? this.renderPanel(cx) : this.renderBar(cx);
  }

  renderBar(cx) {
    const request = shared(REQUEST) ?? 0;
    if (this.skip) {
      if (request !== this.request) {
        this.request = request;
        this.syncAll(cx);
      }
      // A machine whose layout turns ready gets a push; the first render after load syncs all.
      if (!this.prev.has(LOCAL)) {
        this.prev.set(LOCAL, "ready");
        this.syncOne(null, cx);
      }
      for (const m of machines()) {
        if (!m.name) continue;
        const was = this.prev.get(m.name);
        this.prev.set(m.name, m.layout);
        if (m.layout === "ready" && was !== "ready") this.syncOne(m.name, cx);
      }
      // A machine that left drops out of the count.
      const keep = connected();
      if (Object.keys(shared(STATUS) ?? {}).some((n) => !keep.has(n))) cx.spawn(async () => { await null; setStatus(); });
    }
    // The engine shows nothing: workspace-status-sync draws the label from shared state.
    return div().id("remote-sync").size(0);
  }

  renderPanel() {
    const t = theme();
    const st = shared(STATUS) ?? {};
    const names = Object.keys(st);
    const known = [...new Set([...Object.keys(LINKS), ...names.flatMap((n) => st[n].known ?? [])])]
      .filter((k) => k !== "gemini");
    const box = (on) => div().size(12).rounded(3).border(1).border_color(on ? t.accent : t.input).bg(on ? t.accent : t.surface);
    const row = (key, enabled, name, detail, right) =>
      h_flex().id(`row-${key}`).gap(8).py(3).px(6).rounded(5).items_center()
        .when(enabled, (el) => el.hover((s) => s.bg(t.hover)).on_click(() => this.toggle(key)))
        .child(enabled ? box(!this.skip.has(key)) : div().size(12))
        .child(div().w(90).flex_none().text_color(enabled ? t.foreground : t.dim).child(name))
        .child(div().flex_1().truncate().text_color(t.dim).child(detail))
        .child(div().text_color(t.muted).child(right));
    const pathRow = (p) => h_flex().id(`path-${p.to}`).gap(8).py(3).px(6).rounded(5).items_center()
      .when(Boolean(this.skip), (el) => el.hover((s) => s.bg(t.hover)).on_click(() => this.toggle(p.to)))
      .child(box(Boolean(this.skip) && !this.skip.has(p.to)))
      .child(div().flex_1().truncate().child(p.from === p.to ? `~/${p.to}` : `~/${p.from} → ~/${p.to}`));
    const agentRow = (key) => {
      const path = LINKS[key];
      const where = names.filter((n) => st[n].installed?.includes(key)).join(", ") || "not installed";
      return row(key, Boolean(path && this.skip), key, path ? `~/${path}` : "no global file", where);
    };
    const machineRow = (n) => h_flex().gap(8).px(6).items_center()
      .child(div().size(6).rounded(3).bg(st[n].ok ? t.done : t.blocked))
      .child(div().w(130).child(n))
      .child(div().flex_1().truncate().text_color(st[n].ok ? t.dim : t.blocked)
        .child(st[n].ok ? `synced ${hhmm(st[n].at)}` : st[n].error));
    const heading = (text) => div().px(6).font_semibold().text_color(t.muted).child(text);
    return v_flex().p(12).gap(10).text_size(12.5).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().font_semibold().child("Remote sync · this computer → remotes"))
        .child(h_flex().id("sync-now").h(28).px(12).items_center().rounded(7)
          .border_1().border_color(t.solid).bg(t.solid).text_color(t.solid_foreground)
          .font_medium().cursor_pointer()
          .hover((s) => s.bg(t.accent).border_color(t.accent).text_color(t.accent_foreground))
          .on_click(() => {
            setShared(REQUEST, (shared(REQUEST) ?? 0) + 1);
            closeOverlay(props().overlay);
          })
          .child("Sync now")))
      .when(Boolean(this.configError), (el) => el.child(div().text_color(t.blocked).child(this.configError)))
      .child(heading("Paths · add more in mods/remote-sync/config.json"))
      .child(v_flex().gap(1).children((this.paths ?? []).map(pathRow)))
      .child(div().h(1).bg(t.border))
      .child(heading("Link ~/.agents/AGENTS.md for"))
      .child(v_flex().gap(1).children(known.map(agentRow)))
      .child(div().h(1).bg(t.border))
      .child(v_flex().gap(4).children(names.map(machineRow)));
  }
}
