/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Алиасы: отдельный адрес для каждого сайта. Письма на алиас приходят в общий ящик; если сайт
 * начал слать рекламу или адрес утёк, алиас выключается — и письма на него перестают приходить. */

import { clear, h, icon } from "../lib/dom.js";
import { busy, confirmDialog, copyText, errorText, field, formError, modal, shortDate, toast, toggle } from "../lib/ui.js";
import { t } from "../core/i18n.js";

export function openAliases(ctx) {
  const { api, account } = ctx;
  const body = h("div", { class: "aliases" });
  const site = field("", { placeholder: t`Для какого сайта (необязательно)`, maxlength: 80 });
  const create = h("button", { class: "btn primary" }, icon("plus", 16), t`Создать алиас`);
  const error = formError();
  let list = null;

  const m = modal({ title: t`Алиасы`, wide: true, content: [
    h("p", { class: "modal-text" }, t`Алиас — отдельный адрес для одного сайта. Письма на него приходят в ваш ящик, а настоящий адрес сайт не узнаёт.`),
    h("div", { class: "alias-new" }, site.el, create),
    error.el, body,
  ], actions: [h("button", { class: "btn primary", onclick: () => m.close() }, t`Готово`)] });

  function draw() {
    if (list === null) {
      clear(body, h("div", { class: "skeleton" }, h("i"), h("i")));
      return;
    }
    if (!list.length) {
      clear(body, h("p", { class: "detail-meta" }, t`Алиасов пока нет.`));
      return;
    }
    clear(body, h("div", { class: "card" }, list.map(a => {
      const on = a.on !== false;
      const del = h("button", { class: "icon-btn", "aria-label": t`Удалить ${a.address}` }, icon("trash", 17));
      del.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: t`Удалить алиас?`, text: t`Письма на ${a.address} перестанут приходить навсегда, и этот адрес больше никому не достанется. Если хотите только приостановить его — выключите.`, confirm: t`Удалить`, danger: true }))) {
          return;
        }
        try {
          await api.aliasDelete(account.token, a.id);
          list = list.filter(x => x.id !== a.id);
          draw();
          toast(t`Алиас удалён`);
        } catch (e) {
          toast(errorText(e), { tone: "bad" });
        }
      });
      return h("div", { class: `kv${on ? "" : " off"}` },
        h("div", { class: "kv-text" }, h("small", {}, [a.site || t`без сайта`, a.created ? t`создан ${shortDate(a.created)}` : "", on ? "" : t`выключен: письма не принимаются`].filter(Boolean).join(" · ")), h("span", { class: "mono" }, a.address)),
        h("div", { class: "kv-actions" },
          h("button", { class: "icon-btn", "aria-label": t`Скопировать ${a.address}`, onclick: () => copyText(a.address, t`Адрес скопирован`) }, icon("copy", 17)),
          toggle(on, async next => {
            await api.aliasUpdate(account.token, a.id, { on: next });
            a.on = next;
            draw();
          }, t`Принимать письма на ${a.address}`),
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
      const a = await busy(create, () => api.aliasCreate(account.token, { site: site.value.trim() }), t`Создаём`);
      site.value = "";
      list = [a, ...(list || [])];
      draw();
      copyText(a.address, t`Алиас ${a.address} создан и скопирован`);
    } catch (e) {
      error.set(e.code === "alias-limit" ? t`Достигнут предел числа алиасов. Удалите ненужные` : errorText(e));
    }
  });

  draw();
  load();
}
