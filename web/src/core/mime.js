/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Письма: разбор исходника (заголовки, кодировки, части, вложения) и сборка письма к отправке.
 * Код перенесён без изменений из src/browser/base/content/tabora/mail/net/Mime.sys.mjs
 * (tools/web/test/parity.mjs сверяет оба файла): письмо, собранное здесь, устроено так же, как
 * письмо из браузера Tabora, и разбирается теми же правилами.
 *
 * Исходник письма — байтовая строка (один символ = один байт), как его отдаёт сервер. */

/* ---- байты и кодировки ---- */

export function bytesOf(bin) {
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    u[i] = bin.charCodeAt(i) & 0xff;
  }
  return u;
}

export function utf8Bytes(s) {
  const u = new TextEncoder().encode(String(s));
  let out = "";
  for (let i = 0; i < u.length; i += 8192) {
    out += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  }
  return out;
}

function decodeBytes(bin, charset) {
  const label = String(charset || "utf-8").trim().toLowerCase().replace(/^["']|["']$/g, "");
  let decoder;
  try {
    decoder = new TextDecoder(label === "us-ascii" || label === "ascii" || label === "unknown-8bit" ? "utf-8" : label);
  } catch (e) {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytesOf(bin));
}

/** Заголовок без encoded-words, но с байтами вне ASCII: UTF-8, а если это не он — windows-1251. */
function headerText(bin) {
  if (!/[\x80-\xff]/.test(bin)) {
    return bin;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytesOf(bin));
  } catch (e) {
    return new TextDecoder("windows-1251").decode(bytesOf(bin));
  }
}

function decodeBase64(bin) {
  let clean = bin.replace(/[^A-Za-z0-9+/]/g, "");
  if (clean.length % 4 === 1) {
    clean = clean.slice(0, -1); // обрезанное письмо: неполный последний знак
  }
  try {
    return atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  } catch (e) {
    return "";
  }
}

function decodeQuotedPrintable(bin) {
  return bin.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeTransfer(bin, encoding) {
  const cte = String(encoding || "").trim().toLowerCase();
  return cte === "base64" ? decodeBase64(bin) : cte === "quoted-printable" ? decodeQuotedPrintable(bin) : bin;
}

/** =?кодировка?B|Q?текст?= → текст. Пробелы между соседними словами не считаются. */
export function decodeWords(value) {
  const s = headerText(String(value || ""));
  return s
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?)/g, "$1")
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (whole, charset, enc, text) => {
      try {
        const bin = enc.toUpperCase() === "B" ? decodeBase64(text) : text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
        return decodeBytes(bin, charset.split("*")[0]);
      } catch (e) {
        return whole;
      }
    });
}

/* ---- заголовки ---- */

function splitHeaderBody(raw) {
  let i = raw.indexOf("\r\n\r\n");
  let sep = 4;
  const j = raw.indexOf("\n\n");
  if (i < 0 || (j >= 0 && j < i)) {
    i = j;
    sep = 2;
  }
  if (raw.startsWith("\r\n")) {
    return ["", raw.slice(2)];
  }
  return i < 0 ? [raw, ""] : [raw.slice(0, i), raw.slice(i + sep)];
}

function parseHeaders(block) {
  const map = new Map();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) {
      continue;
    }
    const name = line.slice(0, i).trim().toLowerCase();
    const list = map.get(name) || [];
    list.push(line.slice(i + 1).trim());
    map.set(name, list);
  }
  return map;
}

const first = (headers, name) => headers.get(name)?.[0] || "";

