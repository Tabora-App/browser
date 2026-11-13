/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The screens of the support site.
 *
 *   home    nobody is signed in: sign in with a Tabora account, or write without one
 *   desk    signed in: the list of requests, a new request, a request with its conversation;
 *           for support staff also the queue of everyone's requests
 *   guest   a request without an account, opened by the link from the letter
 *
 * Conversations are read by support staff and are not encrypted from them; the page says so
 * where a person writes. Everything a person or the server sends is put into the page as text
 * (lib/dom.js), never as markup; an attachment becomes a picture only if the server called it one. */

import { language, locale, t } from "../core/i18n.js";
import { clear, h, icon, mark } from "../lib/dom.js";
import { busy, errorText, field, fileSize, formError, languagePicker, shortDate, toast } from "../lib/ui.js";

const TYPES = ["image/png", "image/jpeg", "image/webp", "text/plain"];
const IMAGE_RE = /^image\/(png|jpeg|webp)$/;
const FILE_MAX = 2 * 1024 * 1024;
const FILES_MAX = 4;
const WATCH_MS = 20000;

const statusText = (status, staffView) => ({
  open: staffView ? t`ждёт ответа` : t`ждёт ответа поддержки`,
  answered: staffView ? t`отвечено` : t`поддержка ответила`,
  closed: t`закрыто`,
}[status] || status);

const when = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale(), { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
};

const privacyNote = () => t`Переписку читают сотрудники поддержки Tabora: она не зашифрована от них, поэтому не присылайте пароли, коды и фразу восстановления кошелька.`;

function statusChip(status, staffView) {
  return h("span", { class: `desk-status ${status}` }, statusText(status, staffView));
}

/** The bar at the top: the name of the site, the language, and who is signed in. */
function topBar({ session = null, onHome = null } = {}) {
  const brand = h("a", { class: "desk-brand", href: "#/", onclick: onHome && (e => { e.preventDefault(); onHome(); }) }, mark(28), h("span", {}, t`Поддержка Tabora`));
  const right = h("div", { class: "desk-top-side" }, languagePicker());
  if (session?.signedIn) {
    // on a phone the bar has room for the icon only
    const out = h("button", { class: "btn small ghost desk-out", type: "button", "aria-label": t`Выйти`, title: t`Выйти` }, icon("logout", 16), h("span", {}, t`Выйти`));
    out.addEventListener("click", () => busy(out, () => session.signOut()));
    right.append(h("span", { class: "desk-who", title: session.email }, session.email), out);
  }
  return h("header", { class: "desk-top" }, h("div", { class: "desk-top-in" }, brand, right));
}

function pageOf(top, ...content) {
  return h("div", { class: "desk" }, top, h("main", { class: "desk-main" }, content));
}

/* ---- attachments ---- */

/** A large screenshot is scaled down to the server's limit instead of being refused. */
async function fit(file) {
  if (file.size <= FILE_MAX || !/^image\//.test(file.type)) {
    return file;
  }
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  for (let i = 0; i < 5; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (blob && blob.size <= FILE_MAX) {
      return new File([blob], `${file.name.replace(/\.[a-z0-9]+$/i, "") || t`снимок`}.jpg`, { type: "image/jpeg" });
    }
    scale *= 0.7;
  }
  throw new Error(t`«${file.name}» не удалось уменьшить до 2 МБ`);
}

function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/**
 * The message field: text, and, where files are accepted, a button to attach, pasting a
 * screenshot from the clipboard and the list of what is attached.
 * → { el, text(), files(), reset(), area, pick }
 */
