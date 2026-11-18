import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, checking, theme, layout, run, window, settings, props as blockProps } from "herdr";

// Work items assigned to the signed-in az user, most recently changed first.
// Types ADO files under Microsoft.HiddenCategory (test plans/suites/cases, shared
// steps, code review and feedback requests) are left out.
const SELECT =
  "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.ChangedDate], [System.Parent] " +
  "FROM WorkItems WHERE [System.AssignedTo] = @Me " +
  "AND [System.WorkItemType] NOT IN GROUP 'Microsoft.HiddenCategory' ";
const ORDER = "ORDER BY [System.ChangedDate] DESC";
// Every ADO state belongs to one of Proposed, InProgress, Resolved, Completed, Removed,
// whatever the process calls it. These two count as finished.
const FINISHED = new Set(["Completed", "Removed"]);
// Used only when the type lookup fails: the usual finished names.
const FALLBACK_DONE = ["Closed", "Removed", "Done"];
const POLL_MS = 120000;
const TYPES_MS = 30 * 60000;
const ROW_H = 28;
const ICON = (name) => `mods/ado-work-items/${name}.svg`;

// `az devops configure --list` prints an ini: "[defaults]\norganization = …\nproject = …".
function parseDefaults(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(organization|project)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]] = m[2];
  }
  return out;
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The WIQL for the open items: for each enabled type, its states that aren't finished.
// Precise per type, so a state name that is finished in one type and open in another
// still works. Without type info, falls back to the fixed list of finished names.
function buildWiql(types) {
  const clauses = [];
  for (const t of types ?? []) {
    if (t.isDisabled) continue;
    const open = (t.states ?? []).filter((s) => !FINISHED.has(s.category)).map((s) => quote(s.name));
    if (open.length) clauses.push(`([System.WorkItemType] = ${quote(t.name)} AND [System.State] IN (${open.join(", ")}))`);
  }
  if (!clauses.length) return `${SELECT}AND [System.State] NOT IN (${FALLBACK_DONE.map(quote).join(", ")}) ${ORDER}`;
  return `${SELECT}AND (${clauses.join(" OR ")}) ${ORDER}`;
}

// ADO's own color per type ("E06C00" → "#E06C00").
function typeColors(types) {
  const out = {};
  for (const t of types ?? []) if (/^[0-9a-f]{6}$/i.test(t.color ?? "")) out[t.name] = `#${t.color}`;
  return out;
}

// Orders the items as a tree. An item whose parent is also in the list goes under it,
// 16px further in per level. An item whose parent isn't in the list sits at the top,
// under a dim line for that parent when `context` knows it; items sharing such a
// parent share the line. Siblings and top-level groups go newest activity first,
// where a group's activity is the latest change anywhere in it. Returns the rows to
// draw: { kind: "item" | "context", w, depth, rails, last, stem }, where `rails[i]` says
// whether the guide line of level i+1 continues past this row (an ancestor there has
// siblings still to come), `last` whether this row is its parent's last child, and
// `stem` whether rows nest under this one (a line runs down from its dot).
export function arrange(items, context = {}) {
  const byId = new Map(items.map((w) => [w.id, w]));
  const kids = new Map();
  for (const w of items) {
    if (w.parent != null && byId.has(w.parent) && w.parent !== w.id) {
      if (!kids.has(w.parent)) kids.set(w.parent, []);
      kids.get(w.parent).push(w);
    }
  }
  const memo = new Map();
  const latest = (w, seen = new Set()) => {
    if (memo.has(w.id)) return memo.get(w.id);
    if (seen.has(w.id)) return 0;
    seen.add(w.id);
    let t = Date.parse(w.changed) || 0;
    for (const k of kids.get(w.id) ?? []) t = Math.max(t, latest(k, seen));
    memo.set(w.id, t);
    return t;
  };
  const newest = (a, b) => b.at - a.at;

  const entries = [];
  const groups = new Map();
  for (const w of items) {
    if (w.parent != null && byId.has(w.parent) && w.parent !== w.id) continue;
    const ctx = w.parent != null ? context[w.parent] : null;
    if (!ctx) { entries.push({ w, at: latest(w) }); continue; }
    if (!groups.has(w.parent)) {
      const g = { ctx, children: [], at: 0 };
      groups.set(w.parent, g);
      entries.push(g);
    }
    const g = groups.get(w.parent);
    g.children.push(w);
    g.at = Math.max(g.at, latest(w));
  }
  entries.sort(newest);

  const rows = [];
  const placed = new Set();
  const walkChildren = (list, depth, rails) => {
    const sorted = list.filter((k) => !placed.has(k.id)).map((k) => ({ w: k, at: latest(k) })).sort(newest);
    sorted.forEach((c, i) => walk(c.w, depth, rails, i === sorted.length - 1));
  };
  const walk = (w, depth, rails, last) => {
    if (placed.has(w.id)) return;
    placed.add(w.id);
    const children = (kids.get(w.id) ?? []).filter((k) => !placed.has(k.id));
    rows.push({ kind: "item", w, depth, rails, last, stem: children.length > 0 });
    walkChildren(children, depth + 1, depth > 0 ? [...rails, !last] : []);
  };
  for (const e of entries) {
    if (e.ctx) {
      rows.push({ kind: "context", w: e.ctx, depth: 0, rails: [], last: true, stem: true });
      walkChildren(e.children, 1, []);
    } else walk(e.w, 0, [], true);
  }
  // A parent loop (shouldn't happen in ADO) leaves items unplaced: add them flat.
  for (const w of items) if (!placed.has(w.id)) walk(w, 0, [], true);
  return rows;
}