/** «text/plain; charset="utf-8"; name*=UTF-8''%D0%B0.txt» → { value, params }. */
function parseParams(headerValue) {
  const parts = [];
  let cur = "";
  let quoted = false;
  for (const ch of String(headerValue || "")) {
    if (ch === '"') {
      quoted = !quoted;
    }
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const value = parts.shift().trim().toLowerCase();
  const plain = {};
  const pieces = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i <= 0) {
      continue;
    }
    let key = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    // RFC 2231: name*=кодировка'язык'%XX и name*0*, name*1…
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (m) {
      const list = (pieces[m[1]] ||= []);
      list.push({ n: Number(m[2] || 0), encoded: !!m[3] || m[2] === undefined, val });
    } else {
      plain[key] = decodeWords(val);
    }
  }
  for (const [key, list] of Object.entries(pieces)) {
    list.sort((a, b) => a.n - b.n);
    let charset = "utf-8";
    let bin = "";
    list.forEach((piece, index) => {
      let v = piece.val;
      if (piece.encoded) {
        if (index === 0) {
          const q = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (q) {
            charset = q[1] || "utf-8";
            v = q[2];
          }
        }
        v = v.replace(/%([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
      }
      bin += v;
    });
    plain[key] = decodeBytes(bin, charset);
  }
  return { value, params: plain };
}

/** «Имя <a@b.c>, "Иванов, Иван" <i@x.y>» → [{ name, email }]. */
export function parseAddresses(value) {
  const out = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  const push = () => {
    const raw = cur.trim();
    cur = "";
    if (!raw) {
      return;
    }
    let m = /^(.*)<([^<>]*)>\s*$/.exec(raw);
    let name = "";
    let email = "";
    if (m) {
      name = m[1];
      email = m[2];
    } else {
      m = /\(([^)]*)\)/.exec(raw);
      name = m ? m[1] : "";
      email = raw.replace(/\([^)]*\)/g, "");
    }
    email = email.trim().replace(/^mailto:/i, "");
    name = decodeWords(name.trim()).replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
    if (/^[^\s@<>]+@[^\s@<>]+$/.test(email)) {
      out.push({ name: name || email.split("@")[0], email: email.toLowerCase() });
    }
  };
  for (const ch of String(value || "")) {
    if (ch === '"' && !paren) {
      quoted = !quoted;
    } else if (!quoted) {
      if (ch === "<") {
        angle++;
      } else if (ch === ">") {
        angle = Math.max(0, angle - 1);
      } else if (ch === "(") {
        paren++;
      } else if (ch === ")") {
        paren = Math.max(0, paren - 1);
      } else if ((ch === "," || ch === ";") && !angle && !paren) {
        push();
        continue;
      }
    }
    cur += ch;
  }
  push();
  return out;
}

const msgIds = value => (String(value || "").match(/<[^<>\s]+>/g) || []).map(s => s.slice(1, -1));

/* ---- части письма ---- */

function splitMultipart(body, boundary) {
  const mark = `\n--${boundary}`;
  const text = `\n${body}`;
  const parts = [];
  let pos = text.indexOf(mark);
  while (pos >= 0) {
    const after = pos + mark.length;
    if (text.startsWith("--", after)) {
      break; // закрывающая граница
    }
    const lineEnd = text.indexOf("\n", after);
    if (lineEnd < 0) {
      break;
    }
    const next = text.indexOf(mark, lineEnd);
    const chunk = next < 0 ? text.slice(lineEnd + 1) : text.slice(lineEnd + 1, next);
    parts.push(chunk.replace(/\r$/, ""));
    pos = next;
  }
  return parts;
}

function defaultName(type) {
  const ext = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "text/calendar": "ics", "application/zip": "zip", "message/rfc822": "eml" }[type];
  return ext ? `вложение.${ext}` : "вложение";
}

