/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Почта: папки, списки переписок, письма, отметки, отправка, черновики. Сервер — тот же ящик, с
 * которым работает браузер Tabora; здесь он доступен по JMAP (core/jmap.js).
 *
 * Отправка устроена как в браузере: письмо собирается здесь целиком (core/mime.js — тот же код),
 * при необходимости шифруется, и готовый исходник передаётся серверу. Сервер не строит письмо сам,
 * поэтому зашифрованное письмо уходит зашифрованным от самой страницы.
 *
 * Черновики лежат на сервере в папке «Черновики»; когда ключ аккаунта открыт, черновик хранится
 * зашифрованным для самого себя: содержимое недописанного письма сервер не видит. */

import { utf8 } from "./bytes.js";
import { buildEntity, buildMessage, bytesOf, decodeAttachment, encryptedEntity, findCode, findSection, foldHeader, parseEntity, parseMessage } from "./mime.js";
import { t } from "./i18n.js";

const ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
export const ROLE_NAMES = { inbox: t`Входящие`, drafts: t`Черновики`, sent: t`Отправленные`, archive: t`Архив`, junk: t`Спам`, trash: t`Корзина` };
const LIST_PROPS = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment", "size"];
const THREAD_PROPS = ["threadId", "mailboxIds", "keywords", "from", "receivedAt"];
const FULL_PROPS = ["id", "blobId", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "bcc", "replyTo", "subject", "sentAt", "receivedAt", "messageId", "inReplyTo", "references", "hasAttachment", "preview", "size", "bodyStructure", "textBody", "htmlBody", "attachments", "bodyValues", "header:List-Unsubscribe:asURLs"];
const BODY_PROPS = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid", "subParts"];
export const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const PAGE = 40;