function explain(stderr) {
  const s = stderr || "";
  if (/az login|not logged in|Please run 'az login'|authenticat/i.test(s)) return "Not signed in. Run `az login`.";
  if (/extension|'boards' is misspelled|not in the 'az' command group/i.test(s)) return "Missing the azure-devops extension. Run `az extension add --name azure-devops`.";
  if (/organization|--org/i.test(s)) return "No organization. Run `az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>`.";
  return s.trim().split("\n").filter(Boolean).pop() || "az failed";
}

// The panel's block in the shown layout: the copy of this mod without a `part`. Its id
// is generated when Herdr first docks it, so it is found by its mod.
function panelBlock(node) {
  if (node?.content?.mod === "ado-work-items" && !node.content.props?.part) return node;
  for (const child of node?.children ?? []) {
    const found = panelBlock(child);
    if (found) return found;
  }
  return null;
}

// The show/hide button: a copy with props { part: "toggle" }, placed as its own small
// block wherever a layout wants it (a tab bar, a title bar). A hidden panel gets no
// key commands, so the button, which stays shown, does the toggling.
// With { border: true } it draws a 1px `border` line along its bottom, to continue a bar
// that has one (Herdr's own tab bar).
function toggleButton(border) {
  const t = theme();
  const panel = panelBlock(layout());
  const shown = Boolean(panel) && !panel.hidden;
  const label = !panel ? "No work items panel in this layout" : shown ? "Hide work items" : "Show work items";
  return h_flex().id("ado-toggle-bar").size_full().items_center().justify_center()
    .when(border, (el) => el.bg(t.chrome).border_b(1).border_color(t.border))
    .child(h_flex().id("ado-toggle").size(28).flex_none().items_center().justify_center().rounded(8)
      .text_color(shown ? t.foreground : t.dim)
      .when(shown, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { if (panel?.id) run("layout.toggle", { id: panel.id }); })
      .child(svg(ICON("ado")).size(16).flex_none()));
}

// On macOS with Herdr's title bar off, the traffic lights sit over the window's top-left
// corner. When the panel is the root row's first shown block, it is in that corner, so
// the header starts past the lights (as Herdr's tabs mod does: their x plus 64, in
// unzoomed px). Elsewhere, and in full screen (no lights), it keeps its 12px.
function lightsInset() {
  const w = window(), root = layout();
  if (w?.platform !== "macos" || w.titlebar !== "none" || w.fullscreen || !root?.traffic_lights) return 12;
  const first = root.type === "row" ? (root.children ?? []).find((c) => !c.hidden) : null;
  if (!first || first !== panelBlock(root)) return 12;
  return Math.max(12, (root.traffic_lights[0] + 64) / (Number(settings()?.zoom) || 1));
}

export default class AdoWorkItems extends View {
  init(props, cx) {
    this.part = blockProps()?.part ?? props?.part ?? null;
    if (this.part === "toggle") return;
    this.items = [];
    this.org = props?.org ?? null;
    this.project = props?.project ?? null;
    this.loading = false;
    this.error = null;
    this.loaded = false;
    this.types = null;        // ADO's work item types, with states and colors
    this.typesAt = 0;         // when they were loaded
    this.colors = {};
    this.context = {};        // parents not in the list: id → { id, title, type, state }
    this.titleWidths = new Map(); // "<kind>-<id>" → { shown, full }, title widths in px
    this.clamped = new Set();     // "<kind>-<id>" of titles cut off with "…"
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
  }

