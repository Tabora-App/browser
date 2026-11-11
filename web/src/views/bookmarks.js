/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Закладки: то же дерево, что в браузере Tabora. Папки открываются по одной, как в проводнике. */

import { hostOf, MARK_ROOTS, marksAdd, marksEdit, marksRemove, marksTree } from "../core/records.js";
import { clear, h, icon } from "../lib/dom.js";
import { avatar, busy, confirmDialog, emptyState, errorText, field, formError, menu, modal, plural, toast } from "../lib/ui.js";
import { save, split, syncGate, watch } from "./common.js";

export function mountBookmarks(el, ctx, rest) {
  const { sync } = ctx;
  const s = split({ single: true });
  let folderId = rest[0] || "";
  let query = "";
  const title = h("h1", {}, "Закладки");
  const crumbs = h("nav", { class: "crumbs", "aria-label": "Путь" });
  const listBody = h("div", { class: "list" });
  const search = h("input", { type: "search", placeholder: "Поиск по закладкам", "aria-label": "Поиск", autocomplete: "off", spellcheck: "false" });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  const addButton = h("button", { class: "btn primary small hide-phone" }, icon("plus", 16), "Добавить");
  const addMenu = anchor => menu(anchor, [
    { label: "Закладка", icon: "bookmark", run: () => edit(null, false) },
    { label: "Папка", icon: "folder", run: () => edit(null, true) },
  ]);
  addButton.addEventListener("click", () => addMenu(addButton));
  const fab = h("button", { class: "fab" }, icon("plus", 20), "Добавить");
  fab.addEventListener("click", () => addMenu(fab));
  clear(s.list,
    h("header", { class: "pane-head" }, title, addButton),
    h("div", { class: "pane-tools" }, h("label", { class: "search" }, icon("search", 17), search), crumbs),
    listBody, fab);
  s.list.classList.add("narrow-pane");
  clear(el, s.el);

  function index(tree) {
    const byId = new Map();
    const walk = (node, parent) => {
      byId.set(node.id, { node, parent });
      (node.children || []).forEach(c => walk(c, node));
    };
    tree.forEach(r => walk(r, null));
    return byId;
  }

  function row(node) {
    const more = h("button", { class: "icon-btn", "aria-label": "Действия" }, icon("more", 20, 2.4));
    more.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      menu(more, [
        { label: "Изменить", icon: "edit", run: () => edit(node, node.k === 2) },
        { label: "Удалить", icon: "trash", danger: true, run: () => remove(node) },
      ]);
    });
    if (node.k === 2) {
      const n = (node.children || []).length;
      return h("a", { class: "row", href: `#/bookmarks/${encodeURIComponent(node.id)}` },
        h("span", { class: "avatar folder" }, icon("folder", 18)),
        h("span", { class: "row-text" }, h("b", {}, node.n || "Без названия"), h("span", {}, n ? plural(n, "запись", "записи", "записей") : "пусто")),
        node.root ? icon("forwardChevron", 16) : more);
    }
    if (node.k === 3) {
      return h("div", { class: "mark-sep", role: "separator" });
    }
    return h("a", { class: "row", href: node.u, target: "_blank", rel: "noopener noreferrer" },
      avatar(hostOf(node.u)),
      h("span", { class: "row-text" }, h("b", {}, node.n || hostOf(node.u)), h("span", {}, hostOf(node.u))),
      more);
  }

  function draw() {
    const gate = syncGate(ctx, "закладки");
    addButton.disabled = !!gate;
    fab.hidden = !!gate;
    if (gate) {
      clear(crumbs);
      clear(listBody, gate);
      return;
    }
    const tree = marksTree(sync.list("marks"));
    const byId = index(tree);
    const total = [...byId.values()].filter(v => v.node.k === 1).length;
    if (folderId && !byId.has(folderId)) {
      folderId = "";
    }
    if (query) {
      clear(crumbs);
      const hits = [...byId.values()].map(v => v.node).filter(n => n.k === 1 && (`${n.n} ${n.u}`).toLowerCase().includes(query));
      clear(listBody, hits.length ? hits.map(row) : emptyState({ iconName: "search", title: "Ничего не найдено", text: "Попробуйте часть названия или адреса." }));
      return;
    }
    if (!total && !folderId) {
      clear(crumbs);
      clear(listBody, emptyState({ iconName: "bookmark", title: "Закладок пока нет", text: "Закладки из Tabora на компьютере появятся здесь, когда вы включите там синхронизацию. Добавить закладку можно и отсюда.", action: h("button", { class: "btn primary", onclick: () => edit(null, false) }, "Добавить закладку") }));
      return;
    }
    // путь к открытой папке
    const path = [];
    for (let cur = folderId ? byId.get(folderId) : null; cur; cur = cur.parent ? byId.get(cur.parent.id) : null) {
      path.unshift(cur.node);
    }
    clear(crumbs, path.length ? [h("a", { href: "#/bookmarks" }, "Все закладки"), path.map((n, i) => [icon("forwardChevron", 13), i === path.length - 1 ? h("span", { "aria-current": "page" }, n.n) : h("a", { href: `#/bookmarks/${encodeURIComponent(n.id)}` }, n.n)])] : []);
    const nodes = folderId ? byId.get(folderId).node.children : tree.filter(r => r.children.length || r.id === MARK_ROOTS.toolbar);
    clear(listBody, nodes.length ? nodes.map(row) : emptyState({ iconName: "folder", title: "Папка пуста", text: "Добавьте сюда закладку или вложенную папку." }));
  }

  function edit(node, isFolder) {
    const name = field("Название", { value: node?.n || "", autofocus: true, placeholder: isFolder ? "Новая папка" : "" });
    const url = isFolder ? null : field("Адрес", { value: node?.u || "", placeholder: "example.com", inputmode: "url" });
    const error = formError();
    const submit = h("button", { class: "btn primary" }, node ? "Сохранить" : "Добавить");
    const where = folderId || MARK_ROOTS.toolbar;
    const m = modal({ title: node ? (isFolder ? "Изменить папку" : "Изменить закладку") : isFolder ? "Новая папка" : "Новая закладка", content: [h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, isFolder ? name.el : [url.el, name.el], error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      try {
        await busy(submit, async () => {
          const list = sync.list("marks");
          if (node) {
            await sync.write(marksEdit(list, node.id, { title: name.value, url: url?.value }));
          } else {
            await sync.write(marksAdd(list, where, { title: name.value, url: isFolder ? "" : url.value }).changes);
          }
        }, "Сохраняем");
        m.close();
        toast(node ? "Сохранено" : isFolder ? "Папка создана" : "Закладка добавлена");
      } catch (e) {
        error.set(errorText(e));
      }
    });
  }

  async function remove(node) {
    const inside = node.k === 2 ? (node.children || []).length : 0;
    if (!(await confirmDialog({ title: node.k === 2 ? "Удалить папку?" : "Удалить закладку?", text: node.k === 2 ? `Папка «${node.n}»${inside ? ` и всё, что в ней (${plural(inside, "запись", "записи", "записей")}),` : ""} будет удалена на всех ваших устройствах.` : `Закладка «${node.n || hostOf(node.u)}» будет удалена на всех ваших устройствах.`, confirm: "Удалить", danger: true }))) {
      return;
    }
    await save(ctx, () => sync.write(marksRemove(sync.list("marks"), node.id)), "Удалено");
  }

  const off = watch(ctx, draw);
  draw();
  if (!sync.loaded && ctx.account.keys.state === "ok") {
    sync.refresh().catch(() => draw());
  }
  return {
    route(next) {
      folderId = next[0] || "";
      listBody.scrollTop = 0;
      draw();
    },
    destroy: off,
  };
}