function fail(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const person = a => ({ name: (a?.name || "").trim(), email: (a?.email || "").trim().toLowerCase() });
const people = list => (Array.isArray(list) ? list.map(person).filter(p => p.email) : []);

function binOf(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return bin;
}

export class Mail {
  /**
   * @param {{ account: import("./account.js").Account, jmap: import("./jmap.js").Jmap, pgp: import("./mailpgp.js").MailPgp }} deps
   */
  constructor({ account, jmap, pgp }) {
    this.account = account;
    this.jmap = jmap;
    this.pgp = pgp;
    this.boxes = null; // [{ id, role, name, total, unread, parentId }]
    this.state = ""; // состояние папок на сервере: по нему видно, что пришло новое
    this._identities = null;
    this._inner = new Map(); // id письма → расшифрованная часть (байтовая строка): для вложений
  }

  /* ---- папки ---- */

  async folders({ refresh = false } = {}) {
    if (this.boxes && !refresh) {
      return this.boxes;
    }
    const [r] = await this.jmap.call([["Mailbox/get", { ids: null, properties: ["id", "name", "role", "totalEmails", "unreadEmails", "totalThreads", "unreadThreads", "parentId", "sortOrder"] }]]);
    this.state = r.state || "";
    const boxes = r.list.map(m => {
      const role = m.role || (/^archive$/i.test(m.name) ? "archive" : /^(junk|spam)/i.test(m.name) ? "junk" : "");
      return { id: m.id, role, name: ROLE_NAMES[role] || m.name, total: m.totalEmails || 0, unread: m.unreadThreads ?? m.unreadEmails ?? 0, parentId: m.parentId || null, order: m.sortOrder || 0 };
    });
    // у каждой служебной роли одна папка: первая по порядку сервера
    const seen = new Set();
    for (const b of boxes) {
      if (b.role && seen.has(b.role)) {
        b.role = "";
      }
      seen.add(b.role);
    }
    boxes.sort((a, b) => {
      const ia = a.role ? ROLE_ORDER.indexOf(a.role) : 99;
      const ib = b.role ? ROLE_ORDER.indexOf(b.role) : 99;
      return ia - ib || a.order - b.order || a.name.localeCompare(b.name);
    });
    this.boxes = boxes;
    return boxes;
  }

  box(role) {
    return (this.boxes || []).find(b => b.role === role) || null;
  }

  boxById(id) {
    return (this.boxes || []).find(b => b.id === id) || null;
  }

  /** Изменилось ли что-то в ящике с последнего чтения папок (новые письма, отметки с другого устройства). */
  async changed() {
    const before = this.state;
    await this.folders({ refresh: true });
    return before !== this.state;
  }

  /* ---- списки ---- */

  _filter({ folderId, view = "all", query = "" }) {
    const conditions = [];
    if (folderId === "starred") {
      conditions.push({ hasKeyword: "$flagged" });
    } else if (folderId && !query) {
      conditions.push({ inMailbox: folderId });
    }
    if (query) {
      conditions.push({ text: query });
      // поиск идёт по всей почте, кроме корзины и спама (если искали не прямо в них)
      const skip = ["trash", "junk"].map(r => this.box(r)?.id).filter(id => id && id !== folderId);
      const here = this.boxById(folderId);
      if (here && ["trash", "junk"].includes(here.role)) {
        conditions.push({ inMailbox: folderId });
      } else if (skip.length) {
        conditions.push({ inMailboxOtherThan: skip });
      }
    }
    if (view === "unread") {
      conditions.push({ notKeyword: "$seen" });
    } else if (view === "starred") {
      conditions.push({ hasKeyword: "$flagged" });
    } else if (view === "files") {
      conditions.push({ hasAttachment: true });
    }
    return conditions.length === 1 ? conditions[0] : { operator: "AND", conditions };
  }

  /** Страница списка переписок: { items, total, position }. */
  async list({ folderId, view = "all", query = "", position = 0, limit = PAGE }) {
    await this.folders();
    const filter = this._filter({ folderId, view, query });
    const ref = (i, name, path) => ({ resultOf: `c${i}`, name, path });
    const [q, g, , all] = await this.jmap.call([
      ["Email/query", { filter, sort: [{ property: "receivedAt", isAscending: false }], collapseThreads: true, position, limit, calculateTotal: true }],
      ["Email/get", { "#ids": ref(0, "Email/query", "/ids"), properties: LIST_PROPS }],
      ["Thread/get", { "#ids": ref(1, "Email/get", "/list/*/threadId") }],
      ["Email/get", { "#ids": ref(2, "Thread/get", "/list/*/emailIds"), properties: THREAD_PROPS }],
    ]);
    const trash = this.box("trash")?.id;
    const byThread = new Map();
    for (const e of all.list) {
      if (trash && e.mailboxIds?.[trash] && folderId !== trash) {
        continue; // удалённые письма переписки в счёт не идут
      }
      const cur = byThread.get(e.threadId) || { count: 0, unread: false, starred: false, ids: [], senders: new Map() };
      cur.count++;
      cur.unread ||= !e.keywords?.$seen && !e.keywords?.$draft;
      cur.starred ||= !!e.keywords?.$flagged;
      cur.ids.push(e.id);
      for (const f of people(e.from)) {
        cur.senders.set(f.email, f);
      }
      byThread.set(e.threadId, cur);
    }
    const byId = new Map(g.list.map(e => [e.id, e]));
    const items = q.ids.map(id => byId.get(id)).filter(Boolean).map(e => {
      const th = byThread.get(e.threadId) || { count: 1, unread: !e.keywords?.$seen, starred: !!e.keywords?.$flagged, ids: [e.id], senders: new Map() };
      return {
        id: e.id, threadId: e.threadId, subject: (e.subject || "").trim() || t`(без темы)`, from: people(e.from)[0] || { name: "", email: "" }, to: people(e.to),
        date: e.receivedAt, preview: (e.preview || "").trim(), hasAttachment: !!e.hasAttachment, draft: !!e.keywords?.$draft, answered: !!e.keywords?.$answered,
        unread: th.unread, starred: th.starred, count: Math.max(1, th.count), ids: th.ids.length ? th.ids : [e.id], mailboxIds: Object.keys(e.mailboxIds || {}),
      };
    });
    return { items, total: q.total ?? items.length, position: q.position ?? position };
  }

  /* ---- письмо и переписка ---- */

  _pgpKind(e) {
    const s = e.bodyStructure;
    if (s?.type === "multipart/encrypted" && s.subParts?.some(p => p.type === "application/pgp-encrypted")) {
      return "encrypted";
    }
    if (s?.type === "multipart/signed" && s.subParts?.some(p => p.type === "application/pgp-signature")) {
      return "signed";
    }
    return "";
  }

  _message(e) {
    const value = part => (part && e.bodyValues?.[part.partId]?.value) || "";
    const htmlPart = (e.htmlBody || []).find(p => p.type === "text/html");
    const text = (e.textBody || []).filter(p => p.type === "text/plain").map(value).join("\n\n");
    const html = htmlPart ? value(htmlPart) : "";
    const truncated = Object.values(e.bodyValues || {}).some(v => v.isTruncated);
    const files = (e.attachments || []).map(a => ({ name: a.name || t`вложение`, type: (a.type || "application/octet-stream").toLowerCase(), size: a.size || 0, blobId: a.blobId, cid: (a.cid || "").replace(/^<|>$/g, "").toLowerCase(), disposition: a.disposition || "" }));
    // картинка, на которую ссылается вёрстка (cid:…), — часть письма, а не вложение
    const used = new Set();
    if (html) {
      for (const m of html.matchAll(/cid:([^"'\s)>]+)/gi)) {
        used.add(decodeURIComponent(m[1]).toLowerCase());
      }
    }
    const inline = {};
    const attachments = [];
    for (const f of files) {
      if (f.cid && used.has(f.cid) && f.type.startsWith("image/")) {
        inline[f.cid] = { type: f.type, blobId: f.blobId, name: f.name };
      } else {
        attachments.push(f);
      }
    }
    const from = people(e.from)[0] || { name: t`Неизвестный отправитель`, email: "" };
    return {
      id: e.id, blobId: e.blobId, threadId: e.threadId, mailboxIds: Object.keys(e.mailboxIds || {}), subject: (e.subject || "").trim() || t`(без темы)`,
      from, to: people(e.to), cc: people(e.cc), bcc: people(e.bcc), replyTo: people(e.replyTo)[0]?.email || "",
      date: e.receivedAt || e.sentAt, messageId: (e.messageId || [])[0] || "", inReplyTo: (e.inReplyTo || [])[0] || "", references: e.references || [],
      unread: !e.keywords?.$seen, starred: !!e.keywords?.$flagged, draft: !!e.keywords?.$draft, answered: !!e.keywords?.$answered,
      text, html, truncated, attachments, inline, newsletter: !!e["header:List-Unsubscribe:asURLs"],
      pgp: null, code: findCode(e.subject || "", text) || null, preview: (e.preview || "").trim(), size: e.size || 0,
    };
  }

  /** Письма переписки, старые сверху. Зашифрованные расшифровываются, подписи проверяются. */
  async thread(threadId) {
    await this.folders();
    const [, g] = await this.jmap.call([
      ["Thread/get", { ids: [threadId] }],
      ["Email/get", { "#ids": { resultOf: "c0", name: "Thread/get", path: "/list/*/emailIds" }, properties: FULL_PROPS, bodyProperties: BODY_PROPS, fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1_500_000 }],
    ]);
    const out = [];
    for (const e of g.list) {
      const m = this._message(e);
      const kind = this._pgpKind(e) || (m.text.includes("-----BEGIN PGP MESSAGE-----") ? "inline" : "");
      if (kind) {
        await this._openPgp(m, kind);
      }
      out.push(m);
    }
    out.sort((a, b) => new Date(a.date) - new Date(b.date));
    return out;
  }

  async message(id) {
    const [g] = await this.jmap.call([["Email/get", { ids: [id], properties: FULL_PROPS, bodyProperties: BODY_PROPS, fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1_500_000 }]]);
    const e = g.list[0];
    if (!e) {
      throw fail(t`Письмо не найдено: возможно, его удалили на другом устройстве`, "not-found");
    }
    const m = this._message(e);
    const kind = this._pgpKind(e) || (m.text.includes("-----BEGIN PGP MESSAGE-----") ? "inline" : "");
    if (kind) {
      await this._openPgp(m, kind);
    }
    return m;
  }

  _sender(m) {
    const mine = m.draft || m.mailboxIds.includes(this.box("sent")?.id);
    return mine ? this.account.email : m.from.email;
  }

  /** Письмо OpenPGP: расшифровать или проверить подпись по исходнику с сервера. */
  async _openPgp(m, kind) {
    try {
      const raw = binOf(await this.jmap.download(m.blobId, { name: "message.eml", type: "message/rfc822" }));
      const parsed = parseMessage(raw);
      if (!parsed.pgp) {
        return;
      }
      if (parsed.pgp.kind === "signed") {
        const sig = await this.pgp.verify(bytesOf(parsed.pgp.data), parsed.pgp.signature, this._sender(m));
        m.pgp = { signature: sig.state, signer: sig.address || "" };
        return;
      }
      const { bytes, signature } = await this.pgp.decrypt(parsed.pgp.armored, { from: this._sender(m) });
      const inner = binOf(bytes);
      const part = parsed.pgp.kind === "inline" ? { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), html: "", attachments: [], inline: {}, pgp: null } : parseEntity(inner);
      let sig = signature;
      if (part.pgp?.kind === "signed" && sig.state === "none") {
        sig = await this.pgp.verify(bytesOf(part.pgp.data), part.pgp.signature, this._sender(m)); // подпись отдельным слоем под шифрованием
      }
      m.text = part.text;
      m.html = part.html;
      m.attachments = part.attachments.map(a => ({ name: a.name, type: a.type, size: a.size, section: a.section, encoding: a.encoding, inner: true }));
      m.inline = Object.fromEntries(Object.entries(part.inline || {}).map(([cid, v]) => [cid, { type: v.type, data: v.data }]));
      m.code = findCode(m.subject, m.text) || null;
      m.pgp = { encrypted: true, signature: sig.state, signer: sig.address || "" };
      m.preview = m.text.replace(/\s+/g, " ").trim().slice(0, 200);
      this._inner.set(m.id, inner);
      if (this._inner.size > 30) {
        this._inner.delete(this._inner.keys().next().value);
      }
    } catch (e) {
      if (kind === "signed") {
        m.pgp = { signature: "unknown", signer: "" };
        return;
      }
      const error = e.code === "no-key" ? "no-key" : e.code === "locked" ? "locked" : "failed";
      m.pgp = { encrypted: true, error };
      m.text = "";
      m.html = "";
      m.attachments = [];
      m.preview = t`Зашифрованное письмо`;
    }
  }

  /** Байты вложения: с сервера или из расшифрованной части письма. */
  async attachment(m, a) {
    if (a.bytes) {
      return a.bytes;
    }
    if (a.inner) {
      const inner = this._inner.get(m.id);
      const part = inner && findSection(inner, a.section);
      if (!part) {
        throw fail(t`Вложение не найдено: откройте письмо заново`, "download");
      }
      return decodeAttachment(part.bin, part.encoding);
    }
    return this.jmap.download(a.blobId, { name: a.name, type: a.type });
  }

  /* ---- отметки и перемещение ---- */

  async _update(ids, patch) {
    if (!ids.length) {
      return;
    }
    const [r] = await this.jmap.call([["Email/set", { update: Object.fromEntries(ids.map(id => [id, patch])) }]]);
    const bad = Object.values(r.notUpdated || {})[0];
    if (bad && bad.type !== "notFound") {
      throw fail(bad.description || t`Почтовый сервер не принял изменение`, bad.type || "mail-error");
    }
  }

  setSeen(ids, seen) {
    return this._update(ids, { "keywords/$seen": seen ? true : null });
  }

  setStar(ids, on) {
    return this._update(ids, { "keywords/$flagged": on ? true : null });
  }

  /** Перенести письма в папку (id папки или роль: "archive", "trash", "junk", "inbox"). */
  async move(ids, target) {
    const box = this.boxById(target) || this.box(target);
    if (!box) {
      throw fail(t`Такой папки нет`, "not-found");
    }
    await this._update(ids, { mailboxIds: { [box.id]: true }, ...(box.role === "junk" ? { "keywords/$junk": true } : {}), ...(box.role === "inbox" ? { "keywords/$junk": null } : {}) });
  }

  /** Удалить: в корзину; из корзины и черновиков — насовсем. */
  async remove(ids, { forever = false } = {}) {
    if (!ids.length) {
      return;
    }
    if (forever || !this.box("trash")) {
      const [r] = await this.jmap.call([["Email/set", { destroy: ids }]]);
      const bad = Object.values(r.notDestroyed || {})[0];
      if (bad && bad.type !== "notFound") {
        throw fail(bad.description || t`Почтовый сервер не удалил письмо`, bad.type || "mail-error");
      }
      return;
    }
    await this.move(ids, "trash");
  }

  /* ---- отправка ---- */

  async identities() {
    if (!this._identities) {
      const [r] = await this.jmap.call([["Identity/get", { ids: null }]]);
      this._identities = r.list.map(i => ({ id: i.id, email: (i.email || "").toLowerCase(), name: i.name || "" }));
    }
    return this._identities;
  }

  async _identity(email) {
    const list = await this.identities();
    const hit = list.find(i => i.email === email);
    if (hit) {
      return hit.id;
    }
    // у алиаса своей записи отправителя ещё нет: заводим
    try {
      const [r] = await this.jmap.call([["Identity/set", { create: { i: { email, name: "" } } }]]);
      const id = r.created?.i?.id;
      if (id) {
        list.push({ id, email, name: "" });
        return id;
      }
    } catch (e) {}
    const main = list.find(i => i.email === this.account.email) || list[0];
    if (!main) {
      throw fail(t`Почтовый сервер не дал отправить письмо с этого адреса`, "mail-error");
    }
    return main.id;
  }

  /** Исходник письма: { raw (Uint8Array), messageId, encrypted }. */
  async _build({ from, name = "", to, cc = [], subject, text, html = "", attachments = [], inReplyTo = "", references = [], encrypt = false, selfOnly = false }) {
    const total = attachments.reduce((n, a) => n + a.bytes.length, 0);
    if (total > MAX_ATTACH_BYTES) {
      throw fail(t`Вложения больше 20 МБ не отправятся: уберите часть файлов`, "too-large");
    }
    const keyed = from === this.account.email;
    if (encrypt && !keyed) {
      throw fail(t`Зашифровать можно только письмо с основного адреса аккаунта`, "pgp");
    }
    let entity = buildEntity({ text, html, attachments });
    const extraHeaders = [];
    if (keyed && this.pgp.ready) {
      const autocrypt = await this.pgp.autocryptHeader();
      if (autocrypt) {
        extraHeaders.push(foldHeader("Autocrypt", autocrypt));
      }
    }
    if (encrypt) {
      entity = encryptedEntity(await this.pgp.encrypt(bytesOf(entity), selfOnly ? [from] : [...to, ...cc]));
    }
    const built = buildMessage({ from: { name, email: from }, to, cc, subject: subject || t`(без темы)`, entity, extraHeaders, inReplyTo, references: references.filter(Boolean).slice(-10) });
    return { raw: bytesOf(built.raw), messageId: built.messageId, encrypted: !!encrypt };
  }

  async _import(raw, { draft }) {
    const box = this.box("drafts") || this.box("inbox");
    const { blobId } = await this.jmap.upload(raw, "message/rfc822");
    const [r] = await this.jmap.call([["Email/import", { emails: { m: { blobId, mailboxIds: { [box.id]: true }, keywords: { $seen: true, ...(draft ? { $draft: true } : {}) } } } }]]);
    const id = r.created?.m?.id;
    if (!id) {
      const why = r.notCreated?.m;
      throw fail(why?.description || t`Почтовый сервер не принял письмо`, why?.type || "mail-error");
    }
    return id;
  }

  /**
   * Отправить письмо. to, cc, bcc — адреса; attachments — [{ name, type, bytes }]; encrypt — шифровать
   * (возможно, когда у всех получателей есть ключ: см. plan); original — письмо, на которое отвечают;
   * draftId — черновик, из которого письмо выросло (удаляется после отправки).
   */
  async send({ from = this.account.email, name = "", to, cc = [], bcc = [], subject = "", text = "", html = "", attachments = [], original = null, encrypt = false, draftId = "" }) {
    await this.folders();
    const rcpt = [...new Set([...to, ...cc, ...bcc].map(a => a.trim().toLowerCase()).filter(Boolean))];
    if (!rcpt.length) {
      throw fail(t`Укажите получателя`, "no-recipients");
    }
    if (encrypt && bcc.length) {
      throw fail(t`Зашифрованное письмо нельзя отправить со скрытой копией: уберите её или отправьте без шифрования`, "pgp");
    }
    const built = await this._build({ from, name, to, cc, subject, text, html, attachments, encrypt, inReplyTo: original?.messageId || "", references: original ? [...(original.references || []), original.messageId] : [] });
    const emailId = await this._import(built.raw, { draft: true });
    const identityId = await this._identity(from);
    const drafts = this.box("drafts")?.id;
    const sent = this.box("sent")?.id;
    const move = {};
    if (drafts) {
      move[`mailboxIds/${drafts}`] = null;
    }
    if (sent) {
      move[`mailboxIds/${sent}`] = true;
    }
    move["keywords/$draft"] = null;
    let r;
    try {
      [r] = await this.jmap.call([["EmailSubmission/set", { create: { s: { emailId, identityId, envelope: { mailFrom: { email: from }, rcptTo: rcpt.map(email => ({ email })) } } }, onSuccessUpdateEmail: { "#s": move } }]], { timeout: 60000 });
    } catch (e) {
      await this.remove([emailId], { forever: true }).catch(() => {});
      throw e;
    }
    if (!r.created?.s) {
      const why = r.notCreated?.s;
      await this.remove([emailId], { forever: true }).catch(() => {});
      const text2 = why?.type === "forbiddenFrom" || why?.type === "forbiddenMailFrom" ? t`С этого адреса отправлять нельзя` : why?.type === "invalidRecipients" || why?.type === "noRecipients" ? t`Сервер не принял адрес получателя: проверьте его` : why?.type === "tooLarge" ? t`Письмо слишком большое` : why?.description || t`Почтовый сервер не принял письмо к отправке`;
      throw fail(text2, why?.type || "mail-error");
    }
    const after = [];
    if (original?.id) {
      after.push(this._update([original.id], { "keywords/$answered": true }).catch(() => {}));
    }
    if (draftId) {
      after.push(this.remove([draftId], { forever: true }).catch(() => {}));
    }
    await Promise.all(after);
    return { id: emailId, messageId: built.messageId, encrypted: built.encrypted };
  }

  /** Сохранить черновик (прежний с номером replaces удаляется). Возвращает номер нового. */
  async saveDraft({ from = this.account.email, to = [], cc = [], subject = "", text = "", html = "", attachments = [], original = null, replaces = "" }) {
    await this.folders();
    const encrypt = from === this.account.email && this.pgp.ready;
    const built = await this._build({ from, to, cc, subject, text, html, attachments, encrypt, selfOnly: true, inReplyTo: original?.messageId || "", references: original ? [...(original.references || []), original.messageId] : [] });
    const id = await this._import(built.raw, { draft: true });
    if (replaces) {
      await this.remove([replaces], { forever: true }).catch(() => {});
    }
    return id;
  }

  /** Можно ли зашифровать письмо этим получателям: { available, possible, missing }. */
  async plan(from, recipients) {
    if (from !== this.account.email || !this.pgp.ready) {
      return { available: false, possible: false, missing: [] };
    }
    return { available: true, ...(await this.pgp.plan(recipients)) };
  }
}

export { utf8 };
