# ADO Work Items

A [Herdr](https://herdr.dev) panel listing your open Azure DevOps work items as a tree. Click a row to open it; **+** opens ADO to create one.

![ADO Work Items](preview.png)

## Setup

```sh
az extension add --name azure-devops
az login
az devops configure --defaults organization=https://dev.azure.com/<org> project="<Project Name>"
cp -r mods/ado-work-items ~/.config/herdr-app/mods/
```

Herdr docks the panel on the left the first time it sees the mod.

## Show/hide button

The mod also draws a small Azure DevOps button that shows and hides the panel. Add it to
your layout as its own block, with `"props": { "part": "toggle" }`:

```json
{ "id": "ado-toggle", "type": "block", "size": { "px": 32 },
  "content": { "mod": "ado-work-items", "props": { "part": "toggle" } } }
```

Herdr's own layouts can't be changed, so put it in a copy of one:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

Then, in `~/.config/herdr-app/layouts/my-layout.json`, replace the `tabs` block (in
`work`) with a row holding the button, then it:

```json
{ "id": "tabs-row", "type": "row", "size": { "px": 42 }, "background": "chrome", "children": [
  { "id": "ado-toggle", "type": "block", "size": { "px": 40 }, "window_drag": true,
    "content": { "mod": "ado-work-items", "props": { "part": "toggle", "border": true } } },
  { "id": "tabs", "type": "block", "content": { "mod": "tabs" }, "size": { "weight": 1 }, "window_drag": true } ] }
```

`"border": true` draws the tab bar's bottom line under the button too. `main` has no
panel either, so also add it as the first child of the root row:

```json
{ "id": "ado-work-items", "type": "block", "size": { "px": 300 }, "min": 220,
  "content": { "mod": "ado-work-items" } }
```

### Or next to Files and Changes

Herdr's tab bar draws its own buttons, so a button among them needs a copy of the
`tabs` mod. Your layout then uses that copy, which no longer gets Herdr's updates to the
tab bar.

```sh
herdr-app do mod.clone '{"name":"tabs","as":"tabs-ado"}'
```

In `~/.config/herdr-app/mods/tabs-ado/main.js`, add a finder next to `find`:

```js
function adoPanel(node) {
  if (node?.content?.mod === "ado-work-items" && !node.content.props?.part) return node;
  for (const child of node?.children ?? []) {
    const found = adoPanel(child);
    if (found) return found;
  }
  return null;
}
```

After `const panel = find(root, "panel"), …` add
`const ado = adoPanel(root), adoOn = Boolean(ado) && !ado.hidden;`, and after the
Changes button:

```js
.when(Boolean(ado), el => el.child(h_flex().id("panel-ado").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
  .text_size(12).bg(adoOn ? t.selected : t.chrome).text_color(adoOn ? t.foreground : t.muted)
  .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
  .on_click(() => run("layout.toggle", { id: ado.id }))
  .child(svg("mods/ado-work-items/ado.svg").size(14)).child("Work items")))
```

Then point your layout's `tabs` block at `"mod": "tabs-ado"`.

In a layout whose tab bar is already a row of blocks (such as Herdr T3's `tabs-row`),
add the button block to that row, e.g. right after the details block.

The button finds the panel by its mod, so it works whatever id the panel has. It looks
pressed while the panel shows.

Needs the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli). The mod runs `az` and nothing else.

See [RECIPE.md](RECIPE.md) to build it from scratch.
