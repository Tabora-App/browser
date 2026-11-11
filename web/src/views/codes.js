/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Коды входа (второй шаг на сайтах): считаются здесь же из секрета, который пришёл синхронизацией. */

import { base32Decode, parseImportText, totp } from "../core/otp.js";
import { newOtp, normalizeSites, otpValid } from "../core/records.js";
import { clear, h, icon } from "../lib/dom.js";
import { avatar, busy, confirmDialog, copyText, emptyState, errorText, field, formError, menu, modal, plural, toast } from "../lib/ui.js";
import { save, split, syncGate, watch } from "./common.js";

const SVG = "http://www.w3.org/2000/svg";
const RING = 2 * Math.PI * 9;

function ring() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", 26);
  svg.setAttribute("height", 26);
  svg.classList.add("ring");
  const circle = (cls) => {
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

export function mountCodes(el, ctx) {
  const { sync } = ctx;
  const s = split({ single: true });
  let query = "";
  let cards = []; // { item, code, codeEl, bar, period, secret }
  const count = h("small", {});
  const listBody = h("div", { class: "list codes" });
  const search = h("input", { type: "search", placeholder: "Поиск по сервису или аккаунту", "aria-label": "Поиск", autocomplete: "off", spellcheck: "false" });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  const addButton = h("button", { class: "btn primary small hide-phone", onclick: () => add() }, icon("plus", 16), "Добавить");
  const tools = h("div", { class: "pane-tools" }, h("label", { class: "search" }, icon("search", 17), search));
  clear(s.list,
    h("header", { class: "pane-head" }, h("h1", {}, "Коды входа", count), addButton),
    tools, listBody,
    h("button", { class: "fab", onclick: () => add() }, icon("plus", 20), "Добавить"));
  s.list.classList.add("codes-pane");
  clear(el, s.el);

  const items = () => sync.list("otp").filter(o => otpValid(o.data)).sort((a, b) => (a.data.i || a.data.a).localeCompare(b.data.i || b.data.a) || a.data.a.localeCompare(b.data.a));

  function draw() {
    const gate = syncGate(ctx, "коды входа");
    addButton.disabled = !!gate;
    cards = [];
    if (gate) {
      count.textContent = "";
      tools.hidden = true;
      clear(listBody, gate);
      return;
    }
    const all = items();
    count.textContent = all.length ? String(all.length) : "";
    tools.hidden = all.length < 6;
    const shown = query ? all.filter(o => `${o.data.i} ${o.data.a}`.toLowerCase().includes(query)) : all;
    if (!all.length) {
      clear(listBody, emptyState({ iconName: "code", title: "Кодов пока нет", text: "Коды из Tabora на компьютере появятся здесь после включения синхронизации. Новый код добавляется по QR-коду или ключу, который показывает сайт при настройке входа в два шага.", action: h("button", { class: "btn primary", onclick: () => add() }, "Добавить код") }));
      return;
    }
    if (!shown.length) {
      clear(listBody, emptyState({ iconName: "search", title: "Ничего не найдено", text: "Попробуйте название сервиса или адрес почты." }));
      return;
    }
    clear(listBody, shown.map(o => {
      const d = o.data;
      const r = ring();
      const codeEl = h("span", { class: "code-value mono" }, "··· ···");
      const more = h("button", { class: "icon-btn", "aria-label": "Действия" }, icon("more", 20, 2.4));
      const card = h("div", { class: "code-card" },
        h("button", { class: "code-main", "aria-label": `Скопировать код ${d.i || d.a}` },
          avatar(d.i || d.a),
          h("span", { class: "row-text" }, h("b", {}, d.i || d.a), d.i && d.a ? h("span", {}, d.a) : null),
          codeEl, r.svg),
        more);
      const entry = { item: o, code: "", codeEl, bar: r.bar, period: d.p, secret: null, step: -1 };
      card.querySelector(".code-main").addEventListener("click", () => entry.code && copyText(entry.code, "Код скопирован"));
      more.addEventListener("click", () => menu(more, [
        { label: "Изменить", icon: "edit", run: () => edit(o) },
        { label: "Удалить", icon: "trash", danger: true, run: () => remove(o) },
      ]));
      cards.push(entry);
      return card;
    }));
    tick();
  }

  async function tick() {
    const now = Date.now();
    for (const c of cards) {
      const step = Math.floor(now / 1000 / c.period);
      if (step !== c.step) {
        c.step = step;
        try {
          c.secret ||= base32Decode(c.item.data.s);
          c.code = await totp(c.secret, { algorithm: c.item.data.al, digits: c.item.data.d, period: c.period, now });
          c.codeEl.textContent = spaced(c.code);
        } catch (e) {
          c.code = "";
          c.codeEl.textContent = "ошибка";
        }
      }
      const left = c.period - ((now / 1000) % c.period);
      c.bar.style.strokeDashoffset = (RING * (1 - left / c.period)).toFixed(2);
      c.bar.classList.toggle("ending", left <= 5);
    }
  }

  /* ---- добавление ---- */

  async function addEntries(entries) {
    const existing = new Set(sync.list("otp").map(o => `${o.data.i}|${o.data.a}|${o.data.s}`));
    const changes = [];
    for (const e of entries) {
      const made = await newOtp(e);
      const key = `${made.data.i}|${made.data.a}|${made.data.s}`;
      if (!existing.has(key)) {
        existing.add(key);
        // номера записей строятся от времени: чуть разносим, чтобы не совпали
        changes.push({ c: "otp", id: `${made.id}${changes.length.toString(36)}`.slice(0, 40), data: made.data });
      }
    }
    if (!changes.length) {
      return 0;
    }
    await sync.write(changes);
    return changes.length;
  }

  function add() {
    let mode = "manual";
    const issuer = field("Сервис", { placeholder: "например, GitHub", autofocus: true });
    const acc = field("Аккаунт", { placeholder: "имя или почта" });
    const secret = field("Секретный ключ", { mono: true, placeholder: "JBSW Y3DP EHPK 3PXP", hint: "Сайт показывает его рядом с QR-кодом, обычно по ссылке «Не удаётся отсканировать?»." });
    const link = field("Ссылка или текст из QR-кода", { type: "textarea", mono: true, rows: 3, placeholder: "otpauth://totp/…", hint: "Подойдёт и перенос из Google Authenticator, и файл экспорта Aegis или 2FAS без шифрования." });
    const error = formError();
    const tabs = h("div", { class: "chips" });
    const body = h("div", { class: "modal-form" });
    const fileInput = h("input", { type: "file", accept: "image/*,.txt,.json,text/plain,application/json", class: "offscreen", tabindex: "-1" });
    const drawTabs = () => {
      clear(tabs,
        h("button", { class: "chip", type: "button", "aria-pressed": String(mode === "manual"), onclick: () => { mode = "manual"; drawTabs(); } }, "Ввести ключ"),
        h("button", { class: "chip", type: "button", "aria-pressed": String(mode === "link"), onclick: () => { mode = "link"; drawTabs(); } }, "Ссылка или QR-код"));
      clear(body, mode === "manual" ? [issuer.el, acc.el, secret.el] : [
        h("div", { class: "section-actions" },
          h("button", { class: "btn", type: "button", onclick: scan }, icon("camera", 16), "Навести камеру"),
          h("button", { class: "btn", type: "button", onclick: () => fileInput.click() }, icon("image", 16), "Картинка или файл")),
        link.el, fileInput,
      ], error.el);
      error.set("");
    };
    drawTabs();
    const submit = h("button", { class: "btn primary" }, "Добавить");
    const m = modal({ title: "Новый код входа", content: [tabs, body], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });

    async function scan() {
      try {
        const text = await scanQr();
        if (text) {
          link.value = text;
          submit.click();
        }
      } catch (e) {
        error.set(errorText(e));
      }
    }
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      fileInput.value = "";
      if (!file) {
        return;
      }
      error.set("");
      try {
        if (file.type.startsWith("image/")) {
          const text = await qrFromImage(file);
          if (!text) {
            throw new Error("На картинке не нашлось QR-кода. Попробуйте снимок крупнее и чётче");
          }
          link.value = text;
        } else {
          if (file.size > 2 * 1024 * 1024) {
            throw new Error("Файл слишком большой");
          }
          link.value = await file.text();
        }
        submit.click();
      } catch (e) {
        error.set(errorText(e));
      }
    });

    submit.addEventListener("click", async () => {
      error.set("");
      try {
        let added = 0;
        let skipped = [];
        await busy(submit, async () => {
          if (mode === "manual") {
            added = await addEntries([{ issuer: issuer.value, account: acc.value, secret: secret.value }]);
            if (!added) {
              throw new Error("Такой код уже есть в списке");
            }
          } else {
            const parsed = parseImportText(link.value);
            skipped = parsed.skipped;
            if (!parsed.entries.length) {
              throw new Error(skipped[0] || "Не удалось разобрать: нужна ссылка otpauth://");
            }
            added = await addEntries(parsed.entries);
            if (!added) {
              throw new Error("Эти коды уже есть в списке");
            }
          }
        }, "Добавляем");
        m.close();
        toast(added === 1 ? "Код добавлен" : `Добавлено: ${plural(added, "код", "кода", "кодов")}${skipped.length ? `, пропущено: ${skipped.length}` : ""}`);
      } catch (e) {
        error.set(errorText(e));
      }
    });
  }

  function edit(o) {
    const issuer = field("Сервис", { value: o.data.i, autofocus: true });
    const acc = field("Аккаунт", { value: o.data.a });
    const sites = field("Сайты", { value: (o.data.w || []).map(w => w.host).join(", "), placeholder: "github.com", hint: "На этих сайтах Tabora на компьютере сам предложит код. Через запятую." });
    const error = formError();
    const submit = h("button", { class: "btn primary" }, "Сохранить");
    const m = modal({ title: "Изменить код", content: [h("div", { class: "modal-form" }, issuer.el, acc.el, sites.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      const i = issuer.value.trim().slice(0, 48);
      const a = acc.value.trim().slice(0, 96);
      if (!i && !a) {
        error.set("Укажите сервис или аккаунт");
        return;
      }
      const prev = new Map((o.data.w || []).map(w => [w.host, w.sub]));
      const w = normalizeSites(sites.value).map(x => ({ host: x.host, sub: !!prev.get(x.host) }));
      try {
        await busy(submit, () => sync.put("otp", o.id, { ...o.data, i, a, w }), "Сохраняем");
        m.close();
        toast("Сохранено");
      } catch (e) {
        error.set(errorText(e));
      }
    });
  }

  async function remove(o) {
    const name = [o.data.i, o.data.a].filter(Boolean).join(" · ");
    if (!(await confirmDialog({ title: "Удалить код?", text: `Код «${name}» исчезнет на всех ваших устройствах. Если вход в два шага на сайте ещё включён, без этого кода вы можете не войти: сначала отключите его на сайте или убедитесь, что есть резервные коды.`, confirm: "Удалить", danger: true }))) {
      return;
    }
    await save(ctx, () => sync.remove("otp", o.id), "Код удалён");
  }

  const timer = setInterval(tick, 1000);
  const off = watch(ctx, draw);
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

/* ---- QR-коды ---- */

async function decoder() {
  return (await import("jsqr")).default;
}

async function qrFromImage(file) {
  const jsQR = await decoder();
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Картинка не открылась"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });
    // пробуем несколько размеров: мелкий код на большом снимке читается хуже
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

/** Окно с камерой: возвращает текст QR-кода или "" (закрыто). Камера выключается при закрытии. */
function scanQr() {
  return new Promise((resolve, reject) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      reject(new Error("Камера в этом браузере недоступна. Загрузите снимок QR-кода картинкой"));
      return;
    }
    const video = h("video", { class: "scan-video", playsinline: true, muted: true, autoplay: true });
    const hint = h("p", { class: "modal-text" }, "Наведите камеру на QR-код, который показывает сайт.");
    let stream = null;
    let raf = 0;
    let done = false;
    const stop = () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach(t => t.stop());
    };
    const m = modal({ title: "Сканирование QR-кода", content: [h("div", { class: "scan-box" }, video), hint], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена")], onclose: value => { stop(); resolve(value || ""); } });
    (async () => {
      try {
        const jsQR = await decoder();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
        if (done) {
          stop();
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => {});
        const canvas = document.createElement("canvas");
        const g = canvas.getContext("2d", { willReadFrequently: true });
        let last = 0;
        const frame = t => {
          if (done) {
            return;
          }
          raf = requestAnimationFrame(frame);
          if (t - last < 160 || !video.videoWidth) {
            return;
          }
          last = t;
          const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * k);
          canvas.height = Math.round(video.videoHeight * k);
          g.drawImage(video, 0, 0, canvas.width, canvas.height);
          const data = g.getImageData(0, 0, canvas.width, canvas.height);
          const hit = jsQR(data.data, data.width, data.height, { inversionAttempts: "dontInvert" });
          if (hit?.data) {
            m.close(hit.data);
          }
        };
        raf = requestAnimationFrame(frame);
      } catch (e) {
        hint.textContent = e.name === "NotAllowedError" ? "Доступ к камере не разрешён. Разрешите его в настройках сайта или загрузите снимок QR-кода картинкой." : "Камера не включилась. Загрузите снимок QR-кода картинкой.";
        hint.classList.add("bad-text");
      }
    })();
  });
}
