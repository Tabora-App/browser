/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Экран «Коды входа» в приложении для телефона: список кодов с отсчётом времени, копирование по
 * нажатию, добавление по ключу, ссылке, QR-коду или файлу переноса, правка и удаление. Экран
 * открывается после подтверждения владельца телефона (отпечаток, лицо или код блокировки). */

import { parseImportText } from "../core/otp.js";
import { clear, h, icon } from "../lib/dom.js";
import { avatar, busy, confirmDialog, copyText, emptyState, errorText, field, formError, menu, modal, plural, toast } from "../lib/ui.js";
import { t } from "../core/i18n.js";

const SVG = "http://www.w3.org/2000/svg";
const RING = 2 * Math.PI * 9;

function ring() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", 26);
  svg.setAttribute("height", 26);
  svg.classList.add("ring");
  const circle = cls => {
    const c = document.createElementNS(SVG, "circle");
    c.setAttribute("cx", 12);
    c.setAttribute("cy", 12);
    c.setAttribute("r", 9);
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", 2.6);
    c.classList.add(cls);
    return c;
  };
  const bar = circle("ring-bar");
  bar.setAttribute("stroke-dasharray", RING.toFixed(2));
  bar.setAttribute("transform", "rotate(-90 12 12)");
  svg.append(circle("ring-track"), bar);
  return { svg, bar };
}

const spaced = code => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code);

/**
 * @param {HTMLElement} root
 * @param {{ service: import("./service.js").Service }} ctx
 */