const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function walk(raw, out, section, depth) {
  const [head, body] = splitHeaderBody(raw);
  const headers = parseHeaders(head);
  const ct = parseParams(first(headers, "content-type") || "text/plain");
  const cd = parseParams(first(headers, "content-disposition"));
  const cte = first(headers, "content-transfer-encoding");
  if (ct.value.startsWith("multipart/") && ct.params.boundary && depth < 10) {
    const parts = splitMultipart(body, ct.params.boundary);
    const protocol = String(ct.params.protocol || "").toLowerCase();
    // PGP/MIME (RFC 3156) на верхнем уровне письма: вторая часть — зашифрованное письмо или подпись
    if (depth === 0 && parts.length >= 2 && (ct.value === "multipart/encrypted" || ct.value === "multipart/signed")) {
      const [head2, body2] = splitHeaderBody(parts[1]);
      const second = decodeTransfer(body2, first(parseHeaders(head2), "content-transfer-encoding")).trim();
      if (ct.value === "multipart/encrypted" && protocol === "application/pgp-encrypted" && second.includes("-----BEGIN PGP MESSAGE-----")) {
        out.pgp = { kind: "encrypted", armored: second };
        return;
      }
      if (ct.value === "multipart/signed" && protocol === "application/pgp-signature" && second.includes("-----BEGIN PGP SIGNATURE-----")) {
        // подписана первая часть ровно в том виде, в каком пришла, с концами строк CRLF
        out.pgp = { kind: "signed", data: parts[0].replace(/\r?\n/g, "\r\n"), signature: second };
        walk(parts[0], out, section ? `${section}.1` : "1", depth + 1);
        return;
      }
    }
    parts.forEach((part, i) => walk(part, out, section ? `${section}.${i + 1}` : String(i + 1), depth + 1));
    return;
  }
  const name = cd.params.filename || ct.params.name || "";
  const isText = ct.value === "text/plain" || ct.value === "text/html";
  const attached = cd.value === "attachment" || !isText || (!!name && cd.value !== "inline");
  if (!attached) {
    const text = decodeBytes(decodeTransfer(body, cte), ct.params.charset);
    if (ct.value === "text/plain") {
      out.text = out.text ? `${out.text}\n\n${text}` : text;
    } else if (!out.html) {
      out.html = text;
    }
    return;
  }
  // Картинка, на которую разметка письма ссылается как cid:…: при показе с вёрсткой она
  // подставляется прямо из письма (MailView.embedInline), сети для этого не нужно.
  const cid = first(headers, "content-id").trim().replace(/^<|>$/g, "").toLowerCase();
  if (cid && INLINE_IMAGES.has(ct.value) && cte.trim().toLowerCase() === "base64") {
    const data = body.replace(/[^A-Za-z0-9+/=]/g, "");
    if (data.length % 4 === 0 && data.length <= 400_000 && out.inlineSize + data.length <= 1_500_000) {
      out.inline[cid] = { type: ct.value, data };
      out.inlineSize += data.length;
    }
  }
  if (cd.value === "inline" && ct.value.startsWith("image/") && headers.has("content-id")) {
    out.images++; // картинка внутри текста письма: вложением не считается
    return;
  }
  const enc = cte.trim().toLowerCase();
  const size = enc === "base64" ? Math.floor((body.replace(/[^A-Za-z0-9+/]/g, "").length * 3) / 4) : body.length;
  out.attachments.push({ name: name || defaultName(ct.value), type: ct.value, size, section: section || "1", encoding: enc || "7bit" });
}

/** Зашифрованный блок прямо в тексте письма (без PGP/MIME): так пишут старые программы. */
function inlinePgp(out) {
  if (!out.pgp && out.text.includes("-----BEGIN PGP MESSAGE-----")) {
    const m = /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/.exec(out.text);
    if (m) {
      out.pgp = { kind: "inline", armored: m[0] };
    }
  }
}

/** Разбор одной части письма (заголовки Content-* и тело): так выглядит расшифрованное
 * содержимое PGP/MIME. Возвращает { text, html, attachments, images, pgp }. */
export function parseEntity(raw) {
  const out = { text: "", html: "", attachments: [], images: 0, pgp: null, inline: {}, inlineSize: 0 };
  walk(raw, out, "", 0);
  inlinePgp(out);
  return out;
}

/** Часть письма по номеру секции, как его считает parseMessage: { bin, encoding, type, name }
 * или null. Нужна вложениям внутри расшифрованного письма: сервер их по номеру не отдаст. */
