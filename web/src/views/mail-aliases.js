/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Алиасы: отдельный адрес для каждого сайта. Письма на алиас приходят в общий ящик; если сайт
 * начал слать рекламу или адрес утёк, алиас выключается — и письма на него перестают приходить. */

import { clear, h, icon } from "../lib/dom.js";
import { busy, confirmDialog, copyText, errorText, field, formError, modal, shortDate, toast, toggle } from "../lib/ui.js";

export function openAliases(ctx) {
  const { api, account } = ctx;
  const body = h("div", { class: "aliases" });
  const site = field("", { placeholder: "Для какого сайта (необязательно)", maxlength: 80 });
  const create = h("button", { class: "btn primary" }, icon("plus", 16), "Создать алиас");
  const error = formError();
  let list = null;

  const m = modal({ title: "Алиасы", wide: true, content: [
    h("p", { class: "modal-text" }, "Алиас — отдельный адрес для одного сайта. Письма на него приходят в ваш ящик, а настоящий адрес сайт не узнаёт."),
    h("div", { class: "alias-new" }, site.el, create),
    error.el, body,
  ], actions: [h("button", { class: "btn primary", onclick: () => m.close() }, "Готово")] });

  function draw() {
    if (list === null) {
      clear(body, h("div", { class: "skeleton" }, h("i"), h("i")));
      return;
    }
    if (!list.length) {
      clear(body, h("p", { class: "detail-meta" }, "Алиасов пока нет."));
      return;
    }
    clear(body, h("div", { class: "card" }, list.map(a => {
      const on = a.on !== false;
      const del = h("button", { class: "icon-btn", "aria-label": `Удалить ${a.address}` }, icon("trash", 17));
      del.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: "Удалить алиас?", text: `Письма на ${a.address} перестанут приходить навсегда, и этот адрес больше никому не достанется. Если хотите только приостановить его — выключите.`, confirm: "Удалить", danger: true }))) {
          return;
        }
        try {
          await api.aliasDelete(account.token, a.id);
          list = list.filter(x => x.id !== a.id);
          draw();
          toast("Алиас удалён");
        } catch (e) {
          toast(errorText(e), { tone: "bad" });
        }
      });
      return h("div", { class: `kv${on ? "" : " off"}` },
        h("div", { class: "kv-text" }, h("small", {}, [a.site || "без сайта", a.created ? `создан ${shortDate(a.created)}` : "", on ? "" : "выключен: письма не принимаются"].filter(Boolean).join(" · ")), h("span", { class: "mono" }, a.address)),
        h("div", { class: "kv-actions" },
          h("button", { class: "icon-btn", "aria-label": `Скопировать ${a.address}`, onclick: () => copyText(a.address, "Адрес скопирован") }, icon("copy", 17)),
          toggle(on, async next => {
            await api.aliasUpdate(account.token, a.id, { on: next });
            a.on = next;
            draw();
          }, `Принимать письма на ${a.address}`),
          del));
    })));
  }

  async function load() {
    try {
      const r = await api.aliases(account.token);
      list = (Array.isArray(r) ? r : []).slice().sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    } catch (e) {
      list = [];
      error.set(errorText(e));
    }
    draw();
  }

  create.addEventListener("click", async () => {
    error.set("");
    try {
      const a = await busy(create, () => api.aliasCreate(account.token, { site: site.value.trim() }), "Создаём");
      site.value = "";
      list = [a, ...(list || [])];
      draw();
      copyText(a.address, `Алиас ${a.address} создан и скопирован`);
    } catch (e) {
      error.set(e.code === "alias-limit" ? "Достигнут предел числа алиасов. Удалите ненужные" : errorText(e));
    }
  });

  draw();
  load();
}