function composer({ placeholder, rows = 4, files: withFiles = true }) {
  const attached = []; // { name, type, size, data, url }
  const area = h("textarea", { class: "input desk-area", rows, maxlength: 8000, placeholder, "aria-label": placeholder });
  const list = h("div", { class: "desk-attached", hidden: true });
  const draw = () => {
    clear(list, attached.map((f, i) => {
      const remove = h("button", { class: "desk-chip-x", type: "button", "aria-label": t`Убрать ${f.name}`, title: t`Убрать` }, icon("close", 13, 2.2));
      remove.addEventListener("click", () => {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
        attached.splice(i, 1);
        draw();
      });
      return h("span", { class: "desk-chip" }, f.url && h("img", { src: f.url, alt: "" }), h("span", {}, `${f.name}, ${fileSize(f.size)}`), remove);
    }));
    list.hidden = !attached.length;
  };
  const attach = async picked => {
    for (const raw of picked) {
      if (attached.length >= FILES_MAX) {
        toast(t`К сообщению можно приложить не больше ${FILES_MAX} файлов`);
        break;
      }
      try {
        if (!TYPES.includes(raw.type)) {
          throw new Error(t`«${raw.name}»: прикладывать можно снимки (PNG, JPEG, WebP) и текстовые файлы`);
        }
        const file = await fit(raw);
        if (file.size > FILE_MAX) {
          throw new Error(t`«${file.name}» больше 2 МБ`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        attached.push({ name: file.name || t`снимок.png`, type: file.type, size: file.size, data: toBase64(bytes), url: /^image\//.test(file.type) ? URL.createObjectURL(file) : "" });
      } catch (e) {
        toast(e.message || String(e), { tone: "bad", ms: 5000 });
      }
    }
    draw();
  };
  let pick = null;
  let input = null;
  if (withFiles) {
    input = h("input", { type: "file", multiple: true, accept: TYPES.join(","), hidden: true });
    input.addEventListener("change", () => {
      attach([...input.files]);
      input.value = "";
    });
    pick = h("button", { class: "btn", type: "button" }, icon("clip", 16), t`Прикрепить файл`);
    pick.addEventListener("click", () => input.click());
    area.addEventListener("paste", e => {
      const pasted = [...(e.clipboardData?.files || [])];
      if (pasted.length) {
        e.preventDefault();
        attach(pasted);
      }
    });
  }
  return {
    el: h("div", { class: "desk-composer" }, area, list, input),
    area,
    pick,
    text: () => area.value,
    files: () => attached.map(f => ({ name: f.name, type: f.type, data: f.data })),
    reset() {
      attached.forEach(f => f.url && URL.revokeObjectURL(f.url));
      attached.length = 0;
      area.value = "";
      draw();
    },
  };
}

/** An attachment of a message: a screenshot is shown as a picture, a text file is saved on a click. */
function attachment(f, load, urls) {
  const get = async () => {
    if (!urls.has(f.id)) {
      const blob = await load(f.id);
      // the type comes from the server's answer: only what the server called a picture becomes one
      const type = TYPES.includes(blob.type) ? blob.type : "application/octet-stream";
      urls.set(f.id, { url: URL.createObjectURL(new Blob([blob], { type })), type });
    }
    return urls.get(f.id);
  };
  if (IMAGE_RE.test(f.type)) {
    const img = h("img", { class: "desk-image", alt: f.name, title: `${f.name}, ${fileSize(f.size)}` });
    get().then(got => {
      if (IMAGE_RE.test(got.type)) {
        img.src = got.url;
      }
    }).catch(() => img.replaceWith(h("span", { class: "desk-chip" }, t`${f.name}: не загрузилось`)));
    img.addEventListener("click", () => img.classList.toggle("wide"));
    return img;
  }
  const link = h("button", { class: "desk-chip link", type: "button", title: t`Сохранить файл` }, icon("download", 14), h("span", {}, `${f.name}, ${fileSize(f.size)}`));
  link.addEventListener("click", async () => {
    try {
      const got = await get();
      const a = h("a", { href: got.url, download: f.name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) {
      toast(errorText(e), { tone: "bad" });
    }
  });
  return link;
}

/* ---- a request with its conversation: the same for an account and for a link ---- */

/**
 * @param {object} ticket what the server gave
 * @param {{ load(): Promise<object>, reply(text: string, files: object[]): Promise<object>, status(next: string): Promise<object>, file(id: number): Promise<Blob>,
 *   files: boolean, back?: () => void, note?: string }} source how this request is read and changed
 * @returns {{ el: HTMLElement, destroy(): void }}
 */
function ticketView(ticket, source) {
  const urls = new Map(); // attachments already loaded, so a refresh does not load them again
  let current = ticket;
  let working = false;
  const box = h("section", { class: "desk-ticket" });
  const c = composer({ placeholder: "", rows: 3, files: source.files });
  const error = formError();

  const draw = () => {
    const tk = current;
    const staffView = !!tk.staff;
    const closed = tk.status === "closed";
    const toggle = h("button", { class: "btn small", type: "button" }, closed ? t`Открыть снова` : t`Закрыть обращение`);
    toggle.addEventListener("click", () => act(toggle, () => source.status(closed ? "open" : "closed")));
    const thread = h("div", { class: "desk-thread", role: "log", "aria-label": t`Переписка` }, (tk.messages || []).map(m => {
      const mine = m.from === (staffView ? "staff" : "user");
      const who = mine ? t`Вы` : m.from === "staff" ? t`Поддержка Tabora` : tk.author || t`Автор обращения`;
      return h("article", { class: `desk-msg ${m.from}${mine ? " mine" : ""}` },
        h("header", {}, h("b", {}, who), h("time", { datetime: m.at }, when(m.at))),
        h("div", { class: "desk-text" }, m.text),
        (m.files || []).length ? h("div", { class: "desk-files" }, m.files.map(f => attachment(f, source.file, urls))) : null);
    }));
    const placeholder = closed ? t`Сообщение откроет обращение снова` : t`Ваш ответ`;
    c.area.placeholder = placeholder;
    c.area.setAttribute("aria-label", placeholder);
    const send = h("button", { class: "btn primary", type: "button" }, t`Ответить`);
    send.addEventListener("click", () => submit(send));
    const meta = staffView && tk.meta ? h("dl", { class: "desk-meta" }, Object.entries(tk.meta).map(([k, v]) => [h("dt", {}, k), h("dd", {}, String(v).slice(0, 120))])) : null;
    clear(box,
      source.back && h("button", { class: "btn small ghost desk-back", type: "button", onclick: source.back }, icon("back", 15), t`Все обращения`),
      h("header", { class: "desk-ticket-head" },
        h("h1", {}, tk.subject),
        h("div", { class: "desk-ticket-line" },
          h("span", { class: "desk-number" }, t`Обращение № ${tk.id}`),
          statusChip(tk.status, staffView),
          staffView && tk.author ? h("span", { class: "desk-author" }, tk.author, tk.guest ? ` (${t`без аккаунта`})` : "") : null,
          !staffView && tk.guest && tk.email ? h("span", { class: "desk-author" }, tk.email) : null,
          toggle)),
      source.note && h("p", { class: "desk-note" }, source.note),
      meta,
      thread,
      h("div", { class: "desk-reply" }, c.el, error.el, h("div", { class: "desk-buttons" }, send, c.pick)));
    thread.lastElementChild?.scrollIntoView({ block: "nearest" });
  };

  async function act(button, fn) {
    if (working) {
      return;
    }
    working = true;
    error.set("");
    try {
      current = await busy(button, fn);
      draw();
    } catch (e) {
      error.set(errorText(e));
    } finally {
      working = false;
    }
  }

  async function submit(button) {
    if (!c.text().trim()) {
      c.area.focus();
      return;
    }
    if (working) {
      return;
    }
    working = true;
    error.set("");
    try {
      current = await busy(button, () => source.reply(c.text(), c.files()), t`Отправляю…`);
      c.reset();
      draw();
    } catch (e) {
      error.set(errorText(e));
    } finally {
      working = false;
    }
  }

  c.area.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      box.querySelector(".desk-reply .btn.primary")?.click();
    }
  });

  // support's answer shows up by itself while the request is open and the tab is visible
  const watch = setInterval(async () => {
    if (working || document.hidden) {
      return;
    }
    try {
      const fresh = await source.load();
      if (JSON.stringify(fresh) !== JSON.stringify(current) && !working) {
        current = fresh;
        const typed = c.text();
        draw();
        c.area.value = typed;
      }
    } catch (e) {}
  }, WATCH_MS);

  draw();
  return {
    el: box,
    destroy() {
      clearInterval(watch);
      urls.forEach(u => URL.revokeObjectURL(u.url));
      c.reset();
    },
  };
}

/* ---- nobody is signed in ---- */

/**
 * @param {HTMLElement} root
 * @param {{ session: import("./session.js").DeskSession, api: import("../core/api.js").Api }} ctx
 */
export function mountHome(root, { session, api }) {
  const DOMAIN = session.domain;
  let name = "";

  /* sign in */
  const signPanel = h("section", { class: "desk-panel" });
  function login() {
    const user = field(t`Адрес`, { name: "username", autocomplete: "username", placeholder: t`имя`, value: name, inputmode: "email", suffix: h("span", { class: "input-suffix" }, `@${DOMAIN}`) });
    user.el.querySelector(".input-wrap").classList.add("has-text-suffix");
    // a whole address may be pasted: the domain is dropped, so that it is not name@tabora.app@tabora.app
    user.input.addEventListener("input", () => {
      const v = user.input.value;
      if (v.includes("@")) {
        const [n, dom] = v.split("@");
        if (!dom || DOMAIN.startsWith(dom.toLowerCase())) {
          user.input.value = n;
        }
      }
    });
    const pass = field(t`Пароль`, { type: "password", name: "password", autocomplete: "current-password" });
    const error = formError();
    const submit = h("button", { class: "btn primary block", type: "submit" }, t`Войти`);
    const form = h("form", { class: "desk-form", novalidate: true }, user.el, pass.el, error.el, submit);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      name = user.value.trim();
      if (!name || !pass.value) {
        error.set(!name ? t`Введите адрес` : t`Введите пароль`);
        (!name ? user : pass).input.focus();
        return;
      }
      try {
        await busy(submit, async step => {
          session.onStep = step;
          await session.signIn(name, pass.value);
        }, t`Входим`);
      } catch (err) {
        if (err.code === "2fa-required") {
          second();
          return;
        }
        error.set(err.code === "bad-credentials" ? t`Неверный адрес или пароль` : errorText(err));
        pass.input.select();
      } finally {
        session.onStep = null;
      }
    });
    clear(signPanel,
      h("h2", {}, t`С аккаунтом Tabora`),
      h("p", { class: "desk-sub" }, t`Все ваши обращения и ответы на них — в одном месте, как в браузере.`),
      form,
      h("p", { class: "desk-fine" }, h("a", { href: `https://app.${DOMAIN}/`, rel: "noopener" }, t`Забыли пароль?`), " ", t`Сбросить его можно в веб-версии почты.`));
  }

  function second() {
    const code = field(t`Код из приложения`, { name: "totp", autocomplete: "one-time-code", inputmode: "numeric", placeholder: "000 000", mono: true, autofocus: true });
    const error = formError();
    const submit = h("button", { class: "btn primary block", type: "submit" }, t`Подтвердить`);
    const form = h("form", { class: "desk-form", novalidate: true }, code.el, error.el, submit);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      if (!code.value.trim()) {
        error.set(t`Введите код`);
        return;
      }
      try {
        await busy(submit, async step => {
          session.onStep = step;
          await session.signIn(name, "", { totp: code.value.trim() });
        }, t`Проверяем`);
      } catch (err) {
        if (err.code === "bad-credentials") {
          toast(t`Время на ввод кода вышло: войдите заново`);
          login();
          return;
        }
        error.set(err.code === "bad-2fa" ? t`Код не подошёл. Проверьте время на телефоне и введите новый код` : errorText(err));
        code.input.select();
      } finally {
        session.onStep = null;
      }
    });
    clear(signPanel,
      h("h2", {}, t`Подтвердите вход`),
      h("p", { class: "desk-sub" }, t`Аккаунт ${name.includes("@") ? name : `${name}@${DOMAIN}`} защищён вторым шагом.`),
      form,
      h("p", { class: "desk-fine" }, h("button", { class: "link-btn", type: "button", onclick: login }, t`Назад`)));
    code.input.focus();
  }

  /* write without an account */
  const guestPanel = h("section", { class: "desk-panel" });
  function guestForm() {
    const email = field(t`Почта для ответа`, { type: "email", name: "email", autocomplete: "email", inputmode: "email", placeholder: "name@example.com", maxlength: 254 });
    const subject = field(t`Тема`, { name: "subject", maxlength: 140, placeholder: t`Что случилось, в двух словах` });
    const text = field(t`Сообщение`, { type: "textarea", name: "text", rows: 6, maxlength: 8000, spellcheck: true, placeholder: t`Что вы делали, что ожидали увидеть и что получилось.` });
    const error = formError();
    const submit = h("button", { class: "btn primary block", type: "submit" }, t`Отправить`);
    const form = h("form", { class: "desk-form", novalidate: true }, email.el, subject.el, text.el, error.el, submit);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      const address = email.value.trim();
      const problem = !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address) ? [email, t`Укажите почту, на которую придёт ответ`]
        : subject.value.trim().length < 3 ? [subject, t`Коротко назовите тему обращения`]
        : !text.value.trim() ? [text, t`Опишите, что случилось`] : null;
      if (problem) {
        error.set(problem[1]);
        problem[0].input.focus();
        return;
      }
      try {
        await busy(submit, () => api.supportGuestCreate({ email: address, subject: subject.value.trim(), text: text.value, lang: language() }), t`Отправляю…`);
        sent(address);
      } catch (err) {
        error.set(errorText(err));
      }
    });
    clear(guestPanel,
      h("h2", {}, t`Без аккаунта`),
      h("p", { class: "desk-sub" }, t`Если войти не получается или аккаунта ещё нет. Ответ придёт на почту, которую вы укажете.`),
      form);
  }

  function sent(address) {
    clear(guestPanel,
      h("div", { class: "desk-sent", role: "status" },
        h("span", { class: "desk-sent-icon" }, icon("mail", 22)),
        h("h2", {}, t`Проверьте почту`),
        h("p", {}, t`Мы отправили письмо на ${address}. Откройте ссылку из него: только после этого обращение дойдёт до поддержки. По этой же ссылке придёт ответ.`),
        h("p", { class: "desk-fine" }, t`Письма нет? Загляните в папку «Спам».`),
        h("button", { class: "btn small", type: "button", onclick: guestForm }, t`Написать ещё`)));
  }

  login();
  guestForm();
  clear(root, pageOf(topBar(),
    h("div", { class: "desk-hero" },
      h("h1", {}, t`Чем помочь?`),
      h("p", {}, t`Расскажите, что случилось или чего не хватает. Ответим здесь и письмом.`)),
    h("div", { class: "desk-panels" }, signPanel, guestPanel),
    h("p", { class: "desk-privacy" }, icon("info", 16), h("span", {}, privacyNote()))));
  return { destroy() { clear(root); } };
}