export function findSection(raw, target, section = "", depth = 0) {
  const [head, body] = splitHeaderBody(raw);
  const headers = parseHeaders(head);
  const ct = parseParams(first(headers, "content-type") || "text/plain");
  if (ct.value.startsWith("multipart/") && ct.params.boundary && depth < 10) {
    const parts = splitMultipart(body, ct.params.boundary);
    for (let i = 0; i < parts.length; i++) {
      const found = findSection(parts[i], target, section ? `${section}.${i + 1}` : String(i + 1), depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if ((section || "1") !== target) {
    return null;
  }
  const cd = parseParams(first(headers, "content-disposition"));
  return { bin: body, encoding: first(headers, "content-transfer-encoding").trim().toLowerCase() || "7bit", type: ct.value, name: cd.params.filename || ct.params.name || "" };
}

/** Разбор исходника письма (возможно, обрезанного после первых N байт). */
export function parseMessage(raw) {
  const [head] = splitHeaderBody(raw);
  const headers = parseHeaders(head);
  const out = { text: "", html: "", attachments: [], images: 0, pgp: null, inline: {}, inlineSize: 0 };
  walk(raw, out, "", 0);
  inlinePgp(out);
  // ключ отправителя: заголовок Autocrypt действителен, только если он в письме один
  const autocrypt = headers.get("autocrypt") || [];
  const from = parseAddresses(first(headers, "from"))[0] || { name: "Неизвестный отправитель", email: "" };
  const date = new Date(first(headers, "date"));
  const delivered = (headers.get("delivered-to") || []).concat(headers.get("x-original-to") || []).map(s => s.trim().toLowerCase()).filter(s => s.includes("@"));
  return {
    messageId: msgIds(first(headers, "message-id"))[0] || "",
    inReplyTo: msgIds(first(headers, "in-reply-to"))[0] || "",
    references: msgIds(first(headers, "references")),
    subject: decodeWords(first(headers, "subject")).replace(/\s+/g, " ").trim(),
    from,
    to: parseAddresses(first(headers, "to")).map(a => a.email),
    cc: parseAddresses(first(headers, "cc")).map(a => a.email),
    replyTo: parseAddresses(first(headers, "reply-to"))[0]?.email || "",
    deliveredTo: delivered,
    date: Number.isNaN(date.getTime()) ? null : date.toISOString(),
    newsletter: headers.has("list-unsubscribe") || headers.has("list-id") || /bulk|list/i.test(first(headers, "precedence")),
    text: out.text,
    html: out.html,
    inline: out.inline,
    attachments: out.attachments,
    images: out.images,
    pgp: out.pgp,
    autocrypt: autocrypt.length === 1 ? autocrypt[0] : "",
  };
}

/** Содержимое вложения из байтов секции (ImapClient.fetchSection) → Uint8Array. */
export function decodeAttachment(bin, encoding) {
  return bytesOf(decodeTransfer(bin, encoding));
}

/* ---- тело письма → блоки ---- */

const SKIP = new Set(["script", "style", "head", "title", "meta", "link", "noscript", "template", "svg", "object", "embed", "iframe", "form", "input", "button", "select", "textarea", "video", "audio", "canvas", "map"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "ul", "ol", "li", "dl", "dt", "dd", "pre", "center", "address", "figure", "figcaption", "hr"]);
const HIDDEN = /display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0(?:px)?\s*(?:;|$)|font-size\s*:\s*0(?:px)?\s*(?:;|$)|opacity\s*:\s*0\s*(?:;|$)|mso-hide\s*:\s*all/i;
const FINE = /unsubscribe|отписа|отказаться от рассыл|©|\(c\)\s*\d{4}|all rights reserved|все права защищены|privacy policy|политик[аи] конфиденциальности|you (?:are )?receiv|вы получили это письмо|view (?:this )?(?:email )?in (?:your )?browser|открыть в браузере/i;
const MAX_BLOCKS = 400;

function safeHref(href) {
  const s = String(href || "").trim();
  if (/^https?:\/\//i.test(s) && s.length <= 2000) {
    try {
      return new URL(s).href;
    } catch (e) {}
  }
  if (/^mailto:[^\s]+@[^\s]+$/i.test(s) && s.length <= 320) {
    return s;
  }
  return null;
}

const squash = s => s.replace(/[ \t\u00a0\u200b\u200c\u200d\ufeff]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function makeBlock(kind, runs) {
  // соседние куски с одной ссылкой (или без неё) склеиваются
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (last.href || null) === (r.href || null)) {
      last.t += r.t;
    } else {
      merged.push({ ...r });
    }
  }
  const text = squash(merged.map(r => r.t).join(""));
  if (!text) {
    return null;
  }
  const links = merged.filter(r => r.href && r.t.trim());
  if (kind === "p" && links.length === 1 && squash(links[0].t) === text && text.length <= 60) {
    return { btn: text, href: links[0].href }; // вся строка — одна короткая ссылка: кнопка
  }
  const block = { [kind]: text.slice(0, 6000) };
  if (links.length && kind !== "h") {
    block.runs = merged.map(r => (r.href ? { t: r.t.replace(/\s+/g, " "), href: r.href } : r.t.replace(/[ \t\u00a0]+/g, " "))).filter(r => (typeof r === "string" ? r : r.t));
  }
  return block;
}

function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(html.slice(0, 600_000), "text/html");
  const blocks = [];
  let runs = [];
  const flush = (kind = "p") => {
    const b = makeBlock(kind, runs);
    runs = [];
    if (b && blocks.length < MAX_BLOCKS) {
      blocks.push(b);
    }
  };
  const visit = (node, href) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = child.nodeValue.replace(/\s+/g, " ");
        if (t) {
          runs.push({ t, href });
        }
        continue;
      }
      if (child.nodeType !== 1) {
        continue;
      }
      const tag = child.localName;
      if (SKIP.has(tag) || child.hasAttribute("hidden") || child.getAttribute("aria-hidden") === "true" || HIDDEN.test(child.getAttribute("style") || "")) {
        continue;
      }
      if (tag === "br") {
        runs.push({ t: "\n", href: null });
      } else if (tag === "img") {
        // картинки не загружаются; подпись показываем, только если она что-то сообщает
        const alt = (child.getAttribute("alt") || "").trim();
        if (alt.length > 2 && href) {
          runs.push({ t: alt, href });
        }
      } else if (tag === "a") {
        visit(child, safeHref(child.getAttribute("href")) || href);
      } else if (/^h[1-6]$/.test(tag)) {
        flush();
        visit(child, href);
        flush("h");
      } else if (tag === "blockquote") {
        flush();
        visit(child, href);
        flush("q");
      } else if (BLOCK.has(tag)) {
        flush();
        visit(child, href);
        flush();
      } else {
        visit(child, href);
      }
    }
  };
  if (doc.body) {
    visit(doc.body, null);
    flush();
  }
  return blocks;
}

