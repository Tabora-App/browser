/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Пароли сайтов: те же записи, что хранит браузер Tabora, приходят сюда синхронизацией. */

import { editLogin, generatePassword, hostOf, newLogin } from "../core/records.js";
import { clear, h, icon } from "../lib/dom.js";
import { avatar, busy, confirmDialog, copyText, emptyState, errorText, field, formError, longDate, menu, modal, toast } from "../lib/ui.js";
import { backButton, save, split, syncGate, watch } from "./common.js";

const REVEAL_MS = 30000;

export function mountPasswords(el, ctx, rest) {
  const { sync } = ctx;
  const s = split();
  let query = "";
  let selected = rest[0] || "";
  let revealed = false;
  let hideTimer = null;

  const search = h("input", { type: "search", placeholder: "Поиск по сайту или имени", "aria-label": "Поиск", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    drawList();
  });
  const count = h("small", {});
  const listBody = h("div", { class: "list" });
  const addButton = h("button", { class: "btn primary small hide-phone", onclick: () => edit(null) }, icon("plus", 16), "Добавить");
  clear(s.list,
    h("header", { class: "pane-head" }, h("h1", {}, "Пароли", count), addButton),
    h("div", { class: "pane-tools" }, h("label", { class: "search" }, icon("search", 17), search)),
    listBody,
    h("button", { class: "fab", onclick: () => edit(null) }, icon("plus", 20), "Добавить"));
  clear(el, s.el);

  const items = () => sync.list("logins").filter(l => l.data && typeof l.data.o === "string").sort((a, b) => hostOf(a.data.o).localeCompare(hostOf(b.data.o)) || (a.data.u || "").localeCompare(b.data.u || ""));

  function drawList() {
    const gate = syncGate(ctx, "пароли");
    addButton.disabled = !!gate;
    if (gate) {
      count.textContent = "";
      clear(listBody, gate);
      return;
    }
    const all = items();
    count.textContent = all.length ? String(all.length) : "";
    const shown = query ? all.filter(l => hostOf(l.data.o).toLowerCase().includes(query) || (l.data.u || "").toLowerCase().includes(query) || l.data.o.toLowerCase().includes(query)) : all;
    if (!all.length) {
      clear(listBody, emptyState({ iconName: "key", title: "Паролей пока нет", text: "Пароли, сохранённые в Tabora на компьютере, появятся здесь, когда вы включите там синхронизацию: «Настройки» → «Синхронизация». Можно и добавить пароль прямо тут.", action: h("button", { class: "btn primary", onclick: () => edit(null) }, "Добавить пароль") }));
      return;
    }
    if (!shown.length) {
      clear(listBody, emptyState({ iconName: "search", title: "Ничего не найдено", text: "Попробуйте другое слово: часть адреса сайта или имени." }));
      return;
    }
    clear(listBody, shown.map(l => h("a", { class: "row", href: `#/passwords/${encodeURIComponent(l.id)}`, "aria-selected": String(l.id === selected) },
      avatar(hostOf(l.data.o)),
      h("span", { class: "row-text" }, h("b", {}, hostOf(l.data.o)), h("span", {}, l.data.u || (l.data.r !== null ? "вход по окну браузера" : "без имени"))),
      icon("forwardChevron", 16))));
  }

  function drawDetail() {
    clearTimeout(hideTimer);
    const item = selected && sync.loaded ? sync.list("logins").find(l => l.id === selected) : null;
    if (!item) {
      s.close();
      clear(s.detail, selected && sync.loaded
        ? emptyState({ iconName: "key", title: "Запись не найдена", text: "Возможно, её удалили на другом устройстве." })
        : emptyState({ iconName: "key", title: "Выберите запись", text: "Здесь появятся имя и пароль — их можно скопировать одним нажатием." }));
      if (selected && sync.loaded) {
        selected = "";
      }
      return;
    }
    s.open();
    const d = item.data;
    const host = hostOf(d.o);
    const secret = h("span", { class: "mono secret" }, revealed ? d.p : "•".repeat(Math.min(14, Math.max(8, d.p.length))));
    const eye = h("button", { class: "icon-btn", "aria-label": revealed ? "Скрыть пароль" : "Показать пароль", "aria-pressed": String(revealed) }, icon(revealed ? "eyeOff" : "eye", 18));
    eye.addEventListener("click", () => {
      revealed = !revealed;
      drawDetail();
    });
    if (revealed) {
      hideTimer = setTimeout(() => {
        revealed = false;
        drawDetail();
      }, REVEAL_MS);
    }
    const more = h("button", { class: "icon-btn", "aria-label": "Действия" }, icon("more", 20, 2.4));
    more.addEventListener("click", () => menu(more, [
      { label: "Изменить", icon: "edit", run: () => edit(item) },
      { label: "Удалить", icon: "trash", danger: true, run: () => remove(item) },
    ]));
    clear(s.detail,
      h("header", { class: "detail-head" }, backButton(() => ctx.navigate("passwords")), h("div", { class: "detail-title" }, avatar(host), h("h2", {}, host)), more),
      h("div", { class: "detail-body" },
        h("div", { class: "card" },
          h("div", { class: "kv" }, h("div", { class: "kv-text" }, h("small", {}, "Сайт"), h("a", { href: d.o, target: "_blank", rel: "noopener noreferrer" }, d.o)), h("div", { class: "kv-actions" }, h("a", { class: "icon-btn", href: d.o, target: "_blank", rel: "noopener noreferrer", "aria-label": "Открыть сайт" }, icon("open", 18)))),
          h("div", { class: "kv" }, h("div", { class: "kv-text" }, h("small", {}, "Имя"), h("span", {}, d.u || "—")), d.u && h("div", { class: "kv-actions" }, h("button", { class: "icon-btn", "aria-label": "Скопировать имя", onclick: () => copyText(d.u, "Имя скопировано") }, icon("copy", 18)))),
          h("div", { class: "kv" }, h("div", { class: "kv-text" }, h("small", {}, "Пароль"), secret), h("div", { class: "kv-actions" }, eye, h("button", { class: "icon-btn", "aria-label": "Скопировать пароль", onclick: () => copyText(d.p, "Пароль скопирован") }, icon("copy", 18))))),
        h("p", { class: "detail-meta" }, d.t ? `Пароль изменён ${longDate(d.t)}` : "", d.r !== null ? " · вход через окно браузера (HTTP)" : ""),
        h("div", { class: "section-actions" },
          h("button", { class: "btn", onclick: () => edit(item) }, icon("edit", 16), "Изменить"),
          h("button", { class: "btn danger", onclick: () => remove(item) }, icon("trash", 16), "Удалить"))));
  }

  function edit(item) {
    const d = item?.data;
    const site = field("Сайт", { value: d ? d.o : "", placeholder: "example.com", inputmode: "url", autofocus: !d });
    const user = field("Имя или почта", { value: d ? d.u : "", autocomplete: "off" });
    const pass = field("Пароль", { type: "password", value: d ? d.p : "", autocomplete: "new-password" });
    const gen = h("button", { class: "link-btn", type: "button" }, "Придумать надёжный пароль");
    gen.addEventListener("click", () => {
      pass.value = generatePassword(20);
      pass.input.type = "text";
      pass.el.querySelector(".input-eye")?.setAttribute("aria-pressed", "true");
    });
    const error = formError();
    const submit = h("button", { class: "btn primary", type: "submit" }, d ? "Сохранить" : "Добавить");
    const form = h("form", { class: "modal-form", novalidate: true }, site.el, user.el, pass.el, gen, error.el);
    const m = modal({ title: d ? "Изменить запись" : "Новый пароль", content: [form], actions: [h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Отмена"), submit] });
    const run = async e => {
      e?.preventDefault();
      error.set("");
      try {
        const values = { site: site.value, username: user.value, password: pass.value };
        let id = item?.id;
        await busy(submit, async () => {
          if (item) {
            await sync.put("logins", item.id, editLogin(item.id, d, values));
          } else {
            const made = newLogin(values);
            id = made.id;
            await sync.put("logins", made.id, made.data);
          }
        }, "Сохраняем");
        m.close();
        toast(item ? "Запись сохранена" : "Пароль добавлен");
        ctx.navigate(`passwords/${encodeURIComponent(id)}`);
      } catch (err) {
        error.set(errorText(err));
      }
    };
    form.addEventListener("submit", run);
    submit.addEventListener("click", run);
  }

  async function remove(item) {
    const host = hostOf(item.data.o);
    if (!(await confirmDialog({ title: "Удалить пароль?", text: `Запись для ${host}${item.data.u ? ` (${item.data.u})` : ""} будет удалена на всех ваших устройствах. Вернуть её нельзя.`, confirm: "Удалить", danger: true }))) {
      return;
    }
    if (await save(ctx, () => sync.remove("logins", item.id), "Запись удалена")) {
      ctx.navigate("passwords");
    }
  }

  const redraw = () => {
    drawList();
    drawDetail();
  };
  const off = watch(ctx, redraw);
  redraw();
  if (!sync.loaded && ctx.account.keys.state === "ok") {
    sync.refresh().catch(() => redraw());
  }

  return {
    route(next) {
      const id = next[0] || "";
      if (id !== selected) {
        selected = id;
        revealed = false;
      }
      redraw();
    },
    destroy() {
      off();
      clearTimeout(hideTimer);
    },
  };
}
