/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Обращения в поддержку: своя переписка с командой Tabora. Сервер хранит её открыто — её читают
 * сотрудники поддержки, и об этом сказано над формой. Сотрудник видит здесь же очередь всех. */

import { b64 } from "../core/bytes.js";
import { clear, h, icon } from "../lib/dom.js";
import { busy, emptyState, errorText, field, fileSize, formError, longDate, modal, shortDate, toast } from "../lib/ui.js";
import { backButton, split } from "./common.js";

const FILE_MAX = 2 * 1024 * 1024;
const FILES_MAX = 4;
const TYPES = ["image/png", "image/jpeg", "image/webp", "text/plain"];
const STATUS = { open: ["ждёт ответа", "warn"], answered: ["есть ответ", "ok"], closed: ["закрыто", "quiet"] };
const NOTICE = "Переписку читают сотрудники поддержки Tabora: она не зашифрована от них. Не присылайте пароли, коды и ключ восстановления.";

/** Вложения к сообщению: кнопка выбора, список выбранного и чтение в вид для сервера. */
function attachments() {
  let files = [];
  const input = h("input", { type: "file", multiple: true, accept: TYPES.join(","), class: "offscreen", tabindex: "-1" });
  const list = h("div", { class: "attach-list" });
  const button = h("button", { class: "btn small", type: "button", onclick: () => input.click() }, icon("clip", 15), "Приложить");
  const draw = () => {
    clear(list, files.map((f, i) => h("span", { class: "attach" }, icon(f.type.startsWith("image/") ? "image" : "clip", 14), h("span", {}, f.name), h("small", {}, fileSize(f.size)), h("button", { class: "icon-btn tiny", type: "button", "aria-label": `Убрать ${f.name}`, onclick: () => { files.splice(i, 1); draw(); } }, icon("close", 13)))));
    button.disabled = files.length >= FILES_MAX;
  };
  input.addEventListener("change", () => {
    for (const f of input.files) {
      if (files.length >= FILES_MAX) {
        toast(`Не больше ${FILES_MAX} вложений`, { tone: "bad" });
        break;
      }
      if (!TYPES.includes(f.type)) {
        toast(`${f.name}: подходят снимки PNG, JPEG, WebP и текстовые файлы`, { tone: "bad" });
      } else if (f.size > FILE_MAX || !f.size) {
        toast(`${f.name}: файл больше 2 МБ`, { tone: "bad" });
      } else {
        files.push(f);
      }
    }
    input.value = "";
    draw();
  });
  draw();
  return {
    button, list, input,
    async read() {
      return Promise.all(files.map(async f => ({ name: f.name, type: f.type, data: b64(new Uint8Array(await f.arrayBuffer())) })));
    },
    clear() { files = []; draw(); },
  };
}