export function mountCodes(root, { service }) {
  const { codes } = service;
  let open = false; // владелец подтвердил, что телефон в его руках
  let asking = false;
  let query = "";
  let shown = ""; // что нарисовано: перерисовка только при перемене списка
  let cards = []; // { id, period, codeEl, bar, step, code }
  const body = h("div", { class: "codes-body" });
  const search = h("input", { type: "search", placeholder: t`Поиск по сервису или аккаунту`, "aria-label": t`Поиск`, autocomplete: "off", spellcheck: "false" });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    shown = "";
    draw();
  });
  const tools = h("div", { class: "pane-tools", hidden: true }, h("label", { class: "search" }, icon("search", 17), search));
  const fab = h("button", { class: "fab", hidden: true, onclick: () => add() }, icon("plus", 20), t`Добавить`);
  clear(root, h("div", { class: "phone-page codes-page" }, tools, body), fab);

  async function unlock() {
    if (asking) {
      return;
    }
    asking = true;
    try {
      open = await service.unlock();
    } finally {
      asking = false;
    }
    shown = "";
    draw();
  }

  function gate(s) {
    if (!s.signedIn) {
      return emptyState({ iconName: "user", title: t`Войдите в аккаунт Tabora`, text: t`Коды входа хранятся в аккаунте: после входа здесь появятся коды с ваших других устройств.`, action: h("button", { class: "btn primary", onclick: () => service.open("account") }, t`Войти`) });
    }
    if (!s.codesOn) {
      return emptyState({ iconName: "code", title: t`Коды на этом телефоне выключены`, text: t`Включить их можно в аккаунте Tabora.`, action: h("button", { class: "btn primary", onclick: () => service.open("account") }, t`Аккаунт Tabora`) });
    }
    if (s.keys === "locked" || s.status === "locked") {
      return emptyState({ iconName: "lock", title: t`Ключ аккаунта не открыт`, text: t`Его копия на сервере привязана к прежнему паролю. Откройте ключ в аккаунте Tabora.`, action: h("button", { class: "btn primary", onclick: () => service.open("account") }, t`Аккаунт Tabora`) });
    }
    if (!open) {
      return emptyState({ iconName: "lock", title: t`Коды закрыты`, text: t`Подтвердите, что телефон в ваших руках: отпечатком, лицом или кодом блокировки.`, action: h("button", { class: "btn primary", onclick: unlock }, t`Открыть@@сейф`) });
    }
    if (!s.loaded) {
      return h("div", { class: "loading" }, h("span", { class: "spinner" }));
    }
    return null;
  }

  function draw() {
    const s = service.state();
    const blocked = gate(s);
    const all = blocked ? [] : codes.list();
    const list = query ? all.filter(c => `${c.issuer} ${c.account}`.toLowerCase().includes(query)) : all;
    const mark = JSON.stringify([s.signedIn, s.codesOn, s.keys, s.status === "locked", open, s.loaded, query, list]);
    if (mark === shown) {
      return;
    }
    shown = mark;
    cards = [];
    fab.hidden = !!blocked;
    tools.hidden = !!blocked || all.length < 6;
    if (blocked) {
      clear(body, blocked);
      return;
    }
    if (!all.length) {
      clear(body, emptyState({ iconName: "code", title: t`Кодов пока нет`, text: t`Коды из Tabora на компьютере появятся здесь сами, когда там включена синхронизация. Новый код добавляется по QR-коду или ключу, который сайт показывает при настройке входа в два шага.`, action: h("button", { class: "btn primary", onclick: () => add() }, icon("plus", 16), t`Добавить код`) }));
      return;
    }
    if (!list.length) {
      clear(body, emptyState({ iconName: "search", title: t`Ничего не найдено`, text: t`Попробуйте название сервиса или адрес почты.` }));
      return;
    }
    clear(body, h("div", { class: "codes" }, list.map(c => {
      const r = ring();
      const name = c.issuer || c.account;
      const codeEl = h("span", { class: "code-value mono" }, "··· ···");
      const more = h("button", { class: "icon-btn", "aria-label": t`Действия` }, icon("more", 20, 2.4));
      const main = h("button", { class: "code-main", "aria-label": t`Скопировать код ${name}` },
        avatar(name),
        h("span", { class: "row-text" }, h("b", {}, name), c.issuer && c.account ? h("span", {}, c.account) : null),
        codeEl, r.svg);
      const card = { id: c.id, period: c.period, codeEl, bar: r.bar, step: -1, code: "" };
      main.addEventListener("click", () => card.code && copyText(card.code, t`Код скопирован`));
      more.addEventListener("click", () => menu(more, [
        { label: t`Изменить`, icon: "edit", run: () => edit(c) },
        { label: t`Удалить`, icon: "trash", danger: true, run: () => remove(c) },
      ]));
      cards.push(card);
      return h("div", { class: "code-card" }, main, more);
    })));
    tick();
  }

  async function tick() {
    const now = Date.now();
    for (const c of cards) {
      const step = Math.floor(now / 1000 / c.period);
      if (step !== c.step) {
        c.step = step;
        try {
          c.code = (await codes.code(c.id, now)).code;
          c.codeEl.textContent = spaced(c.code);
        } catch (e) {
          c.code = "";
          c.codeEl.textContent = "—";
        }
      }
      const left = c.period - ((now / 1000) % c.period);
      c.bar.style.strokeDashoffset = (RING * (1 - left / c.period)).toFixed(2);
      c.bar.classList.toggle("ending", left <= 5);
    }
  }

  /* ---- добавление ---- */

  function add() {
    let mode = "scan";
    const issuer = field(t`Сервис`, { placeholder: t`например, GitHub` });
    const acc = field(t`Аккаунт`, { placeholder: t`имя или почта` });
    const secret = field(t`Секретный ключ`, { mono: true, placeholder: "JBSW Y3DP EHPK 3PXP", hint: t`Сайт показывает его рядом с QR-кодом, обычно по ссылке «Не удаётся отсканировать?».` });
    const link = field(t`Ссылка или текст из QR-кода`, { type: "textarea", mono: true, rows: 3, placeholder: "otpauth://totp/…", hint: t`Подойдёт и перенос из Google Authenticator, и файл экспорта Aegis или 2FAS без шифрования.` });
    const error = formError();
    const tabs = h("div", { class: "chips" });
    const form = h("div", { class: "modal-form" });
    // снимок камерой и выбор файла — через системные окна телефона: странице камера не выдаётся
    const camera = h("input", { type: "file", accept: "image/*", capture: "environment", class: "offscreen", tabindex: "-1" });
    const file = h("input", { type: "file", accept: "image/*,.txt,.json,text/plain,application/json", class: "offscreen", tabindex: "-1" });
    const drawTabs = () => {
      clear(tabs,
        h("button", { class: "chip", type: "button", "aria-pressed": String(mode === "scan"), onclick: () => { mode = "scan"; drawTabs(); } }, t`QR-код или ссылка`),
        h("button", { class: "chip", type: "button", "aria-pressed": String(mode === "manual"), onclick: () => { mode = "manual"; drawTabs(); } }, t`Ввести ключ`));
      clear(form, mode === "manual" ? [issuer.el, acc.el, secret.el] : [
        h("div", { class: "section-actions" },
          // фокус — на кнопке, а не на поле ссылки: клавиатура не должна сразу закрывать пол-окна
          h("button", { class: "btn", type: "button", autofocus: true, onclick: () => camera.click() }, icon("camera", 16), t`Снять QR-код`),
          h("button", { class: "btn", type: "button", onclick: () => file.click() }, icon("image", 16), t`Картинка или файл`)),
        link.el,
      ], error.el);
      error.set("");
    };
    drawTabs();
    const submit = h("button", { class: "btn primary" }, t`Добавить`);
    const m = modal({ title: t`Новый код входа`, content: [tabs, form, camera, file], actions: [h("button", { class: "btn", onclick: () => m.close() }, t`Отмена`), submit] });

    const take = async input => {
      const picked = input.files[0];
      input.value = "";
      if (!picked) {
        return;
      }
      error.set("");
      try {
        if (picked.type.startsWith("image/")) {
          const text = await qrFromImage(picked);
          if (!text) {
            throw new Error(t`На снимке не нашлось QR-кода. Снимите его крупнее и чётче`);
          }
          link.value = text;
        } else {
          if (picked.size > 2 * 1024 * 1024) {
            throw new Error(t`Файл слишком большой`);
          }
          link.value = await picked.text();
        }
        submit.click();
      } catch (e) {
        error.set(errorText(e));
      }
    };
    camera.addEventListener("change", () => take(camera));
    file.addEventListener("change", () => take(file));

    submit.addEventListener("click", async () => {
      error.set("");
      try {
        let added = 0;
        let skipped = [];
        await busy(submit, async () => {
          if (mode === "manual") {
            added = await codes.add([{ issuer: issuer.value, account: acc.value, secret: secret.value }]);
            if (!added) {
              throw new Error(t`Такой код уже есть в списке`);
            }
          } else {
            const parsed = parseImportText(link.value);
            skipped = parsed.skipped;
            if (!parsed.entries.length) {
              throw new Error(skipped[0] || t`Не удалось разобрать: нужна ссылка otpauth://`);
            }
            added = await codes.add(parsed.entries);
            if (!added) {
              throw new Error(t`Эти коды уже есть в списке`);
            }
          }
        }, t`Добавляем`);
        m.close();
        toast(added === 1 ? t`Код добавлен` : skipped.length ? t`Добавлено: ${plural(added, t`код|кода|кодов`)}, пропущено: ${skipped.length}` : t`Добавлено: ${plural(added, t`код|кода|кодов`)}`);
      } catch (e) {
        error.set(errorText(e));
      }
    });
  }

  function edit(c) {
    const issuer = field(t`Сервис`, { value: c.issuer });
    const acc = field(t`Аккаунт`, { value: c.account });
    const sites = field(t`Сайты`, { value: c.sites.map(w => w.host).join(", "), placeholder: "github.com", inputmode: "url", hint: t`На этих сайтах Tabora сам предложит вставить код. Через запятую.` });
    const error = formError();
    const submit = h("button", { class: "btn primary" }, t`Сохранить`);
    const m = modal({ title: t`Изменить код`, content: [h("div", { class: "modal-form" }, issuer.el, acc.el, sites.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, t`Отмена`), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      try {
        await busy(submit, () => codes.edit(c.id, { issuer: issuer.value, account: acc.value, sites: sites.value }), t`Сохраняем`);
        m.close();
        toast(t`Сохранено`);
      } catch (e) {
        error.set(errorText(e));
      }
    });
  }

  async function remove(c) {
    const name = [c.issuer, c.account].filter(Boolean).join(", ");
    const yes = await confirmDialog({
      title: t`Удалить код?`,
      text: t`Код «${name}» исчезнет на всех ваших устройствах. Если вход в два шага на сайте ещё включён, без этого кода вы можете не войти: сначала отключите его на сайте или убедитесь, что есть резервные коды.`,
      confirm: t`Удалить`,
      danger: true,
    });
    if (!yes) {
      return;
    }
    try {
      await codes.remove(c.id);
      toast(t`Код удалён`);
    } catch (e) {
      toast(errorText(e), { tone: "bad" });
    }
  }

  const timer = setInterval(tick, 1000);
  const off = service.subscribe(() => draw());
  draw();
  if (!gateNeedsAuth()) {
    // сразу спросить подтверждение: человек открыл экран, чтобы увидеть коды
    unlock();
  }

  function gateNeedsAuth() {
    const s = service.state();
    return !s.signedIn || !s.codesOn || s.keys === "locked" || s.status === "locked";
  }

  return {
    destroy() {
      off();
      clearInterval(timer);
      clear(root);
    },
  };
}

/* ---- QR-код со снимка ---- */

async function qrFromImage(file) {
  const jsQR = (await import("jsqr")).default;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(t`Картинка не открылась`));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });
    // несколько размеров: мелкий код на большом снимке читается хуже
    for (const max of [1200, 800, 1800, 500]) {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = g.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(data.data, data.width, data.height);
      if (hit?.data) {
        return hit.data;
      }
    }
    return "";
  } finally {
    URL.revokeObjectURL(url);
  }
}
