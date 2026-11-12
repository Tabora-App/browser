/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Окно письма: новое, ответ, пересылка, продолжение черновика. Черновик сохраняется на сервере
 * сам, пока письмо пишется; когда всем получателям можно зашифровать — письмо шифруется. */

import { MAX_ATTACH_BYTES } from "../core/mail.js";
import { cleanRich, richToText } from "../core/sanitize.js";
import { h, icon } from "../lib/dom.js";
import { createEditor } from "../lib/editor.js";
import { busy, confirmDialog, debounce, errorText, fileSize, longDate, toast } from "../lib/ui.js";

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
let current = null;

function parseList(value) {
  const out = [];
  const bad = [];
  for (const part of String(value || "").split(/[,;\n]+/)) {
    const raw = part.trim();
    if (!raw) {
      continue;
    }
    const m = /<([^>]+)>/.exec(raw);
    const email = (m ? m[1] : raw).trim().toLowerCase();
    if (EMAIL_RE.test(email)) {
      out.push(email);
    } else {
      bad.push(raw);
    }
  }
  return { list: [...new Set(out)], bad };
}

const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textToHtml = s => esc(s).replace(/\r\n?/g, "\n").split("\n").join("<br>");
const prefixed = (subject, prefix) => (new RegExp(`^\\s*(${prefix}|${prefix === "Re" ? "Ответ|На" : "Fw|Пересылка"})\\s*:`, "i").test(subject) ? subject : `${prefix}: ${subject}`);

/**
 * @param {object} ctx
 * @param {{ mode?: "new" | "reply" | "replyAll" | "forward", original?: object, draft?: object, to?: string, onSent?: () => void, onDraft?: () => void }} opts
 */
