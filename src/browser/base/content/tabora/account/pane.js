/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Раздел «Аккаунт» на странице настроек (about:preferences#sync). Занимает место раздела
 * Firefox «Аккаунт и синхронизация»: его группы скрыты (preferences.css), а сюда встаёт
 * профиль аккаунта Tabora с горизонтальными вкладками.
 *
 * Группы и строки собраны из тех же компонентов, что остальные настройки (moz-card,
 * moz-fieldset, moz-box-group, moz-box-item, moz-button, moz-toggle), поэтому раздел выглядит
 * так же, как соседние. Чувствительные действия раздел сам не выполняет: смена пароля,
 * проверка владельца, ключ восстановления, импорт и экспорт паролей — окна и листы оболочки
 * (Tabora.accountDialog, vaultOwnerCheck, vaultRecoveryCreateSheet). То, чему нужен сервер
 * аккаунтов, так и подписано, пока он не запущен. Вкладка «Аккаунты» — остальные аккаунты
 * этого компьютера: у каждого свой профиль браузера (account/Profiles.sys.mjs).
 *
 * Подключается из preferences.js. Разметка строится через DOM, стили — preferences.css. */

"use strict";

window.TaboraAccountPane = (function () {
  const { Account } = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
  const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
  const { Profiles } = ChromeUtils.importESModule("chrome://tabora/content/account/Profiles.sys.mjs");
  const { Sync } = ChromeUtils.importESModule("chrome://tabora/content/sync/Sync.sys.mjs");
  const Shell = window.browsingContext?.topChromeWindow?.Tabora || null;
  const HTML = "http://www.w3.org/1999/xhtml";
  const LATER = "появится в одной из следующих версий";

  const TABS = [
    ["profile", "Профиль"],
    ["security", "Безопасность"],
    ["sync", "Синхронизация"],
    ["data", "Данные"],
    ["accounts", "Аккаунты"],
    ["support", "Поддержка"],
    ["exit", "Выход"],
  ];

  // security: настройки входа с сервера (null — ещё не загружены, { error } — сервер не ответил)
  const state = { tab: "profile", root: null, pane: null, devices: null, devicesFor: "", profiles: null, security: null, timer: null };

  /* ---- Помощники разметки -------------------------------------------------- */

  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS(HTML, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined && v !== false) {
        node.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of [].concat(children)) {
      if (c !== null && c !== undefined && c !== false) {
        node.append(c);
      }
    }
    return node;
  }

  function button(label, onClick, { type = "default", disabled = false } = {}) {
    const b = el("moz-button", { label, type: type === "default" ? null : type, slot: "actions" });
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function value(text, muted = false) {
    return el("span", { class: `tabora-acc-value${muted ? " muted" : ""}`, slot: "actions" }, text);
  }

  /** Строка: название и пояснение слева, справа кнопки, переключатель или значение. */
  function item(label, description, actions = []) {
    return el("moz-box-item", { label, description: description || null }, actions);
  }

  /** Группа настроек: та же обёртка, что рисует setting-group у остальных разделов. */
  function group(label, description, items) {
    return el("moz-card", { role: "presentation", class: "tabora-acc-group" }, [
      el("moz-fieldset", { label, description: description || null, headinglevel: "2" }, [el("moz-box-group", { type: "list" }, items.filter(Boolean))]),
    ]);
  }

  function date(v) {
    // без хвоста «г.»: дата стоит в середине фраз
    return v ? new Date(v).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }).replace(/\s*г\.$/, "") : "";
  }

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  }

  /** Действие оболочки; если страницу открыли вне окна браузера, ничего не делаем. */
  const shell = fn => () => Shell && fn(Shell);


  /* ---- Поддержка: обращения ---------------------------------------------------------------
   * Своя переписка с поддержкой вместо внешнего трекера. Обращения хранит сервер аккаунтов
   * (server/src/support.rs); читает их поддержка, поэтому это не сквозное шифрование — так и
   * написано над формой. Сотрудник поддержки (его аккаунт назван в настройках сервера) видит
   * здесь же очередь всех обращений. */

  const SUP_FILE_MAX = 2 * 1024 * 1024;
  const SUP_FILES_MAX = 4;
  const SUP_TYPES = ["image/png", "image/jpeg", "image/webp", "text/plain"];
  const sup = {
    view: "list", scope: "mine", list: null, staff: false, error: "", unsupported: false, ticket: null, busy: false, loading: false,
    draft: { subject: "", text: "", meta: true, files: [] }, reply: { text: "", files: [] }, images: new Map(), timer: null,
  };

  const supStatus = (status, staffView) => ({
    open: staffView ? "ждёт ответа" : "ждёт ответа поддержки",
    answered: staffView ? "отвечено" : "поддержка ответила",
    closed: "закрыто",
  }[status] || status);

  const supWhen = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  };

  function supFail(e) {
    if (e.status === 404 && e.code !== "not-found-ticket" && !sup.ticket) {
      sup.unsupported = true; // сервер ещё не знает об обращениях
      return "";
    }
    return e.code === "no-server" ? "Обращения появятся, когда аккаунт подключат к серверу Tabora." : e.message || String(e);
  }

  async function supLoadList() {
    if (sup.loading) {
      return;
    }
    sup.loading = true;
    try {
      const r = await Account.supportTickets({ scope: sup.scope });
      sup.list = Array.isArray(r.tickets) ? r.tickets : [];
      sup.staff = !!r.staff;
      sup.error = "";
      sup.unsupported = false;
    } catch (e) {
      sup.error = supFail(e);
      sup.list ||= [];
    }
    sup.loading = false;
    Shell?.supportPoll?.();
    if (state.tab === "support" && sup.view === "list") {
      render();
    }
  }

  async function supOpen(id, { quiet = false } = {}) {
    try {
      const t = await Account.supportTicket(id);
      const changed = !sup.ticket || sup.ticket.id !== t.id || JSON.stringify(sup.ticket) !== JSON.stringify(t);
      if (!quiet) {
        sup.reply = { text: "", files: [] };
        sup.view = "ticket";
      }
      sup.ticket = t;
      sup.error = "";
      if ((changed || !quiet) && state.tab === "support" && sup.view === "ticket") {
        render();
      }
      Shell?.supportPoll?.();
    } catch (e) {
      if (!quiet) {
        sup.error = e.message || String(e);
        render();
      }
    }
  }

  /** Открытая переписка обновляется сама: ответ поддержки появляется без перезагрузки. */
  function supWatch() {
    clearInterval(sup.timer);
    sup.timer = setInterval(() => {
      if (state.tab === "support" && sup.view === "ticket" && sup.ticket && !sup.busy && !document.hidden && Account.signedIn) {
        supOpen(sup.ticket.id, { quiet: true });
      } else if (state.tab !== "support") {
        clearInterval(sup.timer);
      }
    }, 30000);
  }

  /** Большой снимок экрана ужимается до предела сервера, а не отвергается. */
  async function supFit(file) {
    if (file.size <= SUP_FILE_MAX || !/^image\//.test(file.type)) {
      return file;
    }
    const bmp = await createImageBitmap(file);
    let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    for (let i = 0; i < 5; i++) {
      const canvas = document.createElementNS(HTML, "canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (blob && blob.size <= SUP_FILE_MAX) {
        return new File([blob], `${file.name.replace(/\.[a-z0-9]+$/i, "") || "снимок"}.jpg`, { type: "image/jpeg" });
      }
      scale *= 0.7;
    }
    throw new Error(`«${file.name}» не удалось уменьшить до 2 МБ`);
  }

  async function supAttach(target, files) {
    for (const raw of files) {
      if (target.files.length >= SUP_FILES_MAX) {
        shell(s => s.notice(`К сообщению можно приложить не больше ${SUP_FILES_MAX} файлов`))();
        break;
      }
      try {
        if (!SUP_TYPES.includes(raw.type)) {
          throw new Error(`«${raw.name}»: прикладывать можно снимки (PNG, JPEG, WebP) и текстовые файлы`);
        }
        const file = await supFit(raw);
        if (file.size > SUP_FILE_MAX) {
          throw new Error(`«${file.name}» больше 2 МБ`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        target.files.push({ name: file.name || "снимок.png", type: file.type, size: file.size, data: bytes.toBase64(), url: /^image\//.test(file.type) ? URL.createObjectURL(file) : "" });
      } catch (e) {
        shell(s => s.notice(e.message || String(e)))();
      }
    }
    render();
  }

  const supSize = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace(".", ",")} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

  /** Поле сообщения с вложениями: кнопка выбора файлов, вставка снимка из буфера, список приложенного. */
  function supComposer(target, { placeholder, rows }) {
    const area = el("textarea", { class: "tabora-sup-area", rows: String(rows), maxlength: "8000", placeholder, "aria-label": placeholder });
    area.value = target.text;
    area.addEventListener("input", () => {
      target.text = area.value;
    });
    area.addEventListener("paste", e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        supAttach(target, files);
      }
    });
    const input = el("input", { type: "file", multiple: true, accept: SUP_TYPES.join(","), hidden: true });
    input.addEventListener("change", () => supAttach(target, [...input.files]));
    const pick = el("moz-button", { label: "Прикрепить файл" });
    pick.addEventListener("click", () => input.click());
    const list = el("div", { class: "tabora-sup-attached" }, target.files.map((f, i) => {
      const remove = el("button", { class: "tabora-sup-remove", type: "button", "aria-label": `Убрать ${f.name}`, title: "Убрать" }, "×");
      remove.addEventListener("click", () => {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
        target.files.splice(i, 1);
        render();
      });
      return el("span", { class: "tabora-sup-chip" }, [f.url ? el("img", { src: f.url, alt: "" }) : null, el("span", {}, `${f.name}, ${supSize(f.size)}`), remove]);
    }));
    return { area, node: el("div", { class: "tabora-sup-composer" }, [area, list, input]), pick };
  }

  function supMeta() {
    try {
      const os = Services.sysinfo;
      return {
        browser: `Tabora ${Services.prefs.getStringPref("tabora.version", "") || Services.appinfo.version}`.trim(),
        engine: Services.appinfo.version,
        system: `${os.getProperty("name")} ${os.getProperty("version")}`.slice(0, 80),
        arch: Services.appinfo.XPCOMABI.split("-")[0],
        locale: Services.locale.appLocaleAsBCP47,
        window: `${window.browsingContext.topChromeWindow.innerWidth}×${window.browsingContext.topChromeWindow.innerHeight}`,
      };
    } catch (e) {
      return null;
    }
  }

  const supWire = files => files.map(f => ({ name: f.name, type: f.type, data: f.data }));

  async function supCreate() {
    const d = sup.draft;
    if (sup.busy) {
      return;
    }
    if (d.subject.trim().length < 3 || !d.text.trim()) {
      shell(s => s.notice(d.subject.trim().length < 3 ? "Коротко назовите тему обращения" : "Опишите, что случилось"))();
      return;
    }
    sup.busy = true;
    render();
    try {
      const t = await Account.supportCreate({ subject: d.subject.trim(), text: d.text, meta: d.meta ? supMeta() : null, files: supWire(d.files) });
      d.files.forEach(f => f.url && URL.revokeObjectURL(f.url));
      sup.draft = { subject: "", text: "", meta: true, files: [] };
      sup.ticket = t;
      sup.reply = { text: "", files: [] };
      sup.view = "ticket";
      sup.list = null;
      shell(s => s.notice(`Обращение № ${t.id} отправлено`))();
    } catch (e) {
      shell(s => s.notice(e.message || String(e)))();
    }
    sup.busy = false;
    render();
  }

  async function supSendReply() {
    const r = sup.reply;
    if (sup.busy || !sup.ticket || !r.text.trim()) {
      return;
    }
    sup.busy = true;
    render();
    try {
      sup.ticket = await Account.supportReply(sup.ticket.id, { text: r.text, files: supWire(r.files) });
      r.files.forEach(f => f.url && URL.revokeObjectURL(f.url));
      sup.reply = { text: "", files: [] };
      sup.list = null;
    } catch (e) {
      shell(s => s.notice(e.message || String(e)))();
    }
    sup.busy = false;
    render();
  }

  async function supSetStatus(status) {
    if (sup.busy || !sup.ticket) {
      return;
    }
    sup.busy = true;
    try {
      sup.ticket = await Account.supportStatus(sup.ticket.id, status);
      sup.list = null;
    } catch (e) {
      shell(s => s.notice(e.message || String(e)))();
    }
    sup.busy = false;
    render();
  }

  /** Вложение сообщения: снимок показывается картинкой, текстовый файл сохраняется по нажатию. */
  function supFile(f) {
    const isImage = /^image\/(png|jpeg|webp)$/.test(f.type);
    const load = async () => {
      if (!sup.images.has(f.id)) {
        const { bytes, type } = await Account.supportFile(f.id);
        // тип берётся из ответа сервера: в картинку попадает только то, что сервер назвал картинкой
        sup.images.set(f.id, { url: URL.createObjectURL(new Blob([bytes], { type: SUP_TYPES.includes(type) ? type : "application/octet-stream" })), type });
      }
      return sup.images.get(f.id);
    };
    if (isImage) {
      const img = el("img", { class: "tabora-sup-image", alt: f.name, title: `${f.name}, ${supSize(f.size)}` });
      load().then(got => {
        if (/^image\/(png|jpeg|webp)$/.test(got.type)) {
          img.src = got.url;
        }
      }).catch(() => img.replaceWith(el("span", { class: "tabora-sup-chip" }, `${f.name}: не загрузилось`)));
      img.addEventListener("click", () => img.classList.toggle("wide"));
      return img;
    }
    const link = el("button", { class: "tabora-sup-chip link", type: "button", title: "Сохранить файл" }, `${f.name}, ${supSize(f.size)}`);
    link.addEventListener("click", async () => {
      try {
        const got = await load();
        const a = el("a", { href: got.url, download: f.name });
        document.body.append(a);
        a.click();
        a.remove();
      } catch (e) {
        shell(s => s.notice(e.message || String(e)))();
      }
    });
    return link;
  }

  function supportPanel() {
    if (sup.unsupported) {
      return [group("Поддержка", "", [item("Обращения из браузера скоро заработают", "Сервер Tabora ещё не обновлён. Пока напишите нам на hello@tabora.app — ответим письмом.", [button("Проверить снова", () => {
        sup.unsupported = false;
        sup.list = null;
        render();
      })])])];
    }
    const head = "Напишите нам о проблеме или идее — ответим здесь же. Переписку читают сотрудники поддержки Tabora: она не зашифрована от них, поэтому не присылайте пароли, коды и фразу восстановления кошелька.";

    if (sup.view === "new") {
      const d = sup.draft;
      const subject = el("input", { class: "tabora-sup-input", type: "text", maxlength: "140", placeholder: "Тема: что случилось, в двух словах", "aria-label": "Тема обращения" });
      subject.value = d.subject;
      subject.addEventListener("input", () => {
        d.subject = subject.value;
      });
      const c = supComposer(d, { placeholder: "Что вы делали, что ожидали увидеть и что получилось. Снимок экрана можно вставить из буфера.", rows: 8 });
      const meta = el("moz-checkbox", { label: "Приложить сведения о браузере", description: "Версия Tabora, система, язык и размер окна. Помогают повторить проблему." });
      meta.checked = d.meta;
      meta.addEventListener("change", () => {
        d.meta = meta.checked;
      });
      const send = el("moz-button", { label: sup.busy ? "Отправляю…" : "Отправить", type: "primary" });
      send.disabled = sup.busy;
      send.addEventListener("click", supCreate);
      const cancel = el("moz-button", { label: "Отмена" });
      cancel.addEventListener("click", () => {
        sup.view = "list";
        render();
      });
      queueMicrotask(() => !d.subject && subject.focus());
      return [el("moz-card", { role: "presentation", class: "tabora-acc-group tabora-sup-card" }, [
        el("moz-fieldset", { label: "Новое обращение", description: head, headinglevel: "2" }, [
          el("div", { class: "tabora-sup-form" }, [subject, c.node, meta, el("div", { class: "tabora-sup-buttons" }, [send, c.pick, cancel])]),
        ]),
      ])];
    }

    if (sup.view === "ticket" && sup.ticket) {
      const t = sup.ticket;
      const staffView = !!t.staff;
      const back = el("moz-button", { label: "Все обращения" });
      back.addEventListener("click", () => {
        sup.view = "list";
        sup.ticket = null;
        render();
      });
      const toggle = el("moz-button", { label: t.status === "closed" ? "Открыть снова" : "Закрыть обращение" });
      toggle.disabled = sup.busy;
      toggle.addEventListener("click", () => supSetStatus(t.status === "closed" ? "open" : "closed"));
      const thread = el("div", { class: "tabora-sup-thread", role: "log", "aria-label": "Переписка" }, (t.messages || []).map(m => {
        const mine = m.from === (staffView ? "staff" : "user");
        const who = mine ? "Вы" : m.from === "staff" ? "Поддержка Tabora" : t.author || "Автор обращения";
        return el("div", { class: `tabora-sup-msg${mine ? " mine" : ""}` }, [
          el("div", { class: "tabora-sup-meta" }, [el("b", {}, who), el("time", {}, supWhen(m.at))]),
          el("div", { class: "tabora-sup-text" }, m.text),
          (m.files || []).length ? el("div", { class: "tabora-sup-files" }, m.files.map(supFile)) : null,
        ]);
      }));
      const c = supComposer(sup.reply, { placeholder: t.status === "closed" ? "Сообщение откроет обращение снова" : "Ваш ответ", rows: 3 });
      const send = el("moz-button", { label: sup.busy ? "Отправляю…" : "Ответить", type: "primary" });
      send.disabled = sup.busy;
      send.addEventListener("click", supSendReply);
      c.area.addEventListener("keydown", e => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          supSendReply();
        }
      });
      const info = staffView && t.meta ? el("div", { class: "tabora-sup-info" }, Object.entries(t.meta).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`).join(" · ")) : null;
      supWatch();
      queueMicrotask(() => {
        thread.scrollTop = thread.scrollHeight;
      });
      return [el("moz-card", { role: "presentation", class: "tabora-acc-group tabora-sup-card" }, [
        el("moz-fieldset", { label: t.subject, description: `Обращение № ${t.id} · ${supStatus(t.status, staffView)}${staffView && t.author ? ` · ${t.author}` : ""}`, headinglevel: "2" }, [
          el("div", { class: "tabora-sup-form" }, [el("div", { class: "tabora-sup-buttons" }, [back, toggle]), info, thread, c.node, el("div", { class: "tabora-sup-buttons" }, [send, c.pick])]),
        ]),
      ])];
    }

    // список
    if (sup.list === null) {
      supLoadList();
    }
    const create = button("Новое обращение", () => {
      sup.view = "new";
      render();
    }, { type: "primary" });
    const list = sup.list || [];
    const row = t => {
      const staffView = sup.scope === "all" && sup.staff;
      const b = button("Открыть", () => supOpen(t.id), { type: t.unread ? "primary" : "default" });
      return item(
        `${t.unread ? "● " : ""}${t.subject}`,
        `№ ${t.id} · ${supStatus(t.status, staffView)}${staffView && t.author ? ` · ${t.author}` : ""} · ${supWhen(t.updatedAt)}`,
        [b]
      );
    };
    const scope = sup.staff
      ? (() => {
          const seg = el("div", { class: "tabora-acc-tabs tabora-sup-scope", role: "tablist", "aria-label": "Какие обращения показывать" }, [["mine", "Мои обращения"], ["all", "Очередь поддержки"]].map(([id, label]) => {
            const b = el("button", { class: "tabora-acc-tab", type: "button", role: "tab", "aria-selected": String(sup.scope === id) }, label);
            b.addEventListener("click", () => {
              sup.scope = id;
              sup.list = null;
              render();
            });
            return b;
          }));
          return seg;
        })()
      : null;
    return [
      scope,
      group(sup.scope === "all" && sup.staff ? "Очередь поддержки" : "Поддержка", sup.scope === "all" && sup.staff ? "Обращения всех пользователей: сначала те, что изменились последними." : head, [
        sup.scope === "all" && sup.staff ? null : item("Что-то не работает или есть идея?", "Опишите, приложите снимок экрана — и следите за ответом здесь.", [create]),
        sup.error ? item("Обращения не загрузились", sup.error, [button("Повторить", () => {
          sup.list = null;
          render();
        })]) : null,
        ...(sup.list === null && !sup.error ? [item("Загружаю обращения…", "")] : list.map(row)),
        sup.list && !list.length && !sup.error && sup.scope === "all" ? item("Очередь пуста", "Новых обращений нет.") : null,
      ]),
    ];
  }

  /* ---- Вкладки ------------------------------------------------------------- */

  const PANELS = {
    support() {
      return supportPanel();
    },

    profile() {
      const colors = Shell?.AVATAR_COLORS || [];
      const current = Shell?.accountAvatarColor();
      const names = { "#c8f25a": "лаймовый", "#7cc4ff": "голубой", "#b9a6ff": "сиреневый", "#ff9f5a": "оранжевый", "#5ee0d0": "бирюзовый", "#ff8fb3": "розовый" };
      const swatches = el("div", { class: "tabora-acc-swatches", role: "radiogroup", "aria-label": "Цвет аватара", slot: "actions" }, colors.map(color => {
        const b = el("button", { class: "tabora-acc-swatch", type: "button", role: "radio", "aria-checked": String(color === current), "aria-label": names[color] || color, title: names[color] || color });
        b.style.setProperty("--avatar", color);
        b.addEventListener("click", () => {
          Services.prefs.setStringPref(Shell.AVATAR_PREF, color);
          Shell.renderAccountButton();
          render();
        });
        return b;
      }));
      let aliases = 0;
      try {
        aliases = Shell?.mail().MailStore.aliases?.length || 0;
      } catch (e) {}
      const link = Account.needsServerLink;
      const mailbox = Account.isLocalMode
        ? "Ящик заработает, когда аккаунт подключат к серверу Tabora."
        : link
          ? "Ящик заработает после подключения аккаунта к серверу."
          : `Письма на ${Account.email} приходят на сервер Tabora и открываются в разделе «Почта».`;
      return [
        link
          ? group("Сервер Tabora", "", [
              item("Аккаунт не подключён к серверу", "Он создан на этом компьютере. Подключите его, чтобы заработали почта на этом адресе и вход с других компьютеров. Понадобится пароль аккаунта.", [
                button("Подключить", shell(s => s.accountDialog("link")), { type: "primary" }),
              ]),
            ])
          : null,
        group("Адрес и вид", "Аккаунт Tabora — это адрес почты и один пароль для входа и для сейфа.", [
          item("Адрес почты", Account.email, [button("Скопировать", shell(s => {
            Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(Account.email);
            s.notice("Адрес скопирован");
          }))]),
          item("Цвет аватара", "Кружок с первой буквой адреса виден в правом верхнем углу окна и в почте.", [swatches]),
          Account.data?.createdAt ? item("Аккаунт создан", "", [value(date(Account.data.createdAt))]) : null,
          Account.data?.lastLoginAt ? item("Последний вход на этом компьютере", "", [value(date(Account.data.lastLoginAt))]) : null,
        ]),
        group("Почта", "Адрес аккаунта — это и почтовый ящик. Для сайтов браузер создаёт отдельные адреса-алиасы, чтобы основной адрес никто не знал.", [
          item("Почтовый ящик", mailbox, [button("Открыть почту", shell(s => s.openMail()))]),
          item("Алиасы", aliases ? `${aliases} ${plural(aliases, "адрес", "адреса", "адресов")} для сайтов. Выключенный алиас перестаёт принимать письма.` : "Пока нет. Алиас создаётся при регистрации на сайте.", [button("Открыть алиасы", shell(s => s.openMail("aliases")))]),
        ]),
      ].filter(Boolean);
    },

    security() {
      const rkAt = Vault.recoveryKeyCreatedAt;
      const offServer = !!rkAt && !!Account.data?.recoveryOffServer;
      const upgrade = !!rkAt && (Account.recoveryNeedsUpgrade || offServer);
      const silent = Vault.hasOsKey && Vault.osUnlockEnabled;
      const unlockTitle = Vault.osUnlockEnabled ? "Спрашивать пароль при запуске" : "Открывать сейф через связку ключей";
      const toggle = el("moz-toggle", { slot: "actions", "aria-label": "Открывать сейф через связку ключей macOS" });
      toggle.pressed = !!silent;
      toggle.disabled = !Vault.hasPassword;
      toggle.addEventListener("toggle", () => {
        // состояние меняется только после проверки владельца: до неё переключатель возвращается
        toggle.pressed = !!silent;
        shell(s => s.vaultOwnerCheck(unlockTitle, async () => {
          await Vault.setOsUnlock(!Vault.osUnlockEnabled);
          s.notice(Vault.osUnlockEnabled ? "Сейф снова открывается сам через связку ключей" : "Сейф будет спрашивать пароль при запуске");
          render();
        }))();
      });
      return [
        signInGroup(),
        group("Пароль и восстановление", "Пароли сайтов, коды входа и почта на этом компьютере зашифрованы ключом сейфа. Открыть его можно паролем аккаунта или ключом восстановления.", [
          item("Пароль", "Один для входа в аккаунт и для сейфа. Меняются всегда вместе.", [button("Сменить пароль", shell(s => s.accountDialog("change")))]),
          item(
            "Ключ восстановления",
            !rkAt
              ? "Не создан. Если забудете пароль, сейф открыть будет нечем."
              : offServer
                ? `Создан ${date(rkAt)}, до подключения к серверу: сейф он откроет, но сбросить им забытый пароль аккаунта нельзя. Создайте новый.`
                : upgrade
                  ? `Создан ${date(rkAt)}, но защищён по прежней схеме. Создайте новый: тогда сервер будет хранить только открытый ключ.`
                  : `Создан ${date(rkAt)}. Откроет сейф, если вы забудете пароль.`,
            [button(rkAt ? "Создать новый" : "Создать ключ", shell(s => s.vaultRecoveryCreateSheet()), { type: !rkAt || upgrade ? "primary" : "default" })]
          ),
        ]),
        group("Сейф", "", [
          item("Открывать сейф через связку ключей macOS", silent ? "Сейф открывается сам при запуске браузера на этом компьютере." : "При каждом запуске браузер спрашивает пароль.", [toggle]),
          item("Состояние", Vault.unlocked ? "Сейф открыт: пароли и коды подставляются на сайтах." : "Сейф заблокирован: пароли и коды закрыты до проверки.", [
            Vault.unlocked ? button("Заблокировать", shell(s => s.accountLockVault())) : button("Разблокировать", shell(s => s.vaultUnlockByUser()), { type: "primary" }),
          ]),
        ]),
      ];
    },

    sync() {
      const local = Account.isLocalMode;
      const here = Account.deviceId();
      const list = state.devices || [];
      const devices = list.length
        ? list.map(dev => item(dev.name || "Устройство", dev.id === here ? "Этот компьютер" : "", [value(dev.at ? `вход ${date(dev.at)}` : "")]))
        : [item(Account.deviceName(), "Этот компьютер")];
      const offline = local || Account.needsServerLink;
      const st = Sync.status();
      const on = st.enabled && !offline;
      const when = st.at ? new Date(st.at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
      // что сейчас происходит и что с этим можно сделать
      const now = offline
        ? ["Аккаунт есть только на этом компьютере: синхронизировать не с чем. Подключите его к серверу на вкладке «Профиль».", null]
        : !st.enabled
          ? [st.erased ? "Выключена: данные синхронизации стёрли с сервера с другого компьютера. Здешние данные на месте." : "Выключена: пароли, коды, закладки и вкладки остаются на каждом компьютере свои.", null]
          : st.busy
            ? ["Идёт сверка…", null]
            : {
                ok: [when ? `Данные сверены ${when}.` : "Данные сверены.", ["Сверить сейчас", () => Sync.syncNow()]],
                unknown: ["Первая сверка начнётся через несколько секунд.", ["Сверить сейчас", () => Sync.syncNow()]],
                locked: ["Сейф закрыт: сверка продолжится, когда он откроется.", ["Разблокировать", shell(s => s.vaultUnlockByUser())]],
                key: ["Ключа аккаунта на этом компьютере пока нет. Верните его паролем аккаунта в разделе «Почта → Ключи шифрования»: этим же ключом зашифрованы данные синхронизации.", ["Открыть ключи", shell(s => s.openMail("keys"))]],
                unsupported: ["Сервер Tabora пока не принимает данные синхронизации: это появится после его обновления. Настройка сохранена, сверка начнётся сама.", null],
                offline: ["Сервер не отвечает. Сверка повторится сама, когда соединение вернётся.", ["Повторить", () => Sync.syncNow()]],
                "signed-out": ["Вход в аккаунт не выполнен.", null],
                error: [`Сверка не удалась: ${st.error || "неизвестная ошибка"}`, ["Повторить", () => Sync.syncNow()]],
              }[st.state] || ["", null];
      const master = el("moz-toggle", { slot: "actions", "aria-label": "Синхронизация" });
      master.pressed = on;
      master.disabled = offline;
      master.addEventListener("toggle", () => Sync.setEnabled(master.pressed));
      const what = [
        ["passwords", "Пароли сайтов", "Логины и пароли из сейфа.", ["пароль", "пароля", "паролей"]],
        ["codes", "Коды входа", "Одноразовые коды двухфакторной защиты.", ["код", "кода", "кодов"]],
        ["bookmarks", "Закладки", "Папки и ссылки из раздела «Закладки».", ["запись", "записи", "записей"]],
        ["tabs", "Вкладки и пространства", "Список открытых вкладок, ярлыки стартовой страницы и пространства.", null],
      ];
      const rows = [];
      for (const [id, label, text, words] of what) {
        const g = st.groups[id];
        const toggle = el("moz-toggle", { slot: "actions", "aria-label": label });
        toggle.pressed = on && g.on;
        toggle.disabled = !on;
        toggle.addEventListener("toggle", () => Sync.setGroup(id, toggle.pressed));
        const count = on && g.on && words && g.count ? ` На сервере ${g.count} ${plural(g.count, ...words)}.` : "";
        rows.push(item(label, text + count, [toggle]));
        if (on && g.hold) {
          // с этого компьютера разом пропала заметная часть записей: удаления не отправлены, решает пользователь
          rows.push(item(
            `«${label}»: здесь пропало ${g.hold.missing} из ${g.hold.of} ${plural(g.hold.of, "записи", "записей", "записей")}`,
            "На другие компьютеры эти удаления не отправлены. Если вы удаляли записи сами — подтвердите; если они пропали — верните их с сервера.",
            [button("Вернуть с сервера", () => Sync.resolveHold(g.hold.name, "restore"), { type: "primary" }), button("Удалить везде", () => Sync.resolveHold(g.hold.name, "delete"))]
          ));
        }
      }
      const tabsOf = on && st.groups.tabs.on ? Sync.devicesTabs() : [];
      const tabsMenu = dev => e => {
        const r = e.currentTarget.getBoundingClientRect();
        // меню рисует окно браузера: координаты кнопки переводятся из страницы настроек в окно
        const frame = window.browsingContext?.embedderElement?.getBoundingClientRect() || { left: 0, top: 0 };
        shell(s => s.showMenu(dev.tabs.map(t => {
          let host = "";
          try {
            host = new URL(t.u).hostname.replace(/^www\./, "");
          } catch (err) {}
          return { label: t.t || host || t.u, hint: host, run: () => s.openUrl(t.u) };
        }), frame.left + r.right, frame.top + r.bottom + 6, { end: true }))();
      };
      return [
        group("Синхронизация", "Пароли, коды, закладки и вкладки переносятся между вашими компьютерами. Всё шифруется на этом компьютере ключом аккаунта: сервер хранит только зашифрованные копии и прочитать их не может.", [
          item("Синхронизировать этот компьютер", now[0], [now[1] ? button(now[1][0], now[1][1]) : null, master]),
          ...rows,
          item("Фраза восстановления кошелька", "Не синхронизируется никогда: остаётся только на том компьютере, где её ввели.", [value("никогда", true)]),
        ]),
        tabsOf.length
          ? group("Вкладки на других компьютерах", "Что открыто на остальных компьютерах аккаунта. Вкладка открывается здесь по нажатию.", tabsOf.map(dev => item(
              dev.name,
              `${dev.tabs.length} ${plural(dev.tabs.length, "вкладка", "вкладки", "вкладок")}${dev.at ? `, список от ${date(dev.at)}` : ""}`,
              [button("Показать", tabsMenu(dev))]
            )))
          : null,
        group("Устройства", offline ? "Список появится, когда аккаунт подключат к серверу." : "Компьютеры, на которых выполнен вход в этот аккаунт.", devices),
        on || st.at
          ? group("Данные на сервере", "", [
              item("Стереть данные синхронизации с сервера", "Зашифрованные копии на сервере будут удалены, синхронизация выключится на всех компьютерах аккаунта. Данные на самих компьютерах останутся.", [button("Стереть", async e => {
                const b = e.currentTarget;
                if (b.dataset.sure !== "1") {
                  // второе нажатие подтверждает: окна подтверждения у страницы настроек нет
                  b.dataset.sure = "1";
                  b.label = "Точно стереть";
                  setTimeout(() => {
                    b.dataset.sure = "";
                    b.label = "Стереть";
                  }, 5000);
                  return;
                }
                try {
                  await Sync.erase();
                  shell(s => s.notice("Данные синхронизации стёрты с сервера"))();
                } catch (err) {
                  shell(s => s.notice(`Не удалось стереть: ${err.message}`))();
                }
              })]),
            ])
          : null,
      ];
    },

    data() {
      return [
        group("Принести в Tabora", "Закладки, историю и пароли из другого браузера переносит «Импорт данных браузера» ниже.", [
          item("Пароли из файла CSV", "Подходят файлы из Chrome, Firefox, Safari, Bitwarden и 1Password.", [button("Выбрать файл", shell(s => s.accountImportPasswords()))]),
          item("Коды входа", "Экспорт Google Authenticator, Aegis, 2FAS или список ссылок otpauth://.", [button("Выбрать файл", shell(s => s.otpImportFile()))]),
        ]),
        group("Забрать из Tabora", "", [
          item("Пароли в файл CSV", "Файл не зашифрован: кто его откроет, увидит все пароли. Удалите его сразу после переноса.", [button("Сохранить файл", shell(s => s.accountExportPasswords()))]),
        ]),
      ];
    },

    accounts() {
      const others = (state.profiles || []).filter(p => !p.current);
      const stateText = p => (p.email ? (p.signedIn ? "Вход выполнен." : "Выход выполнен.") : p.fresh ? "Аккаунт ещё не создан." : "Аккаунта в этом профиле нет.");
      return [
        group("Аккаунты на этом компьютере", "У каждого аккаунта свой профиль браузера: свои вкладки, история, сейф, кошелёк и почта. Между аккаунтами ничего не передаётся.", [
          item(Account.email, "Этот профиль.", [value("открыт сейчас", true)]),
          ...others.map(p =>
            item(p.email || (p.fresh ? "Новый аккаунт" : "Профиль без аккаунта"), stateText(p), [
              button("Открыть", shell(s => s.accountOpen(p))),
              button("Удалить", shell(s => s.accountDialog("remove", { profile: p })), { type: "destructive" }),
            ])
          ),
          item("Добавить аккаунт", "Откроется новое окно: в нём создают аккаунт или входят в существующий.", [button("Добавить", shell(s => s.accountAdd()))]),
        ]),
      ];
    },

    exit() {
      return [
        group("Выход", "После выхода кошелёк, коды, пароли и почта закрыты до следующего входа. Данные остаются на этом компьютере зашифрованными.", [
          item("Выйти из аккаунта", Account.email, [button("Выйти", shell(s => s.accountLogout({ thenLogin: false })))]),
        ]),
        group("Удаление", "", [item("Удалить аккаунт", `Удаление аккаунта вместе с почтой ${LATER}.`, [button("Удалить", () => {}, { type: "destructive", disabled: true })])]),
      ];
    },
  };

  /** Группа «Вход в аккаунт»: двухфакторная защита и резервный адрес. Их хранит сервер. */
  function signInGroup() {
    const sec = state.security;
    const dialog = (step, opts) => shell(s => s.accountDialog(step, opts));
    let twoFactor;
    let backup;
    if (!sec || sec.error) {
      const text = sec?.error ? "Не удалось получить настройки с сервера. Проверьте соединение." : "Загружаем настройки с сервера.";
      const retry = sec?.error ? [button("Повторить", () => loadSecurity(true))] : [];
      twoFactor = item("Двухфакторная защита", text, retry);
      backup = item("Резервный адрес", text);
    } else if (sec.local || sec.unsupported) {
      const later = sec.unsupported ? "Появится после обновления сервера Tabora." : "Появится, когда аккаунт подключат к серверу Tabora.";
      twoFactor = item("Двухфакторная защита", later, [button("Включить", () => {}, { disabled: true })]);
      backup = item("Резервный адрес", later, [button("Указать", () => {}, { disabled: true })]);
    } else {
      const on = sec.twoFactor.enabled;
      const left = sec.twoFactor.backupCodes;
      twoFactor = on
        ? item("Двухфакторная защита", `Включена ${date(sec.twoFactor.since)}. Резервных кодов осталось: ${left}.`, [
            button("Резервные коды", dialog("twofa-codes"), { type: left < 3 ? "primary" : "default" }),
            button("Выключить", dialog("twofa-off")),
          ])
        : item("Двухфакторная защита", "Выключена: для входа достаточно пароля. С защитой понадобится ещё код из приложения на телефоне.", [button("Включить", dialog("twofa"), { type: "primary" })]);
      const set = sec.backupEmail;
      const pending = sec.backupEmailPending;
      if (pending) {
        backup = item("Резервный адрес", `${pending.address} ждёт подтверждения: введите код из письма.${set ? ` Пока действует прежний адрес ${set.address}.` : ""}`, [
          button("Ввести код", dialog("bemail-code", { address: pending.address, twoFactor: on }), { type: "primary" }),
          button("Другой адрес", dialog("bemail", { twoFactor: on })),
        ]);
      } else if (set) {
        backup = item("Резервный адрес", `${set.address}. Сюда придёт код, если вы забудете пароль.${on ? "" : " Тот, кто получит этот ящик, сможет сбросить пароль аккаунта: включите двухфакторную защиту."}`, [
          button("Изменить", dialog("bemail", { twoFactor: on })),
          button("Удалить", dialog("bemail-off", { address: set.address, twoFactor: on })),
        ]);
      } else if (!sec.mail) {
        backup = item("Резервный адрес", "Сервер сейчас не отправляет письма: указать адрес пока нельзя.", [button("Указать", () => {}, { disabled: true })]);
      } else {
        backup = item("Резервный адрес", "Не указан. На него придёт код, если вы забудете пароль; без него пароль вернёт только ключ восстановления.", [button("Указать", dialog("bemail", { twoFactor: on }))]);
      }
    }
    return group("Вход в аккаунт", "Защита входа в аккаунт на сервере: с неё начинается доступ к почте, кошельку, кодам и паролям.", [twoFactor, backup]);
  }

  /** Настройки входа хранит сервер: читаются при открытии вкладки и после каждой перемены. */
  async function loadSecurity(force = false) {
    if (!Account.signedIn || (state.securityLoading && !force)) {
      return;
    }
    state.securityLoading = true;
    if (force) {
      state.security = null;
      render();
    }
    let result;
    try {
      result = await Account.security();
    } catch (e) {
      result = { error: e.message || String(e) };
    }
    state.securityLoading = false;
    const changed = JSON.stringify(result) !== JSON.stringify(state.security);
    state.security = result;
    if (changed && state.tab === "security") {
      render();
    }
  }

  /* ---- Отрисовка ----------------------------------------------------------- */

  function who() {
    const email = Account.email;
    if (!Account.signedIn) {
      return el("div", { class: "tabora-acc-who out" }, [
        el("div", { class: "tabora-acc-id" }, [
          el("b", {}, email ? "Вы вышли из аккаунта" : "Аккаунт Tabora"),
          el("span", {}, email ? `${email}. Кошелёк, коды, пароли и почта этого профиля закрыты, пока вы не войдёте снова.` : "Адрес почты на tabora.app и один пароль для входа и сейфа. Кошелёк, коды и почта открываются после входа в аккаунт."),
        ]),
        el("div", { class: "tabora-acc-actions" }, [
          (() => {
            const b = button(email ? "Войти" : "Создать аккаунт", shell(s => s.accountDialog(email ? "login" : "register")), { type: "primary" });
            b.removeAttribute("slot");
            return b;
          })(),
          (() => {
            const b = button(email ? "Другой аккаунт" : "Войти", shell(s => (email ? s.accountShowAccounts() : s.accountDialog("login"))));
            b.removeAttribute("slot");
            return b;
          })(),
        ]),
      ]);
    }
    const status = Shell?.accountStatus() || { level: "ok", text: "" };
    const avatar = el("span", { class: "tabora-acc-avatar", "aria-hidden": "true" }, (email || "?").trim().charAt(0).toUpperCase());
    avatar.style.setProperty("--avatar", Shell?.accountAvatarColor() || "#c8f25a");
    return el("div", { class: "tabora-acc-who" }, [
      avatar,
      el("div", { class: "tabora-acc-id" }, [el("b", {}, email), el("span", { class: "tabora-acc-status" }, [el("i", { class: `tabora-acc-dot ${status.level}` }), status.text])]),
    ]);
  }

  function tabs() {
    const attention = Shell?.accountStatus().level === "warn";
    // значок «нужно действие» стоит на той вкладке, где это действие: подключение к серверу —
    // в «Профиле», ключ восстановления — в «Безопасности»
    const where = Account.needsServerLink ? "profile" : "security";
    const bar = el("div", { class: "tabora-acc-tabs", role: "tablist", "aria-label": "Разделы аккаунта" }, TABS.map(([id, label]) => {
      const selected = id === state.tab;
      const b = el("button", { class: "tabora-acc-tab", type: "button", role: "tab", id: `tabora-acc-tab-${id}`, "aria-selected": String(selected), tabindex: selected ? "0" : "-1" }, [
        label,
        id === where && attention ? el("span", { class: "tabora-acc-badge", "aria-label": "нужно действие" }, "1") : null,
        id === "support" && Shell?.account?.support?.count ? el("span", { class: "tabora-acc-badge", "aria-label": "есть ответ поддержки" }, String(Shell.account.support.count)) : null,
      ]);
      b.addEventListener("click", () => select(id));
      return b;
    }));
    // стрелки переключают вкладки, как положено списку вкладок
    bar.addEventListener("keydown", e => {
      const i = TABS.findIndex(t => t[0] === state.tab);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        select(TABS[(i + step + TABS.length) % TABS.length][0], { focus: true });
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        select(TABS[e.key === "Home" ? 0 : TABS.length - 1][0], { focus: true });
      }
    });
    // в узком окне строка вкладок прокручивается: выбранная вкладка должна быть на виду
    requestAnimationFrame(() => {
      const sel = bar.querySelector('[aria-selected="true"]');
      if (sel && bar.scrollWidth > bar.clientWidth) {
        bar.scrollLeft = sel.offsetLeft - (bar.clientWidth - sel.offsetWidth) / 2;
      }
    });
    return bar;
  }

  function render() {
    const root = state.root;
    if (!root?.isConnected) {
      return;
    }
    const signedIn = Account.signedIn;
    // состояние читает preferences.css: без входа — только приглашение; на вкладке «Данные»
    // под нашими группами показывается штатный «Импорт данных браузера»
    state.pane?.setAttribute("data-acc-tab", signedIn ? state.tab : "out");
    if (!signedIn) {
      root.replaceChildren(who(), el("p", { class: "tabora-acc-contact" }, "Не получается войти? Напишите нам на hello@tabora.app."));
      return;
    }
    const panel = el("div", { class: "tabora-acc-panel", role: "tabpanel", "aria-labelledby": `tabora-acc-tab-${state.tab}` }, PANELS[state.tab]());
    root.replaceChildren(who(), tabs(), panel);
    if (state.tab === "sync") {
      loadDevices();
      if (!state.syncSeen) {
        // состояние сверки читается с диска один раз: до первой сверки счётчики иначе пусты
        state.syncSeen = true;
        Sync.overview().then(() => state.tab === "sync" && render());
      }
    }
    if (state.tab === "security" && !state.security) {
      loadSecurity();
    }
  }

  /** Список аккаунтов компьютера: его меняют и другие окна, поэтому перечитывается при
   * открытии вкладки, по сигналу Profiles и когда окно снова становится активным. */
  async function loadProfiles() {
    let list;
    try {
      list = await Profiles.list();
    } catch (e) {
      list = state.profiles || [];
    }
    const changed = JSON.stringify(list) !== JSON.stringify(state.profiles);
    state.profiles = list;
    if (changed && state.tab === "accounts") {
      render();
    }
  }

  function select(id, { focus = false, fromHash = false } = {}) {
    if (!PANELS[id]) {
      return;
    }
    state.tab = id;
    if (id === "accounts") {
      loadProfiles();
    }
    if (!fromHash) {
      // адрес меняется без события hashchange: страница настроек не переключает раздел заново
      history.replaceState(history.state, "", id === "profile" ? "#sync" : `#sync-${id}`);
    }
    render();
    if (focus) {
      document.getElementById(`tabora-acc-tab-${id}`)?.focus();
    }
  }

  function tabFromHash() {
    const m = /^#sync-([a-z]+)$/.exec(location.hash);
    return m && PANELS[m[1]] ? m[1] : null;
  }

  /** Страница настроек сводит адрес вида #sync-accounts к #sync, а подраздел оставляет в
   * gLastCategory и сообщает событием paneshown: вкладку, которую просили открыть, берём оттуда. */
  function tabFromPage() {
    const last = typeof gLastCategory === "object" && gLastCategory ? gLastCategory : null;
    return last?.category === "paneSync" && PANELS[last.subcategory] ? last.subcategory : null;
  }

  async function loadDevices() {
    if (state.devicesFor === Account.email && state.devices) {
      return;
    }
    const email = Account.email;
    try {
      state.devices = await Account.devices();
    } catch (e) {
      state.devices = [];
    }
    state.devicesFor = email;
    if (state.tab === "sync" && Account.email === email) {
      render();
    }
  }

  /** section — секция раздела paneSync. Повторный вызов ничего не делает. */
  function mount(section) {
    if (state.root?.isConnected) {
      return;
    }
    state.pane = section.closest("setting-pane");
    state.root = el("div", { id: "tabora-account" });
    const header = section.querySelector("moz-page-header");
    if (header) {
      // заголовок раздела: «Аккаунт» вместо «Аккаунт и синхронизация» Firefox
      header.removeAttribute("data-l10n-id");
      header.setAttribute("heading", "Аккаунт");
      header.heading = "Аккаунт";
      header.after(state.root);
    } else {
      section.prepend(state.root);
    }
    state.tab = tabFromHash() || tabFromPage() || state.tab;
    Promise.all([Account.ready(), Vault.ready(), loadProfiles()]).then(render, render);
  }

  document.addEventListener("paneshown", e => {
    const { category, subcategory } = e.detail || {};
    if (category === "paneSync" && PANELS[subcategory] && state.root?.isConnected) {
      select(subcategory);
    }
  });

  window.addEventListener("hashchange", () => {
    if (location.hash === "#sync") {
      select("profile", { fromHash: true });
    } else {
      const id = tabFromHash();
      if (id) {
        select(id, { fromHash: true });
      }
    }
  });

  // аккаунт или сейф изменились (вход, выход, блокировка, новый ключ): перерисовать
  const refresh = (subject, topic, what) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.devices = null;
      if (!Account.signedIn) {
        state.security = null;
      }
      render();
      // перемена в аккаунте: настройки входа перечитываются в фоне, прежние видны до ответа
      if (topic === Account.TOPIC && what !== "first-run" && state.tab === "security") {
        loadSecurity();
      }
    }, 60);
  };
  Services.obs.addObserver(refresh, Account.TOPIC);
  Services.obs.addObserver(refresh, Vault.TOPIC);
  // ход сверки и её итог видны на вкладке «Синхронизация» сразу
  const syncRefresh = () => state.tab === "sync" && refresh();
  Services.obs.addObserver(syncRefresh, Sync.TOPIC);
  Services.obs.addObserver(loadProfiles, Profiles.TOPIC);
  window.addEventListener("focus", loadProfiles);
  window.addEventListener("unload", () => {
    Services.obs.removeObserver(refresh, Account.TOPIC);
    Services.obs.removeObserver(refresh, Vault.TOPIC);
    Services.obs.removeObserver(syncRefresh, Sync.TOPIC);
    Services.obs.removeObserver(loadProfiles, Profiles.TOPIC);
  }, { once: true });

  return { mount, render };
})();