/* ---- signed in ---- */

/**
 * @param {HTMLElement} root
 * @param {{ session: import("./session.js").DeskSession, api: import("../core/api.js").Api }} ctx
 */
export function mountDesk(root, { session, api }) {
  const main = h("div", { class: "desk-body" });
  let scope = "mine";
  let staff = false;
  let open = null; // the request that is shown now: { destroy() }
  let seq = 0;
  const token = () => session.token;

  const go = path => {
    const target = `#/${path}`;
    if (location.hash === target) {
      route();
    } else {
      location.hash = target;
    }
  };

  function leave() {
    open?.destroy();
    open = null;
  }

  async function list() {
    leave();
    const mySeq = ++seq;
    const rows = h("div", { class: "desk-list", "aria-busy": "true" }, h("p", { class: "desk-empty" }, h("span", { class: "spinner", "aria-hidden": "true" }), t`Загружаю обращения…`));
    // the queue is other people's requests: one's own are written from "My requests"
    const create = scope === "all" ? null : h("button", { class: "btn primary", type: "button", onclick: () => go("new") }, icon("plus", 16), t`Новое обращение`);
    const tabs = h("div", { class: "desk-scope", role: "tablist", "aria-label": t`Какие обращения показывать`, hidden: !staff });
    const drawTabs = () => {
      tabs.hidden = !staff;
      clear(tabs, [["mine", t`Мои обращения`], ["all", t`Очередь поддержки`]].map(([id, label]) =>
        h("button", { type: "button", role: "tab", "aria-selected": String(scope === id), onclick: () => { if (scope !== id) { scope = id; list(); } } }, label)));
    };
    drawTabs();
    clear(main,
      h("div", { class: "desk-head" }, h("h1", {}, scope === "all" ? t`Очередь поддержки` : t`Обращения`), create),
      tabs,
      h("p", { class: "desk-sub" }, scope === "all" ? t`Обращения всех пользователей: сначала те, что изменились последними.` : privacyNote()),
      rows);
    try {
      const r = await api.supportTickets(token(), { scope });
      if (mySeq !== seq) {
        return;
      }
      staff = !!r.staff;
      if (!staff && scope === "all") {
        scope = "mine";
        list();
        return;
      }
      drawTabs();
      rows.removeAttribute("aria-busy");
      const staffView = scope === "all";
      const items = r.tickets || [];
      if (!items.length) {
        clear(rows, h("div", { class: "desk-empty" },
          h("b", {}, staffView ? t`Очередь пуста` : t`Обращений пока нет`),
          h("span", {}, staffView ? t`Новых обращений нет.` : t`Что-то не работает или есть идея? Напишите — ответим здесь же.`)));
        return;
      }
      clear(rows, items.map(tk => h("button", { class: `desk-row${tk.unread ? " unread" : ""}`, type: "button", onclick: () => go(`ticket/${tk.id}`) },
        h("span", { class: "desk-row-main" },
          h("b", {}, tk.unread && h("i", { class: "desk-dot", "aria-label": t`есть новое` }), tk.subject),
          h("span", { class: "desk-row-meta" },
            h("span", { class: "desk-number" }, `№ ${tk.id}`),
            statusChip(tk.status, staffView),
            staffView && tk.author ? h("span", {}, tk.author, tk.guest ? ` (${t`без аккаунта`})` : "") : null)),
        h("time", { datetime: tk.updatedAt, title: when(tk.updatedAt) }, shortDate(tk.updatedAt)))));
    } catch (e) {
      if (mySeq === seq) {
        rows.removeAttribute("aria-busy");
        clear(rows, h("div", { class: "desk-empty" }, h("b", {}, t`Обращения не загрузились`), h("span", {}, errorText(e)), h("button", { class: "btn small", type: "button", onclick: list }, t`Повторить`)));
      }
    }
  }

  function create() {
    leave();
    ++seq;
    const subject = field(t`Тема`, { name: "subject", maxlength: 140, placeholder: t`Что случилось, в двух словах`, autofocus: true });
    const c = composer({ placeholder: t`Что вы делали, что ожидали увидеть и что получилось. Снимок экрана можно вставить из буфера.`, rows: 8 });
    const meta = h("input", { type: "checkbox", checked: true });
    const error = formError();
    const send = h("button", { class: "btn primary", type: "button" }, t`Отправить`);
    send.addEventListener("click", async () => {
      error.set("");
      if (subject.value.trim().length < 3 || !c.text().trim()) {
        error.set(subject.value.trim().length < 3 ? t`Коротко назовите тему обращения` : t`Опишите, что случилось`);
        (subject.value.trim().length < 3 ? subject.input : c.area).focus();
        return;
      }
      try {
        const made = await busy(send, () => api.supportCreate(token(), { subject: subject.value.trim(), text: c.text(), meta: meta.checked ? browserInfo() : null, files: c.files() }), t`Отправляю…`);
        c.reset();
        toast(t`Обращение № ${made.id} отправлено`);
        go(`ticket/${made.id}`);
      } catch (e) {
        error.set(errorText(e));
      }
    });
    clear(main,
      h("button", { class: "btn small ghost desk-back", type: "button", onclick: () => go("") }, icon("back", 15), t`Все обращения`),
      h("div", { class: "desk-head" }, h("h1", {}, t`Новое обращение`)),
      h("p", { class: "desk-sub" }, privacyNote()),
      h("div", { class: "desk-form wide" },
        subject.el,
        c.el,
        h("label", { class: "check" }, meta, h("span", {}, t`Приложить сведения о браузере`, h("small", {}, t`Название браузера, система, язык и размер окна. Помогают повторить проблему.`))),
        error.el,
        h("div", { class: "desk-buttons" }, send, c.pick, h("button", { class: "btn ghost", type: "button", onclick: () => go("") }, t`Отмена`))));
    subject.input.focus();
  }

  async function show(id) {
    leave();
    const mySeq = ++seq;
    clear(main, h("p", { class: "desk-empty" }, h("span", { class: "spinner", "aria-hidden": "true" }), t`Загружаю обращения…`));
    try {
      const tk = await api.supportTicket(token(), id);
      if (mySeq !== seq) {
        return;
      }
      open = ticketView(tk, {
        files: true,
        back: () => go(""),
        load: () => api.supportTicket(token(), id),
        reply: (text, files) => api.supportReply(token(), id, { text, files }),
        status: next => api.supportStatus(token(), id, next),
        file: fileId => api.supportFile(token(), fileId),
      });
      clear(main, open.el);
    } catch (e) {
      if (mySeq === seq) {
        clear(main, h("div", { class: "desk-empty" }, h("b", {}, e.status === 404 ? t`Обращение не найдено` : t`Обращения не загрузились`), h("span", {}, e.status === 404 ? "" : errorText(e)),
          h("button", { class: "btn small", type: "button", onclick: () => go("") }, t`Все обращения`)));
      }
    }
  }

  function route() {
    if (!session.signedIn) {
      return;
    }
    const path = location.hash.replace(/^#\/?/, "");
    const ticket = /^ticket\/(\d{1,15})$/.exec(path);
    if (ticket) {
      show(Number(ticket[1]));
    } else if (path === "new") {
      create();
    } else {
      list();
    }
  }

  clear(root, pageOf(topBar({ session, onHome: () => go("") }), main));
  window.addEventListener("hashchange", route);
  route();
  return {
    destroy() {
      window.removeEventListener("hashchange", route);
      leave();
      ++seq;
      clear(root);
    },
  };
}

/** What the page can say about the browser it runs in; sent only if the person left the box checked. */
function browserInfo() {
  const ua = navigator.userAgent;
  const pick = re => (re.exec(ua) || [])[0] || "";
  return {
    site: "support",
    browser: (pick(/Tabora\/[\d.]+/) || pick(/Edg\/[\d.]+/) || pick(/OPR\/[\d.]+/) || pick(/Firefox\/[\d.]+/) || pick(/Chrome\/[\d.]+/) || pick(/Version\/[\d.]+ .*Safari/) || "").slice(0, 60),
    system: (/\(([^)]{1,80})\)/.exec(ua) || [])[1] || "",
    locale: navigator.language || "",
    window: `${window.innerWidth}×${window.innerHeight}`,
  };
}