const URL_RE = /https?:\/\/[^\s<>"'()\[\]{}]+[^\s<>"'()\[\]{}.,;:!?]/g;

function textToBlocks(text) {
  const blocks = [];
  let signature = false;
  for (const para of String(text).replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = para.split("\n");
    if (lines[0] === "-- " || lines[0] === "--") {
      signature = true;
      lines.shift();
    }
    const body = lines.join("\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
    if (!body.trim()) {
      continue;
    }
    const quoted = lines.every(l => /^\s*>/.test(l) || !l.trim());
    const clean = quoted ? lines.map(l => l.replace(/^\s*>+ ?/, "")).join("\n") : body;
    const kind = signature || FINE.test(clean.slice(0, 400)) ? "fine" : quoted ? "q" : "p";
    const block = { [kind]: clean.slice(0, 6000) };
    if (kind === "p") {
      const runs = [];
      let at = 0;
      for (const m of clean.matchAll(URL_RE)) {
        const href = safeHref(m[0]);
        if (!href) {
          continue;
        }
        if (m.index > at) {
          runs.push(clean.slice(at, m.index));
        }
        runs.push({ t: m[0], href });
        at = m.index + m[0].length;
      }
      if (runs.length) {
        if (at < clean.length) {
          runs.push(clean.slice(at));
        }
        block.runs = runs;
      }
    }
    blocks.push(block);
    if (blocks.length >= MAX_BLOCKS) {
      break;
    }
  }
  return blocks;
}

/* Код подтверждения. Ошибка здесь заметнее пропуска: номер заказа, показанный как код, хуже
 * письма без карточки кода. Поэтому кодом считается только отдельно стоящее число, о котором
 * рядом сказано, что это код. */

// слова о коде; только целиком («кодировка» и «shipping» не подходят)
const CODE_WORD = "(?<![\\p{L}\\p{N}_-])(?:код(?:а|у|ом|е|ы)?|пин(?:-код(?:а|у|ом|е)?)?|парол(?:ь|я|ю|ем|е)|одноразов\\p{L}*|code|passcode|password|pin|otp)(?![\\p{L}\\p{N}_])";
// рядом со словом о коде сказано, что это номер чего-то другого
const CODE_NOT = /заказ|товар|город|стран|подраздел|купон|скидк|промо|отслежив|трек|бронир|индекс|почтов|артикул|ошибк|order|product|promo|discount|coupon|voucher|tracking|zip|postal|area|country|booking|reference|invoice|error|item|sku|№|#/iu;
// 4–8 цифр подряд или две группы по три-четыре цифры через пробел либо дефис; не часть слова,
// адреса, телефона, суммы, даты, дроби, более длинного числа
const CODE_NUMBER = /(?<![\p{L}\p{N}_+#№$€£₽@.,/\\=-])(?<!\d[ -])(\d{3,4}[ -]\d{3,4}|\d{4,8})(?![\p{L}\p{N}_]|[.,:/-]\d|[ -]\d|\s?(?:₽|руб|р\.|\$|€|£|usd|eur|%))/giu;
// любое отдельно стоящее число: между словом о коде и самим кодом такого быть не должно
const LOOSE_NUMBER = /(?<![\p{L}\p{N}_@.+-])\d+(?![\p{L}\p{N}_@])/u;

/** Код подтверждения из темы и текста письма либо null. Слово о коде стоит перед числом (не
 * дальше 80 знаков и двух строк) или сразу после него в той же строке: «123456 — ваш код». */
export function findCode(subject, text) {
  const hay = `${subject || ""}\n${String(text || "").slice(0, 3000)}`;
  for (const m of hay.matchAll(CODE_NUMBER)) {
    const digits = m[1].replace(/\D/g, "");
    if (digits.length < 4 || digits.length > 8 || /^(19|20)\d\d$/.test(digits)) {
      continue;
    }
    const before = hay.slice(Math.max(0, m.index - 110), m.index);
    let word = null;
    for (const w of before.matchAll(new RegExp(CODE_WORD, "giu"))) {
      word = w;
    }
    let found = false;
    if (word) {
      const gap = before.slice(word.index + word[0].length);
      found = gap.length <= 80 && !LOOSE_NUMBER.test(gap) && (gap.match(/\n/g) || []).length <= 2 && !CODE_NOT.test(before.slice(Math.max(0, word.index - 30)));
    }
    if (!found) {
      const after = hay.slice(m.index + m[0].length, m.index + m[0].length + 60).split("\n")[0];
      const w = new RegExp(CODE_WORD, "iu").exec(after);
      found = !!w && w.index <= 40 && !LOOSE_NUMBER.test(after.slice(0, w.index)) && !CODE_NOT.test(after.slice(0, w.index + w[0].length + 20)) && !CODE_NOT.test(before.slice(-30));
    }
    if (found) {
      return m[1].replace(/-/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

/** Тело разобранного письма → { body: блоки, snippet, code }. */
export function toBlocks(parsed) {
  let blocks = [];
  if (parsed.html && parsed.html.replace(/<[^>]*>/g, "").trim().length >= 20) {
    try {
      blocks = htmlToBlocks(parsed.html);
    } catch (e) {
      console.error("Tabora mail: разметка письма не разобрана", e);
    }
  }
  if (!blocks.length && parsed.text) {
    blocks = textToBlocks(parsed.text);
  }
  if (!blocks.length && parsed.html) {
    blocks = textToBlocks(parsed.html.replace(/<[^>]*>/g, " "));
  }
  // хвост письма с отпиской и копирайтом — мелким текстом
  for (let i = blocks.length - 1, seen = 0; i >= 0 && seen < 6; i--, seen++) {
    const b = blocks[i];
    if (b.p && FINE.test(b.p)) {
      blocks[i] = { fine: b.p, ...(b.runs ? { runs: b.runs } : {}) };
    }
  }
  const flat = blocks.map(b => b.h || b.p || b.q || b.btn || "").filter(Boolean).join("\n");
  const code = findCode(parsed.subject, parsed.text || flat);
  if (code) {
    // блок, состоящий из одного кода, показывается крупно
    const digits = code.replace(/\D/g, "");
    const at = blocks.findIndex(b => typeof b.p === "string" && b.p.replace(/\D/g, "") === digits && b.p.length <= 14);
    if (at >= 0) {
      blocks[at] = { code };
    }
  }
  const snippet = (blocks.find(b => b.p) || blocks.find(b => b.h) || {});
  return { body: blocks, snippet: String(snippet.p || snippet.h || "").replace(/\s+/g, " ").slice(0, 200), code };
}

/* ---- сборка письма ---- */

function encodeWord(text) {
  if (!/[^\x20-\x7e]/.test(text)) {
    return text;
  }
  // по 45 байт UTF-8 на слово, не разрывая символ
  const words = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of text) {
    const n = utf8Bytes(ch).length;
    if (bytes + n > 45) {
      words.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) {
    words.push(chunk);
  }
  return words.map(w => `=?UTF-8?B?${btoa(utf8Bytes(w))}?=`).join("\r\n ");
}

function addressHeader({ name, email }) {
  if (!name || name === email) {
    return email;
  }
  const shown = /[^\x20-\x7e]/.test(name) ? encodeWord(name) : /[",<>()@:;\\\[\]]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
  return `${shown} <${email}>`;
}

function quotedPrintable(bin) {
  const out = [];
  for (const rawLine of bin.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    let cur = "";
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      const last = i === line.length - 1;
      const piece = c === 61 || c < 32 || c > 126 || ((c === 32 || c === 9) && last) ? `=${c.toString(16).toUpperCase().padStart(2, "0")}` : line[i];
      if (cur.length + piece.length > 75) {
        out.push(`${cur}=`);
        cur = "";
      }
      cur += piece;
    }
    out.push(cur);
  }
  return out.join("\r\n");
}

function rfcDate(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = n => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function newMessageId(domain) {
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  return `${rnd}@${String(domain || "localhost").replace(/[^a-z0-9.-]/gi, "")}`;
}

const TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ics: "text/calendar", json: "application/json", mp4: "video/mp4", mp3: "audio/mpeg", eml: "message/rfc822" };

function base64Lines(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8190) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8190));
  }
  return btoa(bin).replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

function attachmentPart({ name, type, bytes }) {
  const clean = String(name || "файл").replace(/[\r\n"\\/]/g, "_").slice(0, 180);
  const ext = clean.includes(".") ? clean.split(".").pop().toLowerCase() : "";
  const ctype = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type || "") ? type : TYPES[ext] || "application/octet-stream";
  const ascii = /^[\x20-\x7e]+$/.test(clean);
  const star = `UTF-8''${Array.from(utf8Bytes(clean), c => (/[A-Za-z0-9._-]/.test(c) ? c : `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)).join("")}`;
  return [
    `Content-Type: ${ctype}; name="${ascii ? clean : encodeWord(clean).replace(/\r\n /g, " ")}"`,
    `Content-Disposition: attachment; ${ascii ? `filename="${clean}"` : `filename*=${star}`}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(bytes),
  ].join("\r\n");
}

const newBoundary = () => `tabora-${Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("")}`;

/** Содержимое письма как часть MIME: заголовки Content-* и тело. Текст (UTF-8), необязательная
 * разметка html (тогда письмо несёт оба вида, multipart/alternative: программа получателя
 * покажет оформленный, а не умеющая — текстовый) и вложения [{ name, type?, bytes: Uint8Array }].
 * Именно эта часть шифруется в PGP/MIME. html — готовое содержимое письма (см. RichText.clean). */
export function buildEntity({ text = "", html = "", attachments = [] }) {
  const part = (type, content) =>
    `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(utf8Bytes(String(content).replace(/\r\n?/g, "\n")))}`;
  let content = part("text/plain", text);
  if (html) {
    const boundary = newBoundary();
    const page = `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>${html}</body></html>`;
    content = `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${part("text/plain", text)}\r\n--${boundary}\r\n${part("text/html", page)}\r\n--${boundary}--`;
  }
  if (!attachments.length) {
    return `${content}\r\n`;
  }
  const boundary = newBoundary();
  const parts = [content, ...attachments.map(attachmentPart)];
  return `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.map(p => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
}

/** Зашифрованное содержимое в виде PGP/MIME (RFC 3156): armored — броня OpenPGP. */
export function encryptedEntity(armored) {
  const boundary = newBoundary();
  return [
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: application/pgp-encrypted",
    "Content-Description: PGP/MIME version identification",
    "",
    "Version: 1",
    "",
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    "Content-Description: OpenPGP encrypted message",
    'Content-Disposition: inline; filename="encrypted.asc"',
    "",
    String(armored).trim().replace(/\r?\n/g, "\r\n"),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Длинный заголовок складывается в несколько строк: продолжение начинается с пробела. Слова
 * длиннее строки (Base64 ключа в Autocrypt) режутся; пробелы внутри такого значения допустимы. */
export function foldHeader(name, value) {
  const lines = [];
  let line = `${name}:`;
  for (const word of String(value).split(/\s+/).filter(Boolean)) {
    for (const piece of word.length > 72 ? word.match(/.{1,72}/g) : [word]) {
      if (line.length + 1 + piece.length > 76 && line.trim()) {
        lines.push(line);
        line = "";
      }
      line = `${line} ${piece}`;
    }
  }
  lines.push(line);
  return lines.join("\r\n");
}

/** Письмо к отправке. Содержимое — либо text и attachments, либо готовая часть entity (например,
 * зашифрованная); extraHeaders — готовые строки дополнительных заголовков.
 * Возвращает { raw, messageId }. */
export function buildMessage({ from, to = [], cc = [], subject = "", text = "", messageId = "", inReplyTo = "", references = [], date = new Date(), attachments = [], entity = "", extraHeaders = [] }) {
  const id = messageId || newMessageId(from.email.split("@")[1]);
  const headers = [
    `From: ${addressHeader(from)}`,
    `To: ${to.join(", ")}`,
    cc.length ? `Cc: ${cc.join(", ")}` : null,
    `Subject: ${encodeWord(String(subject).replace(/[\r\n]+/g, " "))}`,
    `Date: ${rfcDate(date)}`,
    `Message-ID: <${id}>`,
    inReplyTo ? `In-Reply-To: <${inReplyTo}>` : null,
    references.length ? `References: ${references.map(r => `<${r}>`).join("\r\n ")}` : null,
    ...extraHeaders,
    "MIME-Version: 1.0",
  ].filter(Boolean);
  return { raw: `${headers.join("\r\n")}\r\n${entity || buildEntity({ text, attachments })}`, messageId: id };
}