  // ADO's types for this project: names, colors, and each state's category.
  // Loaded once, then again after 30 minutes or on a manual refresh. A failure keeps
  // the previous ones (or none, which falls back to the fixed WIQL).
  async loadTypes(force) {
    if (!force && this.types && Date.now() - this.typesAt < TYPES_MS) return;
    try {
      const r = await exec("az", ["devops", "invoke", "--area", "wit", "--resource", "workitemtypes",
        "--route-parameters", `project=${this.project}`, "--org", this.org, "--api-version", "7.1",
        "--detect", "false", "-o", "json"], { timeout: 60000 });
      if (r.code !== 0) return;
      const types = JSON.parse(r.stdout || "{}").value;
      if (!Array.isArray(types) || !types.length) return;
      this.types = types;
      this.typesAt = Date.now();
      this.colors = typeColors(types);
    } catch { /* keep what we had */ }
  }

  refresh(cx, force = false) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.org || !this.project) {
          const conf = await exec("az", ["devops", "configure", "--list"]);
          if (conf.code !== 0) throw new Error(explain(conf.stderr));
          const d = parseDefaults(conf.stdout);
          this.org = this.org ?? d.organization ?? null;
          this.project = this.project ?? d.project ?? null;
        }
        if (!this.org || !this.project) throw new Error("No default organization/project. Run `az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>`.");
        await this.loadTypes(force);
        const r = await exec("az", ["boards", "query", "--org", this.org, "--project", this.project, "--wiql", buildWiql(this.types), "--detect", "false", "-o", "json"], { timeout: 60000 });
        if (r.code !== 0) throw new Error(explain(r.stderr));
        const rows = JSON.parse(r.stdout || "[]");
        this.items = rows.map((w) => ({
          id: w.id ?? w.fields?.["System.Id"],
          title: w.fields?.["System.Title"] ?? "",
          state: w.fields?.["System.State"] ?? "",
          type: w.fields?.["System.WorkItemType"] ?? "",
          changed: w.fields?.["System.ChangedDate"] ?? "",
          parent: w.fields?.["System.Parent"] ?? null,
        }));
        await this.loadContext(force);
        this.error = null;
        this.loaded = true;
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.error = /ENOENT|not found|No such file|can't start|cannot start/i.test(msg) && !/az login/.test(msg)
          ? "The az CLI isn't installed. Install it (`sudo dnf install azure-cli`) and run `az login`."
          : msg;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Titles of parents that aren't in the list, for the dim parent lines. One query for
  // the ones not known yet; ↻ forgets them all. A failure leaves those items without
  // a parent line.
  async loadContext(force) {
    if (force) this.context = {};
    const ids = new Set(this.items.map((w) => w.id));
    const missing = [...new Set(this.items.map((w) => w.parent))]
      .filter((p) => p != null && !ids.has(p) && !this.context[p]);
    if (!missing.length) return;
    try {
      const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE [System.Id] IN (${missing.map(Number).join(", ")})`;
      const r = await exec("az", ["boards", "query", "--org", this.org, "--project", this.project, "--wiql", wiql, "--detect", "false", "-o", "json"], { timeout: 60000 });
      if (r.code !== 0) return;
      for (const w of JSON.parse(r.stdout || "[]")) {
        const id = w.id ?? w.fields?.["System.Id"];
        this.context[id] = {
          id,
          title: w.fields?.["System.Title"] ?? "",
          state: w.fields?.["System.State"] ?? "",
          type: w.fields?.["System.WorkItemType"] ?? "",
        };
      }
    } catch { /* no parent lines this time */ }
  }

  base() {
    return `${this.org.replace(/\/+$/, "")}/${encodeURIComponent(this.project)}/_workitems`;
  }

  url(id) {
    return `${this.base()}/edit/${id}`;
  }

  // +: ADO's Work Items page. The type is picked there, with ADO's "New Work Item"
  // button, so the org's own rules and permissions decide what can be created.
  plus(cx) {
    if (!this.org || !this.project) return;
    cx.open_url(this.base());
  }

  header(t) {
    const button = this.loading
      ? svg(ICON("spinner")).size(14).flex_none().text_color(t.muted).spin(900)
      : svg(ICON("refresh")).size(14).flex_none().text_color(t.muted);
    const refresh = div().id("ado-refresh").p(4).rounded(4).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx, true); })
      .child(button);
    const plus = div().id("ado-plus").p(4).rounded(4)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.plus(cx); })
      .child(svg(ICON("plus")).size(14).flex_none().text_color(t.muted));
    return h_flex().h(36).flex_none().px(12).pl(lightsInset()).gap(8).items_center().justify_between()
      .border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Work items"))
        .when(this.loaded, (el) => el.child(
          div().px(6).rounded(8).bg(t.raised).text_size(11).text_color(t.muted).child(String(this.items.length)))))
      .child(h_flex().flex_none().gap(2).items_center().child(plus).child(refresh));
  }

  // Records a title's shown or full width; redraws only when whether it is cut off changes.
  measure(key, which, width, cx) {
    const m = this.titleWidths.get(key) ?? {};
    m[which] = width;
    this.titleWidths.set(key, m);
    if (m.shown == null || m.full == null) return;
    const cut = m.shown + 0.5 < m.full;
    if (cut === this.clamped.has(key)) return;
    if (cut) this.clamped.add(key); else this.clamped.delete(key);
    cx.notify();
  }

  // Tree guides left of a nested row's dot, one 16px column per level. Each line sits
  // 4px into its column: under the dot of the row one level up. Ancestor columns
  // carry a straight line when that ancestor has siblings still to come; the last
  // column turns into this row's dot (├ mid-list, └ for the last child).
  guides(depth, rails, last, t) {
    const line = (h) => div().ml(4).w(1).h(h).flex_none().bg(t.border);
    const cols = [];
    for (let i = 0; i < depth - 1; i++) {
      cols.push(div().w(16).h(ROW_H).flex_none().when(rails[i], (el) => el.child(line(ROW_H))));
    }
    cols.push(v_flex().w(16).h(ROW_H).flex_none()
      .child(h_flex().h(ROW_H / 2).items_end()
        .child(line(ROW_H / 2))
        .child(div().w(9).h(1).flex_none().bg(t.border)))
      .when(!last, (el) => el.child(line(ROW_H / 2))));
    return cols;
  }

  // One row. `context` rows are parents that aren't in the list: title in `dim`.
  row({ kind, w, depth, rails, last, stem }, t) {
    const context = kind === "context";
    const dot = div().size(8).rounded(4).flex_none().bg(this.colors[w.type] ?? t.muted);
    const el = h_flex().id(`ado-${kind}-${w.id}`).gap(8).items_center().rounded(6)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => cx.open_url(this.url(w.id)));
    // The dot, centered in the row; with children, a stem from it to the row's bottom,
    // 4px in, so it meets the guide of the first child.
    const node = v_flex().w(8).h(ROW_H).flex_none().justify_center()
      .child(div().h((ROW_H - 8) / 2).flex_none())
      .child(dot)
      .child(div().h((ROW_H - 8) / 2).flex_none()
        .when(stem, (el) => el.child(div().ml(4).w(1).h((ROW_H - 8) / 2).bg(t.border))));
    return el.h(ROW_H).px(8)
      .child(h_flex().flex_none().items_center()
        .children(depth > 0 ? this.guides(depth, rails ?? [], last, t) : [])
        .child(node))
      // Title, then its #id right after the text. A long title truncates; the id never
      // does (a cut-off id is useless), so it stays visible right after the "…".
      // The full title shows as a tooltip only while it is cut off. Nothing reports
      // truncation, so the shown title's width is compared with an invisible,
      // unclipped copy's (absolute, so it takes no room in the row).
      .child(h_flex().relative().overflow_hidden().flex_1().min_w(0).gap(6).items_center()
        .child(div().id(`ado-title-${kind}-${w.id}`).min_w(0).truncate().text_size(13)
          .text_color(context ? t.dim : t.foreground)
          .on_size_change((size, cx) => this.measure(`${kind}-${w.id}`, "shown", size.width, cx))
          .when(this.clamped.has(`${kind}-${w.id}`), (el) => el.tooltip(w.title))
          .child(w.title))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(`#${w.id}`))
        .child(div().id(`ado-measure-${kind}-${w.id}`).absolute().top(0).left(0).invisible()
          .whitespace_nowrap().text_size(13)
          .on_size_change((size, cx) => this.measure(`${kind}-${w.id}`, "full", size.width, cx))
          .child(w.title)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(w.state));
  }

  render(_cx) {
    if (this.part === "toggle") return toggleButton(Boolean(blockProps()?.border));
    const t = theme();
    let body;
    if (this.error) {
      body = div().p(12).text_size(12).text_color(t.blocked).child(this.error);
    } else if (!this.loaded) {
      body = div().p(12).text_size(12).text_color(t.muted).child("Loading work items…");
    } else if (this.items.length === 0) {
      body = div().p(12).text_size(12).text_color(t.muted).child("Nothing assigned to you.");
    } else {
      // No gap between rows, so the tree guides join up.
      body = v_flex().p(4).children(arrange(this.items, this.context).map((r) => this.row(r, t)));
    }
    return v_flex().id("root").size_full().bg(t.chrome)
      .child(this.header(t))
      .child(div().id("ado-list").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }
}