/* ---- a request without an account, by the link from the letter ---- */

/**
 * @param {HTMLElement} root
 * @param {{ api: import("../core/api.js").Api, session: import("./session.js").DeskSession, home(): void }} ctx
 * @param {string} key "<number>.<secret>" from the link
 */
export function mountGuest(root, { api, session, home }, key) {
  const main = h("div", { class: "desk-body" }, h("p", { class: "desk-empty" }, h("span", { class: "spinner", "aria-hidden": "true" }), t`Загружаю обращения…`));
  let view = null;
  let gone = false;
  clear(root, pageOf(topBar({ session: session.signedIn ? session : null, onHome: home }), main));
  (async () => {
    try {
      const tk = await api.supportGuestOpen(key);
      if (gone) {
        return;
      }
      view = ticketView(tk, {
        files: false,
        note: t`Эта страница открывается только по ссылке из письма: сохраните письмо, чтобы вернуться к обращению. Ответ поддержки придёт на тот же адрес.` + " " + privacyNote(),
        load: () => api.supportGuestOpen(key),
        reply: text => api.supportGuestReply(key, text),
        status: next => api.supportGuestStatus(key, next),
        file: id => api.supportGuestFile(key, id),
      });
      clear(main, view.el);
    } catch (e) {
      if (!gone) {
        clear(main, h("div", { class: "desk-empty" },
          h("b", {}, e.status === 404 ? t`Обращение не найдено` : t`Обращения не загрузились`),
          h("span", {}, e.status === 404 ? t`Ссылка устарела или скопирована не целиком. Откройте её из письма ещё раз или напишите нам заново.` : errorText(e)),
          h("button", { class: "btn small", type: "button", onclick: home }, t`На главную`)));
      }
    }
  })();
  return {
    destroy() {
      gone = true;
      view?.destroy();
      clear(root);
    },
  };
}