export function mountSupport(el, ctx, rest) {
  const { api, account } = ctx;
  const s = split();
  let scope = "mine";
  let staff = false;
  let tickets = null; // null — ещё не загружены
  let listError = "";
  let selected = rest[0] ? Number(rest[0]) : 0;
  let ticket = null;
  let ticketError = "";
  let draft = "";
  let alive = true;

  const listBody = h("div", { class: "list" });
  const scopeTabs = h("div", { class: "chips" });
  const newButton = h("button", { class: "btn primary small hide-phone", onclick: create }, icon("plus", 16), "Написать");
  clear(s.list,
    h("header", { class: "pane-head" }, h("h1", {}, "Поддержка"), newButton),
    h("div", { class: "pane-tools" }, scopeTabs),
    listBody,
    h("button", { class: "fab", onclick: create }, icon("plus", 20), "Написать"));
  clear(el, s.el);

  const chip = (st) => h("span", { class: `status ${STATUS[st]?.[1] || "quiet"}` }, STATUS[st]?.[0] || st);

  async function loadList() {
    try {
      const r = await api.supportTickets(account.token, { scope });
      if (!alive) {
        return;
      }
      staff = !!r.staff;
      tickets = r.tickets || [];
      listError = "";
    } catch (e) {
      if (!alive) {
        return;
      }
      listError = errorText(e);
      tickets ||= [];
    }
    drawList();
    ctx.pollSupport?.();
  }

  function drawList() {
    clear(scopeTabs, staff ? [["mine", "Мои обращения"], ["all", "Очередь поддержки"]].map(([id, label]) => h("button", { class: "chip", "aria-pressed": String(scope === id), onclick: () => { if (scope !== id) { scope = id; tickets = null; drawList(); loadList(); } } }, label)) : []);
    scopeTabs.parentElement.hidden = !staff;
    if (tickets === null) {
      clear(listBody, h("div", { class: "skeleton", "aria-label": "Загрузка" }, h("i"), h("i"), h("i")));
      return;
    }
    if (listError && !tickets.length) {
      const retry = h("button", { class: "btn" }, "Повторить");
      retry.addEventListener("click", () => busy(retry, loadList, "Загружаем"));
      clear(listBody, h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("sync", 26, 1.6)), h("h3", {}, "Не удалось загрузить обращения"), h("p", {}, listError), retry));
      return;
    }
    if (!tickets.length) {
      clear(listBody, scope === "all"
        ? emptyState({ iconName: "support", title: "Очередь пуста", text: "Новых обращений нет." })
        : emptyState({ iconName: "support", title: "Что-то не работает или есть идея?", text: "Опишите, приложите снимок экрана — ответ придёт сюда же.", action: h("button", { class: "btn primary", onclick: create }, "Написать в поддержку") }));
      return;
    }
    clear(listBody, tickets.map(t => h("a", { class: `row ticket${t.unread ? " unread" : ""}`, href: `#/support/${t.id}`, "aria-selected": String(t.id === selected) },
      h("span", { class: "row-text" },
        h("b", {}, t.subject),
        h("span", {}, [t.author, `№ ${t.id}`, shortDate(t.updatedAt)].filter(Boolean).join(" · "))),
      h("span", { class: "row-end" }, t.unread ? h("span", { class: "dot", "aria-label": "Новый ответ" }) : null, chip(t.status)))));
  }

  async function loadTicket() {
    if (!selected) {
      ticket = null;
      drawDetail();
      return;
    }
    const id = selected;
    try {
      const t = await api.supportTicket(account.token, id);
      if (!alive || id !== selected) {
        return;
      }
      ticket = t;
      ticketError = "";
      const inList = tickets?.find(x => x.id === id);
      if (inList) {
        inList.unread = false;
        inList.status = t.status;
        drawList();
      }
    } catch (e) {
      if (!alive || id !== selected) {
        return;
      }
      ticket = null;
      ticketError = e.code === "not-found" ? "Обращение не найдено" : errorText(e);
    }
    drawDetail();
    ctx.pollSupport?.();
  }

  async function openFile(f) {
    try {
      const blob = await api.supportFile(account.token, f.id);
      const url = URL.createObjectURL(new Blob([blob], { type: TYPES.includes(f.type) ? f.type : "application/octet-stream" }));
      const a = h("a", { href: url, download: f.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast(errorText(e), { tone: "bad" });
    }
  }

  function drawDetail() {
    if (!selected) {
      s.close();
      clear(s.detail, emptyState({ iconName: "support", title: "Выберите обращение", text: "Здесь будет переписка с поддержкой." }));
      return;
    }
    s.open();
    const back = backButton(() => ctx.navigate("support"));
    if (!ticket) {
      clear(s.detail, h("header", { class: "detail-head" }, back), ticketError ? emptyState({ iconName: "warning", title: ticketError, text: "" }) : h("div", { class: "loading" }, h("span", { class: "spinner" })));
      return;
    }
    const t = ticket;
    const mineSide = t.staff ? "staff" : "user";
    const att = attachments();
    const text = h("textarea", { class: "input", rows: 3, maxlength: 8000, placeholder: t.status === "closed" ? "Сообщение откроет обращение снова" : "Ваш ответ", "aria-label": "Ответ" });
    text.value = draft;
    text.addEventListener("input", () => (draft = text.value));
    const error = formError();
    const send = h("button", { class: "btn primary" }, icon("send", 15), "Отправить");
    send.addEventListener("click", async () => {
      error.set("");
      if (!text.value.trim()) {
        error.set("Напишите сообщение");
        text.focus();
        return;
      }
      try {
        await busy(send, async () => {
          ticket = await api.supportReply(account.token, t.id, { text: text.value.trim(), files: await att.read() });
        }, "Отправляем");
        draft = "";
        drawDetail();
        loadList();
      } catch (e) {
        error.set(errorText(e));
      }
    });
    const toggle = h("button", { class: "btn small" }, t.status === "closed" ? "Открыть снова" : "Закрыть обращение");
    toggle.addEventListener("click", async () => {
      try {
        await busy(toggle, async () => {
          ticket = await api.supportStatus(account.token, t.id, t.status === "closed" ? "open" : "closed");
        });
        drawDetail();
        loadList();
      } catch (e) {
        toast(errorText(e), { tone: "bad" });
      }
    });
    const thread = h("div", { class: "thread" }, t.messages.map(m => h("div", { class: `bubble ${m.from === mineSide ? "mine" : "theirs"}` },
      h("div", { class: "bubble-head" }, h("b", {}, m.from === "staff" ? "Поддержка Tabora" : t.staff ? t.author || "Пользователь" : "Вы"), h("time", { title: longDate(m.at) }, shortDate(m.at))),
      h("div", { class: "bubble-text" }, m.text),
      m.files?.length ? h("div", { class: "attach-list" }, m.files.map(f => h("button", { class: "attach link", onclick: () => openFile(f) }, icon(String(f.type).startsWith("image/") ? "image" : "clip", 14), h("span", {}, f.name), h("small", {}, fileSize(f.size))))) : null)));
    const meta = t.staff && t.meta ? h("div", { class: "note" }, icon("info", 17), h("div", {}, h("span", {}, Object.entries(t.meta).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ")))) : null;
    clear(s.detail,
      h("header", { class: "detail-head" }, back, h("div", { class: "detail-title" }, h("h2", {}, t.subject)), chip(t.status)),
      h("div", { class: "detail-body support-body" },
        h("p", { class: "detail-meta" }, [`Обращение № ${t.id}`, t.author && t.staff ? t.author : "", `создано ${longDate(t.createdAt)}`].filter(Boolean).join(" · ")),
        meta, thread,
        h("div", { class: "reply-box" }, text, att.list, att.input, error.el, h("div", { class: "reply-actions" }, att.button, toggle, h("span", { class: "spacer" }), send))));
    const body = s.detail.querySelector(".support-body");
    s.detail.scrollTop = body.scrollHeight;
  }

  function create() {
    const subject = field("Тема", { maxlength: 140, placeholder: "Что случилось, в двух словах", autofocus: true });
    const text = field("Сообщение", { type: "textarea", rows: 6, maxlength: 8000, placeholder: "Что вы делали, что ожидали и что получилось", spellcheck: true });
    const att = attachments();
    const error = formError();
    const submit = h("button", { class: "btn primary" }, "Отправить");
    const m = modal({ title: "Новое обращение", wide: true, content: [h("div", { class: "note" }, icon("info", 17), h("div", {}, h("span", {}, NOTICE))), h("div", { class: "modal-form" }, subject.el, text.el, att.list, att.input, error.el)], actions: [att.button, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      if (subject.value.trim().length < 3) {
        error.set("Коротко назовите тему обращения");
        subject.input.focus();
        return;
      }
      if (!text.value.trim()) {
        error.set("Опишите, что случилось");
        text.input.focus();
        return;
      }
      try {
        const t = await busy(submit, async () => api.supportCreate(account.token, {
          subject: subject.value.trim(), text: text.value.trim(), files: await att.read(),
          meta: { app: "Веб-версия", version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "", browser: navigator.userAgent.slice(0, 300), screen: `${window.innerWidth}×${window.innerHeight}` },
        }), "Отправляем");
        m.close();
        toast("Обращение отправлено");
        scope = "mine";
        await loadList();
        ctx.navigate(`support/${t.id}`);
      } catch (e) {
        error.set(errorText(e));
      }
    });
  }

  drawList();
  drawDetail();
  loadList();
  loadTicket();
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") {
      loadList();
      if (selected && !draft) {
        loadTicket();
      }
    }
  }, 60000);

  return {
    route(next) {
      const id = next[0] ? Number(next[0]) : 0;
      if (id !== selected) {
        selected = id;
        ticket = null;
        ticketError = "";
        draft = "";
        drawList();
        drawDetail();
        loadTicket();
      }
    },
    destroy() {
      alive = false;
      clearInterval(timer);
    },
  };
}
