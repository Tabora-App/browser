/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Вкладки, открытые в Tabora на компьютерах аккаунта: продолжить чтение с телефона. */

import { hostOf } from "../core/records.js";
import { clear, h, icon } from "../lib/dom.js";
import { avatar, emptyState, plural } from "../lib/ui.js";
import { split, syncGate, watch } from "./common.js";

function ago(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 2) {
    return "только что";
  }
  if (min < 60) {
    return `${plural(min, "минуту", "минуты", "минут")} назад`;
  }
  const hours = Math.round(min / 60);
  if (hours < 24) {
    return `${plural(hours, "час", "часа", "часов")} назад`;
  }
  const days = Math.round(hours / 24);
  return `${plural(days, "день", "дня", "дней")} назад`;
}

export function mountDevices(el, ctx) {
  const { sync } = ctx;
  const s = split({ single: true });
  const listBody = h("div", { class: "list" });
  clear(s.list, h("header", { class: "pane-head" }, h("h1", {}, "Вкладки")), h("p", { class: "pane-sub" }, "Страницы, открытые в Tabora на ваших компьютерах."), listBody);
  s.list.classList.add("narrow-pane");
  clear(el, s.el);

  function draw() {
    const gate = syncGate(ctx, "вкладки");
    if (gate) {
      clear(listBody, gate);
      return;
    }
    const devices = sync.list("tabs").map(t => ({ id: t.id, ...t.data })).filter(d => Array.isArray(d.tabs) && d.tabs.length).sort((a, b) => (b.at || 0) - (a.at || 0));
    if (!devices.length) {
      clear(listBody, emptyState({ iconName: "devices", title: "Открытых вкладок нет", text: "Список появится, когда в Tabora на компьютере включена синхронизация вкладок: «Настройки» → «Синхронизация» → «Пространства и вкладки»." }));
      return;
    }
    clear(listBody, devices.map(d => [
      h("div", { class: "list-title device-title" }, icon("laptop", 15), h("span", {}, d.name || "Компьютер"), h("small", {}, d.at ? `обновлено ${ago(d.at)}` : "")),
      d.tabs.filter(t => /^https?:\/\//.test(t.u || "")).map(t => h("a", { class: "row", href: t.u, target: "_blank", rel: "noopener noreferrer" },
        avatar(hostOf(t.u)),
        h("span", { class: "row-text" }, h("b", {}, t.t || hostOf(t.u)), h("span", {}, hostOf(t.u))),
        icon("open", 16))),
    ]));
  }

  const off = watch(ctx, draw);
  const timer = setInterval(draw, 60000);
  draw();
  if (!sync.loaded && ctx.account.keys.state === "ok") {
    sync.refresh().catch(() => draw());
  }
  return {
    route() {},
    destroy() {
      off();
      clearInterval(timer);
    },
  };
}
