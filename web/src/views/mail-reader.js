/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Показ переписки. Письмо с вёрсткой отправителя рисуется в отдельной рамке без скриптов и без
 * сети (см. core/sanitize.js); текстовое письмо — обычным текстом страницы. */

import { sanitizeMail } from "../core/sanitize.js";
import { clear, h, icon } from "../lib/dom.js";
import { avatar, copyText, errorText, fileSize, longDate, menu, modal, shortDate, toast } from "../lib/ui.js";

const FRAME_CSS = `
html { color-scheme: light; }
body { margin: 0; padding: 18px 20px; font: 14.5px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #16171a; background: #fff; overflow-wrap: anywhere; -webkit-text-size-adjust: 100%; }
img { max-width: 100%; height: auto; }
img[data-blocked], img[data-empty] { min-width: 18px; min-height: 18px; background: #f0eee9; border-radius: 4px; }
table { max-width: 100%; }
a { color: #3d6400; }
blockquote { margin: 8px 0 8px 2px; padding-left: 12px; border-left: 2px solid #d6d2c8; color: #5e626b; }
pre { white-space: pre-wrap; }
`;
const URL_RE = /(https?:\/\/[^\s<>"'()\[\]{}]+[^\s<>"'()\[\]{}.,;:!?])/g;

/* Что сказать о защите письма (OpenPGP): [тон, значок, заголовок, пояснение]. Те же слова, что в
 * браузере Tabora (mail/mail.js, pgpNote). */
function pgpNote(m, mine) {
  const p = m.pgp;
  if (!p) {
    return null;
  }
  if (p.error) {
    const why = {
      "no-key": "Оно зашифровано ключом, которого у этого аккаунта нет.",
      locked: "Ключ аккаунта на этом устройстве закрыт: откройте его в разделе «Аккаунт».",
    }[p.error] || "Письмо повреждено или зашифровано способом, которого Tabora не знает.";
    return ["warn", "lock", "Письмо не расшифровано", why];
  }
  const other = `Подпись сделана ключом адреса ${p.signer}, а не отправителя.`;
  const noKey = "Ключа, которым оно подписано, у веб-версии нет: проверить подпись можно в Tabora на компьютере.";
  if (p.encrypted) {
    return {
      valid: ["ok", "lock", "Зашифровано и подписано", mine ? "Прочитать письмо можете только вы и получатели." : "Прочитать письмо могли только вы и другие получатели. Подпись отправителя верна."],
      none: ["warn", "lock", "Зашифровано, но не подписано", "Прочитать письмо могли только получатели, а вот кто его написал, проверить нельзя."],
      unknown: ["warn", "lock", "Зашифровано, подпись не проверена", noKey],
      other: ["warn", "lock", "Зашифровано, подписано другим адресом", other],
      invalid: ["bad", "alert", "Зашифровано, но подпись неверна", "Письмо изменили после подписи или подписал его не отправитель."],
    }[p.signature] || ["ok", "lock", "Зашифровано", "Прочитать письмо могли только получатели."];
  }
  return {
    valid: ["ok", "seal", "Подпись верна", "Письмо написал владелец этого адреса, и в пути оно не менялось."],
    unknown: ["info", "seal", "Подпись не проверена", noKey],
    other: ["warn", "seal", "Подписано другим адресом", other],
    invalid: ["bad", "alert", "Подпись неверна", "Письмо изменили в пути или подписал его не отправитель."],
  }[p.signature] || null;
}

/** Текст письма: абзацы, цитаты (строки с «>») отдельным блоком, адреса сайтов — ссылками. */
function textBody(text) {
  const out = h("div", { class: "msg-text" });
  const linkify = (line, into) => {
    let last = 0;
    for (const m of line.matchAll(URL_RE)) {
      into.append(line.slice(last, m.index), h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer nofollow" }, m[0]));
      last = m.index + m[0].length;
    }
    into.append(line.slice(last));
  };
  let quote = null;
  let para = null;
  for (const raw of String(text || "").replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").split("\n")) {
    const q = /^\s?>+\s?/.exec(raw);
    if (q) {
      para = null;
      quote ||= out.appendChild(h("blockquote", { class: "msg-quote" }));
      linkify(raw.replace(/^(\s?>)+\s?/, ""), quote);
      quote.append("\n");
    } else {
      quote = null;
      para ||= out.appendChild(h("div", {}));
      linkify(raw, para);
      para.append("\n");
    }
  }
  return out;
}

function saveBytes(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type: type || "application/octet-stream" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * @param {HTMLElement} el
 * @param {{ ctx: object, messages: object[], folderId: string, back: () => void, act: (kind: string, arg?: string) => void, compose: (opts: object) => void }} opts
 */
export function renderThread(el, { ctx, messages, folderId, back, act, compose }) {
  const { mail, account } = ctx;
  const urls = (el._urls ||= []);
  urls.splice(0).forEach(u => URL.revokeObjectURL(u));
  const last = messages[messages.length - 1];
  const role = mail.boxById(folderId)?.role || "";
  const sentBox = mail.box("sent")?.id;
  const isMine = m => m.from.email === account.email || m.mailboxIds.includes(sentBox) || m.draft;
  const expanded = new Set(messages.filter((m, i) => i === messages.length - 1 || m.unread).map(m => m.id));
  const remote = (el._remote ||= new Set());

  const starred = messages.some(m => m.starred);
  const moreButton = h("button", { class: "icon-btn", "aria-label": "Ещё" }, icon("more", 20, 2.4));
  moreButton.addEventListener("click", () => menu(moreButton, [
    { label: "Отметить непрочитанным", icon: "unread", run: () => act("unread") },
    { label: role === "junk" ? "Не спам" : "В спам", icon: "spam", run: () => act("junk") },
    null,
    ...mail.boxes.filter(b => b.id !== folderId && b.role !== "drafts" && b.role !== "sent").map(b => ({ label: `Перенести: ${b.name}`, icon: "folder", run: () => act("move", b.id) })),
  ]));
  const head = h("header", { class: "detail-head reader-head" },
    h("button", { class: "icon-btn back", "aria-label": "Назад", onclick: back }, icon("back", 20)),
    h("span", { class: "spacer" }),
    role !== "archive" && role !== "drafts" && role !== "sent" && role !== "trash" ? h("button", { class: "icon-btn", "aria-label": "В архив", title: "В архив", onclick: () => act("archive") }, icon("archive", 18)) : null,
    h("button", { class: "icon-btn", "aria-label": role === "trash" || role === "drafts" ? "Удалить насовсем" : "В корзину", title: role === "trash" || role === "drafts" ? "Удалить насовсем" : "В корзину", onclick: () => act("trash") }, icon("trash", 18)),
    h("button", { class: `icon-btn msg-star${starred ? " on" : ""}`, "aria-label": starred ? "Снять звезду" : "Отметить звездой", "aria-pressed": String(starred), onclick: () => act("star") }, icon("star", 18)),
    moreButton);

  const body = h("div", { class: "reader-body" }, h("h2", { class: "reader-subject" }, last.subject));

  for (const m of messages) {
    body.append(messageCard(m));
  }

  function messageCard(m) {
    const card = h("article", { class: `letter${expanded.has(m.id) ? " open" : ""}` });
    const draw = () => {
      const open = expanded.has(m.id);
      card.classList.toggle("open", open);
      const who = m.from.name || m.from.email || "Неизвестный отправитель";
      const toLine = [...m.to, ...m.cc].map(p => (p.email === account.email ? "вам" : p.name || p.email)).join(", ");
      const top = h("button", { class: "letter-head", "aria-expanded": String(open) },
        avatar(who),
        h("span", { class: "letter-who" },
          h("span", { class: "letter-from" }, h("b", {}, isMine(m) && m.from.email === account.email ? "Вы" : who), open && m.from.email && m.from.name ? h("span", { class: "letter-email" }, m.from.email) : null),
          h("span", { class: "letter-to" }, open ? (toLine ? `кому: ${toLine}` : "") : m.preview || " ")),
        h("time", { title: longDate(m.date) }, shortDate(m.date)));
      top.addEventListener("click", () => {
        if (messages.length === 1) {
          return;
        }
        if (open) {
          expanded.delete(m.id);
        } else {
          expanded.add(m.id);
        }
        draw();
      });
      clear(card, top);
      if (!open) {
        return;
      }
      const content = h("div", { class: "letter-body" });
      card.append(content);

      const note = pgpNote(m, isMine(m));
      if (note) {
        content.append(h("div", { class: `pgp-note ${note[0]}` }, icon(note[1], 16), h("span", {}, h("b", {}, note[2]), " ", note[3])));
      }
      if (m.code) {
        content.append(h("button", { class: "code-pill", onclick: () => copyText(m.code.replace(/\s+/g, ""), "Код скопирован") }, h("span", {}, "Код из письма"), h("b", { class: "mono" }, m.code), icon("copy", 15)));
      }
      if (m.draft) {
        content.append(h("div", { class: "note" }, icon("drafts", 17), h("div", {}, h("span", {}, "Это черновик: письмо ещё не отправлено."), h("button", { class: "btn small primary", onclick: () => compose({ draft: m }) }, "Продолжить"))));
      }
      if (m.pgp?.error) {
        // зашифрованное письмо без содержимого: показывать нечего
      } else if (m.html) {
        htmlBody(content, m, draw);
      } else {
        content.append(textBody(m.text));
      }
      if (m.truncated) {
        content.append(h("p", { class: "detail-meta" }, "Письмо очень большое и показано не целиком."));
      }
      if (m.attachments.length) {
        content.append(h("div", { class: "letter-files" }, m.attachments.map(a => {
          const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(a.type);
          const btn = h("button", { class: "file-chip", title: `${a.name} · ${fileSize(a.size)}` }, icon(isImage ? "image" : "clip", 16), h("span", { class: "file-name" }, a.name), h("small", {}, fileSize(a.size)), icon("download", 15));
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.classList.add("loading-file");
            try {
              const bytes = await mail.attachment(m, a);
              if (isImage) {
                preview(a, bytes);
              } else {
                saveBytes(bytes, a.name, a.type);
              }
            } catch (e) {
              toast(errorText(e), { tone: "bad" });
            } finally {
              btn.disabled = false;
              btn.classList.remove("loading-file");
            }
          });
          return btn;
        })));
      }
      if (!m.draft) {
        const many = [...m.to, ...m.cc].filter(p => p.email !== account.email).length + (isMine(m) ? 0 : 1) > 1;
        content.append(h("div", { class: "letter-actions" },
          h("button", { class: "btn small", onclick: () => compose({ mode: "reply", original: m }) }, icon("reply", 15), "Ответить"),
          many ? h("button", { class: "btn small", onclick: () => compose({ mode: "replyAll", original: m }) }, icon("replyAll", 15), "Ответить всем") : null,
          h("button", { class: "btn small", onclick: () => compose({ mode: "forward", original: m }) }, icon("forward", 15), "Переслать")));
      }
    };
    draw();
    return card;
  }

  function preview(a, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: a.type }));
    const m = modal({ title: a.name, wide: true, className: "preview", content: [h("img", { class: "preview-img", src: url, alt: a.name })], actions: [h("button", { class: "btn", onclick: () => saveBytes(bytes, a.name, a.type) }, icon("download", 16), "Сохранить"), h("button", { class: "btn primary", onclick: () => m.close() }, "Закрыть")], onclose: () => URL.revokeObjectURL(url) });
  }

  /** Вёрстка письма в рамке без скриптов. Картинки из самого письма подставляются, чужие — по кнопке. */
  function htmlBody(content, m, redraw) {
    const holder = h("div", { class: "letter-html" });
    const banner = h("div", { class: "images-note", hidden: true });
    content.append(banner, holder);
    const allow = remote.has(m.id);
    const frame = h("iframe", { class: "letter-frame", src: allow ? "/frame/mail-remote.html" : "/frame/mail.html", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer", title: "Текст письма", scrolling: "no" });
    let filled = false;
    const fill = async () => {
      if (filled) {
        return;
      }
      filled = true;
      const doc = frame.contentDocument;
      if (!doc) {
        return;
      }
      // картинки из самого письма (cid:…)
      const inline = {};
      await Promise.all(Object.entries(m.inline || {}).slice(0, 40).map(async ([cid, v]) => {
        try {
          if (v.data) {
            inline[cid] = `data:${v.type};base64,${v.data}`;
          } else if (v.blobId) {
            const url = URL.createObjectURL(new Blob([await mail.jmap.download(v.blobId, { name: v.name || "image", type: v.type })], { type: v.type }));
            urls.push(url);
            inline[cid] = url;
          }
        } catch (e) {}
      }));
      const clean = sanitizeMail(m.html, { inline, remote: allow, context: doc });
      const style = doc.createElement("style");
      style.textContent = `${FRAME_CSS}\n${clean.css}`;
      doc.head.append(style);
      if (clean.body.style) {
        doc.body.setAttribute("style", clean.body.style);
      }
      if (/^#?[0-9a-z]{3,20}$/i.test(clean.body.bgcolor)) {
        doc.body.style.backgroundColor = clean.body.bgcolor;
      }
      for (const node of [...clean.doc.documentElement.childNodes]) {
        doc.body.append(doc.importNode(node, true));
      }
      if (clean.blocked && !allow) {
        banner.hidden = false;
        clear(banner, icon("image", 16), h("span", {}, "Картинки с чужих серверов не загружены: так отправитель не узнает, что письмо открыто."), h("button", { class: "link-btn", onclick: () => { remote.add(m.id); redraw(); } }, "Показать"));
      }
      const fit = () => {
        const b = doc.body;
        if (!b || !frame.isConnected) {
          return;
        }
        b.style.zoom = "";
        const w = doc.documentElement.clientWidth;
        const sw = Math.max(doc.documentElement.scrollWidth, b.scrollWidth);
        if (w && sw > w + 2) {
          b.style.zoom = String(Math.max(0.35, w / sw));
        }
        frame.style.height = `${Math.ceil(Math.max(doc.documentElement.scrollHeight, b.scrollHeight))}px`;
      };
      fit();
      // картинки догружаются и меняют высоту: за этим следит наблюдатель страницы. Обработчик
      // события внутри рамки не годится — рамке запрещены скрипты, и Safari его не вызывает.
      if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(fit);
        ro.observe(frame);
        ro.observe(doc.body);
      }
      setTimeout(fit, 250);
      setTimeout(fit, 1200);
    };
    frame.addEventListener("load", fill);
    holder.append(frame);
  }

  clear(el, head, body);
  el.scrollTop = 0;
  // открытое последнее письмо — в поле зрения
  if (messages.length > 1) {
    queueMicrotask(() => body.lastElementChild?.scrollIntoView({ block: "start" }));
  }
}