export function openCompose(ctx, { mode = "new", original = null, draft = null, to = "", onSent = null, onDraft = null } = {}) {
  if (current) {
    current.focus();
    return;
  }
  const { mail, account, api } = ctx;
  const me = account.email;
  const src = draft || original;
  let files = []; // { name, type, size, bytes? , load?: () => Promise<Uint8Array> }
  let draftId = draft?.id || "";
  let dirty = false;
  let saving = null;
  let sent = false;
  let closed = false;
  let encrypt = false;
  let encryptTouched = false;
  let plan = { available: false, possible: false, missing: [] };
  // на какое письмо отвечаем: у черновика ответа это записано в его заголовках
  const replyRef = draft ? (draft.inReplyTo ? { messageId: draft.inReplyTo, references: (draft.references || []).filter(r => r !== draft.inReplyTo) } : null) : mode === "forward" ? null : original;

  /* ---- заготовка ---- */

  let initTo = to;
  let initCc = "";
  let subject = "";
  let bodyHtml = "";
  const others = list => list.map(p => p.email).filter(e => e && e !== me);
  if (draft) {
    initTo = draft.to.map(p => p.email).join(", ");
    initCc = draft.cc.map(p => p.email).join(", ");
    subject = draft.subject === "(без темы)" ? "" : draft.subject;
    bodyHtml = draft.html ? cleanRich(draft.html) : textToHtml(draft.text);
  } else if (original) {
    const mine = original.from.email === me;
    const quoteText = original.text || richToText(cleanRich(original.html));
    const who = original.from.name ? `${original.from.name} <${original.from.email}>` : original.from.email;
    if (mode === "forward") {
      subject = prefixed(original.subject, "Fwd");
      bodyHtml = `<br><br>---------- Пересылаемое письмо ----------<br>От: ${esc(who)}<br>Дата: ${esc(longDate(original.date))}<br>Тема: ${esc(original.subject)}<br>Кому: ${esc(original.to.map(p => p.email).join(", "))}<br><br>${textToHtml(quoteText)}`;
    } else {
      subject = prefixed(original.subject, "Re");
      // ответ на своё письмо идёт тем же получателям; письмо самому себе — себе же
      const toOthers = others(original.to);
      initTo = mine ? (toOthers.length ? toOthers : original.to.map(p => p.email)).join(", ") : original.replyTo || original.from.email;
      if (mode === "replyAll") {
        const first = new Set(parseList(initTo).list);
        const rest = [...others(original.to), ...others(original.cc)].filter(e => !first.has(e));
        if (mine) {
          initCc = others(original.cc).join(", ");
        } else {
          initCc = [...new Set(rest)].join(", ");
        }
      }
      bodyHtml = `<br><br>${esc(longDate(original.date))}, ${esc(who)}:<blockquote>${textToHtml(quoteText)}</blockquote>`;
    }
  }

  /* ---- поля ---- */

  const fromSelect = h("select", { class: "compose-from", "aria-label": "От кого" }, h("option", { value: me }, me));
  const fromRow = h("label", { class: "compose-row", hidden: true }, h("span", {}, "От"), fromSelect);
  const toInput = h("input", { class: "compose-input", type: "text", inputmode: "email", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Кому", placeholder: "адрес получателя" });
  const ccInput = h("input", { class: "compose-input", type: "text", inputmode: "email", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Копия" });
  const bccInput = h("input", { class: "compose-input", type: "text", inputmode: "email", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Скрытая копия" });
  const subjectInput = h("input", { class: "compose-input", type: "text", "aria-label": "Тема", placeholder: "Тема", maxlength: 300 });
  toInput.value = initTo;
  ccInput.value = initCc;
  subjectInput.value = subject;
  const ccToggle = h("button", { class: "link-btn compose-cc", type: "button" }, "Копия");
  const ccRow = h("label", { class: "compose-row", hidden: !initCc }, h("span", {}, "Копия"), ccInput);
  const bccRow = h("label", { class: "compose-row", hidden: true }, h("span", {}, "Скрытая"), bccInput);
  ccToggle.hidden = !!initCc;
  ccToggle.addEventListener("click", () => {
    ccRow.hidden = false;
    bccRow.hidden = false;
    ccToggle.hidden = true;
    ccInput.focus();
  });
  const editor = createEditor({ html: bodyHtml, onchange: () => touch() });
  const fileList = h("div", { class: "attach-list compose-files" });
  const fileInput = h("input", { type: "file", multiple: true, class: "offscreen", tabindex: "-1" });
  const error = h("div", { class: "form-error", role: "alert", hidden: true });
  const lock = h("button", { class: "compose-lock", type: "button", hidden: true });
  const status = h("span", { class: "compose-status" });
  const sendButton = h("button", { class: "btn primary" }, icon("send", 16), "Отправить");
  const title = mode === "reply" || mode === "replyAll" ? "Ответ" : mode === "forward" ? "Пересылка" : draft ? "Черновик" : "Новое письмо";

  const panel = h("div", { class: "compose", role: "dialog", "aria-label": title },
    h("header", { class: "compose-head" }, h("h2", {}, title), status, h("button", { class: "icon-btn", "aria-label": "Удалить черновик", title: "Удалить черновик", onclick: () => discard() }, icon("trash", 18)), h("button", { class: "icon-btn", "aria-label": "Закрыть", title: "Закрыть и сохранить черновик", onclick: () => close() }, icon("close", 19))),
    h("div", { class: "compose-fields" },
      fromRow,
      h("label", { class: "compose-row" }, h("span", {}, "Кому"), toInput, ccToggle),
      ccRow, bccRow,
      h("label", { class: "compose-row" }, h("span", { class: "offscreen" }, "Тема"), subjectInput)),
    editor.el, fileList, fileInput, error,
    h("footer", { class: "compose-foot" },
      sendButton,
      h("button", { class: "icon-btn", type: "button", "aria-label": "Приложить файл", title: "Приложить файл", onclick: () => fileInput.click() }, icon("clip", 19)),
      lock));
  const backdrop = h("div", { class: "compose-backdrop" }, panel);
  document.body.append(backdrop);

  const setError = text => {
    error.textContent = text || "";
    error.hidden = !text;
  };

  /* ---- вложения ---- */

  function drawFiles() {
    fileList.replaceChildren(...files.map((f, i) => h("span", { class: "attach" }, icon(f.type.startsWith("image/") ? "image" : "clip", 14), h("span", {}, f.name), h("small", {}, fileSize(f.size)), h("button", { class: "icon-btn tiny", type: "button", "aria-label": `Убрать ${f.name}`, onclick: () => { files.splice(i, 1); drawFiles(); touch(); } }, icon("close", 13)))));
  }

  async function addFiles(list) {
    for (const f of list) {
      const total = files.reduce((n, x) => n + x.size, 0) + f.size;
      if (total > MAX_ATTACH_BYTES) {
        toast("Вложения больше 20 МБ не отправятся", { tone: "bad" });
        break;
      }
      files.push({ name: f.name, type: f.type || "application/octet-stream", size: f.size, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    drawFiles();
    touch();
  }
  fileInput.addEventListener("change", () => {
    addFiles([...fileInput.files]);
    fileInput.value = "";
  });
  panel.addEventListener("dragover", e => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
    }
  });
  panel.addEventListener("drop", e => {
    if (e.dataTransfer?.files.length) {
      e.preventDefault();
      addFiles([...e.dataTransfer.files]);
    }
  });
  // вложения пересылаемого письма и черновика едут вместе с ним
  const carry = (mode === "forward" && original ? original.attachments : draft ? draft.attachments : []) || [];
  for (const a of carry) {
    files.push({ name: a.name, type: a.type, size: a.size, load: () => mail.attachment(src, a) });
  }
  drawFiles();

  async function attachments() {
    const out = [];
    for (const f of files) {
      f.bytes ||= await f.load();
      out.push({ name: f.name, type: f.type, bytes: f.bytes });
    }
    return out;
  }

  /* ---- шифрование ---- */

  function drawLock() {
    lock.hidden = !plan.available;
    if (!plan.available) {
      return;
    }
    const on = encrypt && plan.possible;
    lock.classList.toggle("on", on);
    lock.replaceChildren(icon(on ? "lock" : "unlock", 16), h("span", {}, on ? "Зашифровано" : "Без шифрования"));
    lock.title = on ? "Прочитать письмо смогут только получатели" : plan.possible ? "Письмо уйдёт открытым" : plan.missing.length ? `Нет ключа у ${plan.missing.join(", ")}: зашифровать можно письмо на адреса Tabora` : "Укажите получателя";
    lock.disabled = !plan.possible;
  }
  lock.addEventListener("click", () => {
    encrypt = !encrypt;
    encryptTouched = true;
    drawLock();
  });
  const replan = debounce(async () => {
    const rcpt = [...parseList(toInput.value).list, ...parseList(ccInput.value).list];
    try {
      plan = await mail.plan(fromSelect.value, rcpt);
    } catch (e) {
      plan = { available: false, possible: false, missing: [] };
    }
    if (closed) {
      return;
    }
    // между адресами Tabora письмо шифруется само; человек может это отменить
    if (!encryptTouched) {
      encrypt = plan.possible && !parseList(bccInput.value).list.length;
    }
    drawLock();
  }, 400);

  /* ---- черновик ---- */

  const hasContent = () => !!(toInput.value.trim() || subjectInput.value.trim() || !editor.isEmpty() || files.length);

  function touch() {
    dirty = true;
    autosave();
  }
  for (const input of [toInput, ccInput, bccInput, subjectInput]) {
    input.addEventListener("input", () => {
      touch();
      if (input !== subjectInput) {
        replan();
      }
    });
  }
  fromSelect.addEventListener("change", () => {
    touch();
    replan();
  });

  async function saveDraft() {
    if (sent || !dirty || !hasContent()) {
      return;
    }
    if (saving) {
      await saving;
      if (!dirty) {
        return;
      }
    }
    dirty = false;
    status.textContent = "Сохраняем…";
    saving = (async () => {
      try {
        const { html, text } = editor.value();
        draftId = await mail.saveDraft({ from: fromSelect.value, to: parseList(toInput.value).list, cc: parseList(ccInput.value).list, subject: subjectInput.value.trim(), text, html, attachments: await attachments(), original: replyRef, replaces: draftId });
        status.textContent = "Черновик сохранён";
        onDraft?.();
      } catch (e) {
        dirty = true;
        status.textContent = "Черновик не сохранён";
      } finally {
        saving = null;
      }
    })();
    await saving;
  }
  const autosave = debounce(() => {
    if (!closed) {
      saveDraft();
    }
  }, 5000);

  /* ---- отправка и закрытие ---- */

  async function send() {
    setError("");
    const toList = parseList(toInput.value);
    const ccList = parseList(ccInput.value);
    const bccList = parseList(bccInput.value);
    const bad = [...toList.bad, ...ccList.bad, ...bccList.bad];
    if (bad.length) {
      setError(`Не похоже на адрес почты: ${bad.slice(0, 3).join(", ")}`);
      return;
    }
    if (!toList.list.length && !ccList.list.length && !bccList.list.length) {
      setError("Укажите, кому отправить письмо");
      toInput.focus();
      return;
    }
    if (!subjectInput.value.trim() && editor.isEmpty() && !files.length) {
      setError("Письмо пустое");
      return;
    }
    if (!subjectInput.value.trim() && !(await confirmDialog({ title: "Отправить без темы?", text: "У письма нет темы. Получателю будет труднее его найти.", confirm: "Отправить" }))) {
      return;
    }
    try {
      await busy(sendButton, async step => {
        if (saving) {
          await saving;
        }
        const { html, text } = editor.value();
        if (files.some(f => !f.bytes)) {
          step("Готовим вложения");
        }
        const list = await attachments();
        step(encrypt && plan.possible ? "Шифруем и отправляем" : "Отправляем");
        const r = await mail.send({ from: fromSelect.value, to: toList.list, cc: ccList.list, bcc: bccList.list, subject: subjectInput.value.trim(), text, html, attachments: list, original: replyRef, encrypt: encrypt && plan.possible && !bccList.list.length, draftId });
        sent = true;
        toast(r.encrypted ? "Письмо отправлено зашифрованным" : "Письмо отправлено");
      }, "Отправляем");
      destroy();
      onSent?.();
    } catch (e) {
      setError(errorText(e));
    }
  }
  sendButton.addEventListener("click", send);

  async function close() {
    if (closed) {
      return;
    }
    if (!sent && dirty && hasContent()) {
      status.textContent = "Сохраняем…";
      await saveDraft();
      if (dirty) {
        if (!(await confirmDialog({ title: "Черновик не сохранён", text: "Нет связи с сервером. Закрыть окно и потерять текст письма?", confirm: "Закрыть", danger: true }))) {
          return;
        }
      } else {
        toast("Черновик сохранён");
      }
    }
    destroy();
  }

  async function discard() {
    if (hasContent() && !(await confirmDialog({ title: "Удалить черновик?", text: "Текст письма будет потерян.", confirm: "Удалить", danger: true }))) {
      return;
    }
    sent = true; // больше не сохранять
    const id = draftId;
    destroy();
    if (saving) {
      await saving.catch(() => {});
    }
    if (id || draftId) {
      await mail.remove([draftId || id], { forever: true }).catch(() => {});
      onDraft?.();
    }
  }

  function onKey(e) {
    if (closed || document.querySelector(".modal-backdrop")) {
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }
  document.addEventListener("keydown", onKey, true);

  function destroy() {
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    current = null;
  }

  current = { focus: () => (toInput.value ? editor.focus(true) : toInput.focus()) };

  // адреса отправителя: основной и включённые алиасы
  api.aliases(account.token).then(list => {
    const on = (Array.isArray(list) ? list : []).filter(a => a.on !== false && a.address);
    if (!on.length || closed) {
      return;
    }
    for (const a of on) {
      fromSelect.append(h("option", { value: a.address }, a.site ? `${a.address} — ${a.site}` : a.address));
    }
    fromRow.hidden = false;
    // ответ на письмо, пришедшее на алиас, уходит с того же алиаса
    const mineTo = original && !draft ? [...original.to, ...original.cc].map(p => p.email).find(e => on.some(a => a.address === e)) : "";
    if (mineTo) {
      fromSelect.value = mineTo;
      replan();
    }
  }).catch(() => {});

  replan();
  queueMicrotask(() => current?.focus());
}
