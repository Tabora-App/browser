/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Клиент IMAP4rev1 — ровно то, чем пользуется почта Tabora: вход, список папок с их ролями,
 * окно последних писем папки, флаги, перенос, добавление, удаление. Один клиент — одно
 * соединение, команды идут строго по очереди (вызывающий не запускает их параллельно).
 * Строки протокола — байтовые (один символ = один байт); имена папок передаются серверу
 * в том виде, в каком он их прислал, для показа декодируются decodeMailboxName(). */

import { MailSocket } from "chrome://tabora/content/mail/net/Socket.sys.mjs";

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

function utf8Bytes(s) {
  const u = new TextEncoder().encode(String(s));
  let out = "";
  for (let i = 0; i < u.length; i += 8192) {
    out += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  }
  return out;
}

function fail(text, code = "protocol", extra = {}) {
  return Object.assign(new Error(text), { code, ...extra });
}

function quote(s) {
  return `"${String(s).replace(/([\\"])/g, "\\$1")}"`;
}

/** Имя папки из «изменённого UTF-7» (RFC 3501, 5.1.3) в обычный текст. */
export function decodeMailboxName(s) {
  return String(s).replace(/&([^-]*)-/g, (whole, b64) => {
    if (!b64) {
      return "&";
    }
    try {
      const bin = atob(b64.replace(/,/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
      let out = "";
      for (let i = 0; i + 1 < bin.length; i += 2) {
        out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
      }
      return out;
    } catch (e) {
      return whole;
    }
  });
}

/** Разбор ответа сервера в дерево: списки — массивы, NIL — null, строки и литералы — строки. */
export function parseTokens(chunks) {
  const out = [];
  const stack = [out];
  for (const chunk of chunks) {
    if (typeof chunk !== "string") {
      stack[stack.length - 1].push(chunk.literal);
      continue;
    }
    const s = chunk;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === " ") {
        i++;
      } else if (c === "(") {
        const list = [];
        stack[stack.length - 1].push(list);
        stack.push(list);
        i++;
      } else if (c === ")") {
        if (stack.length > 1) {
          stack.pop();
        }
        i++;
      } else if (c === '"') {
        let j = i + 1;
        let str = "";
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\" && j + 1 < s.length) {
            j++;
          }
          str += s[j];
          j++;
        }
        stack[stack.length - 1].push(str);
        i = j + 1;
      } else {
        // атом; секция в квадратных скобках (BODY[HEADER.FIELDS (FROM)]) — его часть
        let j = i;
        let depth = 0;
        while (j < s.length) {
          const d = s[j];
          if (d === "[") {
            depth++;
          } else if (d === "]") {
            depth = Math.max(0, depth - 1);
          } else if (depth === 0 && (d === " " || d === "(" || d === ")")) {
            break;
          }
          j++;
        }
        const atom = s.slice(i, j);
        stack[stack.length - 1].push(atom.toUpperCase() === "NIL" ? null : atom);
        i = j;
      }
    }
  }
  return out;
}

const ROLE_FLAGS = { "\\sent": "sent", "\\drafts": "drafts", "\\trash": "trash", "\\junk": "spam", "\\archive": "archive", "\\all": "all", "\\flagged": "flagged" };
const ROLE_NAMES = [
  [/^(sent|sent items|sent messages|sent mail|отправленные)$/i, "sent"],
  [/^(drafts?|черновики)$/i, "drafts"],
  [/^(trash|deleted items|deleted messages|bin|корзина|удал[её]нные)$/i, "trash"],
  [/^(junk|spam|junk mail|junk e-?mail|bulk mail|спам)$/i, "spam"],
  [/^(archive|archives|архив)$/i, "archive"],
];

export class ImapClient {
  constructor(sock) {
    this.sock = sock;
    this._tag = 0;
    this.caps = new Set();
    this.selected = null;
  }

  /** server: { host, port, security }; auth: { login, password }. */
  static async connect(server, auth) {
    const security = server.security || (Number(server.port) === 143 ? "starttls" : "tls");
    const sock = await MailSocket.connect(server.host, Number(server.port), { security });
    const client = new ImapClient(sock);
    try {
      const greeting = await sock.readLine();
      if (!/^\* (OK|PREAUTH)/i.test(greeting)) {
        throw fail(/^\* BYE/i.test(greeting) ? `Сервер ${server.host} отказал в соединении` : `Сервер ${server.host} не похож на сервер IMAP: проверьте адрес и порт`);
      }
      client._noteCaps(greeting);
      if (security === "starttls") {
        if (!client.caps.size) {
          await client._capability();
        }
        if (!client.caps.has("STARTTLS")) {
          throw fail(`Сервер ${server.host} не предлагает защищённое соединение на этом порту`, "tls");
        }
        await client.cmd("STARTTLS");
        sock.startTLS();
        client.caps.clear();
      }
      if (!client.caps.size) {
        await client._capability();
      }
      await client._login(auth.login, auth.password);
      return client;
    } catch (e) {
      sock.close();
      throw e;
    }
  }

  _noteCaps(text) {
    const m = /\[CAPABILITY ([^\]]+)\]/i.exec(text) || /^\* CAPABILITY (.+)$/i.exec(text);
    if (m) {
      this.caps = new Set(m[1].trim().toUpperCase().split(/\s+/));
    }
  }

  async _capability() {
    const r = await this.cmd("CAPABILITY");
    for (const u of r.untagged) {
      this._noteCaps(typeof u[0] === "string" ? u[0] : "");
    }
  }

  async _login(login, password) {
    const before = this.caps;
    try {
      if (this.caps.has("AUTH=PLAIN")) {
        const token = btoa(`\0${utf8Bytes(login)}\0${utf8Bytes(password)}`);
        if (this.caps.has("SASL-IR")) {
          await this.cmd(`AUTHENTICATE PLAIN ${token}`);
        } else {
          await this.cmd("AUTHENTICATE PLAIN", { onContinue: () => token });
        }
      } else if (!this.caps.has("LOGINDISABLED")) {
        await this.cmd(`LOGIN ${quote(utf8Bytes(login))} ${quote(utf8Bytes(password))}`);
      } else {
        throw fail("Сервер не принимает вход по паролю", "auth");
      }
    } catch (e) {
      if (e.code === "no" || e.code === "bad") {
        // ответ сервера (например, у Gmail — требование пароля приложения) передаётся наверх
        throw fail("Сервер не принял логин или пароль", "auth", { server: e.server || "" });
      }
      throw e;
    }
    if (this.caps === before) {
      await this._capability(); // после входа список возможностей обычно шире
    }
  }

  async _readResponse(timeoutMs) {
    const chunks = [];
    let line = await this.sock.readLine(timeoutMs);
    for (;;) {
      const m = /\{(\d+)\}$/.exec(line);
      if (!m) {
        chunks.push(line);
        return chunks;
      }
      chunks.push(line.slice(0, m.index));
      chunks.push({ literal: await this.sock.readExact(Number(m[1]), timeoutMs) });
      line = await this.sock.readLine(timeoutMs);
    }
  }

  /** Команда и её ответ: { untagged: [[куски…]], text }. onContinue(текст) → строка-продолжение. */
  async cmd(text, { onContinue = null, timeoutMs } = {}) {
    const tag = `T${++this._tag}`;
    await this.sock.write(`${tag} ${text}\r\n`);
    const untagged = [];
    for (;;) {
      const chunks = await this._readResponse(timeoutMs);
      const head = typeof chunks[0] === "string" ? chunks[0] : "";
      if (head.startsWith("+")) {
        if (!onContinue) {
          throw fail("Сервер ждёт продолжения команды, которого нет");
        }
        await this.sock.write(`${await onContinue(head.slice(1).trim())}\r\n`);
      } else if (head.startsWith(`${tag} `)) {
        const m = /^(OK|NO|BAD)\b\s*(.*)$/i.exec(head.slice(tag.length + 1)) || ["", "BAD", head];
        this._noteCaps(m[2]);
        if (m[1].toUpperCase() !== "OK") {
          throw fail(`Сервер отклонил команду: ${m[2] || m[1]}`, m[1].toUpperCase() === "NO" ? "no" : "bad", { server: m[2] });
        }
        return { untagged, text: m[2] };
      } else if (head.startsWith("* ")) {
        if (/^\* BYE/i.test(head) && !/^LOGOUT/i.test(text)) {
          throw fail("Сервер закрыл соединение", "network");
        }
        untagged.push(chunks);
      }
    }
  }

  /** Папки: [{ path, name, delim, role, noselect }]. role: inbox, sent, drafts, trash, spam, archive, all, flagged или null. */
  async list() {
    const r = await this.cmd('LIST "" "*"');
    const out = [];
    for (const u of r.untagged) {
      const t = parseTokens(u);
      if (t[1]?.toUpperCase?.() !== "LIST" || !Array.isArray(t[2])) {
        continue;
      }
      const flags = t[2].map(f => String(f).toLowerCase());
      const path = String(t[4] ?? "");
      const delim = t[3] || "/";
      const leaf = decodeMailboxName(path.split(delim).pop());
      let role = path.toUpperCase() === "INBOX" ? "inbox" : null;
      for (const f of flags) {
        role ||= ROLE_FLAGS[f] || null;
      }
      if (!role) {
        role = ROLE_NAMES.find(([re]) => re.test(leaf))?.[1] || null;
      }
      out.push({ path, name: decodeMailboxName(path), delim, role, noselect: flags.includes("\\noselect") || flags.includes("\\nonexistent") });
    }
    return out;
  }

  /** Открыть папку: { exists, uidValidity, uidNext }. */
  async select(path) {
    const r = await this.cmd(`SELECT ${quote(path)}`);
    const info = { path, exists: 0, uidValidity: 0, uidNext: 0 };
    for (const u of r.untagged) {
      const head = typeof u[0] === "string" ? u[0] : "";
      let m;
      if ((m = /^\* (\d+) EXISTS/i.exec(head))) {
        info.exists = Number(m[1]);
      } else if ((m = /\[UIDVALIDITY (\d+)\]/i.exec(head))) {
        info.uidValidity = Number(m[1]);
      } else if ((m = /\[UIDNEXT (\d+)\]/i.exec(head))) {
        info.uidNext = Number(m[1]);
      }
    }
    this.selected = info;
    return info;
  }

  _fetchItems(untagged) {
    const out = [];
    for (const u of untagged) {
      const t = parseTokens(u);
      if (t[2]?.toUpperCase?.() !== "FETCH" || !Array.isArray(t[3])) {
        continue;
      }
      const item = { seq: Number(t[1]) };
      const kv = t[3];
      for (let i = 0; i + 1 < kv.length; i += 2) {
        const key = String(kv[i]).toUpperCase();
        const value = kv[i + 1];
        if (key === "UID") {
          item.uid = Number(value);
        } else if (key === "FLAGS") {
          item.flags = (value || []).map(f => String(f));
        } else if (key === "INTERNALDATE") {
          item.date = value;
        } else if (key === "RFC822.SIZE") {
          item.size = Number(value);
        } else if (key.startsWith("BODY[")) {
          item.raw = value || "";
        }
      }
      if (item.uid) {
        out.push(item);
      }
    }
    return out;
  }

  /** Последние count писем открытой папки: [{ uid, flags }] по возрастанию uid. */
  async window(count) {
    const exists = this.selected?.exists || 0;
    if (!exists) {
      return [];
    }
    const from = Math.max(1, exists - count + 1);
    const r = await this.cmd(`FETCH ${from}:* (UID FLAGS)`);
    return this._fetchItems(r.untagged).sort((a, b) => a.uid - b.uid);
  }

  /** Письма по uid: флаги, дата, размер и первые maxBytes байт исходника (BODY.PEEK — без пометки «прочитано»). */
  async fetch(uids, { maxBytes = 0 } = {}) {
    if (!uids.length) {
      return [];
    }
    const body = maxBytes ? `BODY.PEEK[]<0.${maxBytes}>` : "BODY.PEEK[]";
    const r = await this.cmd(`UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE ${body})`, { timeoutMs: 180_000 });
    return this._fetchItems(r.untagged);
  }

  /** Часть письма целиком по номеру секции (для вложений): байтовая строка в исходной кодировке части. */
  async fetchSection(uid, section) {
    const r = await this.cmd(`UID FETCH ${uid} (UID BODY.PEEK[${section}])`, { timeoutMs: 300_000 });
    return this._fetchItems(r.untagged)[0]?.raw || "";
  }

  async setFlags(uids, flags, add) {
    if (uids.length && flags.length) {
      await this.cmd(`UID STORE ${uids.join(",")} ${add ? "+" : "-"}FLAGS.SILENT (${flags.join(" ")})`);
    }
  }

  /** Перенос в другую папку. Возвращает { uidValidity, map: { старый uid: новый } }, если сервер сообщил. */
  async move(uids, destPath) {
    if (!uids.length) {
      return null;
    }
    const set = uids.join(",");
    const copyuid = r => {
      const text = [r.text, ...r.untagged.map(u => (typeof u[0] === "string" ? u[0] : ""))].join(" ");
      const m = /\[COPYUID (\d+) ([\d,:]+) ([\d,:]+)\]/i.exec(text);
      if (!m) {
        return null;
      }
      const expand = s => s.split(",").flatMap(p => {
        const [a, b] = p.split(":").map(Number);
        return b ? Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i) : [a];
      });
      const src = expand(m[2]);
      const dst = expand(m[3]);
      return { uidValidity: Number(m[1]), map: Object.fromEntries(src.map((u, i) => [u, dst[i]])) };
    };
    if (this.caps.has("MOVE")) {
      return copyuid(await this.cmd(`UID MOVE ${set} ${quote(destPath)}`));
    }
    const res = copyuid(await this.cmd(`UID COPY ${set} ${quote(destPath)}`));
    await this.cmd(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
    await this.cmd(this.caps.has("UIDPLUS") ? `UID EXPUNGE ${set}` : "EXPUNGE");
    return res;
  }

  /** Удаление навсегда. */
  async destroy(uids) {
    if (!uids.length) {
      return;
    }
    const set = uids.join(",");
    await this.cmd(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
    await this.cmd(this.caps.has("UIDPLUS") ? `UID EXPUNGE ${set}` : "EXPUNGE");
  }

  /** Добавить письмо в папку (например, отправленное — в «Отправленные»). raw — байтовая строка. */
  async append(path, raw, flags = []) {
    const head = `APPEND ${quote(path)} (${flags.join(" ")})`;
    if (this.caps.has("LITERAL+")) {
      await this.cmd(`${head} {${raw.length}+}\r\n${raw}`, { timeoutMs: 300_000 });
    } else {
      await this.cmd(`${head} {${raw.length}}`, { onContinue: () => raw, timeoutMs: 300_000 });
    }
  }

  async create(path) {
    await this.cmd(`CREATE ${quote(path)}`);
  }

  /** Умеет ли сервер сообщать о новых письмах сам (IDLE, RFC 2177). */
  get canIdle() {
    return this.caps.has("IDLE");
  }

  /** Ждать изменений открытой папки, не опрашивая сервер: команда IDLE держит соединение, а
   * сервер пишет в него, когда что-то произошло. Возвращает "exists" (пришло письмо), "changed"
   * (пометки или удаление — письмо прочитали в другой программе), "timeout" (за maxMs ничего:
   * ожидание пора возобновить, пока соединение не закрыли по простою) или "stopped" (stopIdle).
   * Соединение на это время занято: другие команды по нему не идут. */
  async idle({ maxMs = 8 * 60_000 } = {}) {
    const tag = `T${++this._tag}`;
    let reason = "timeout";
    let done = false;
    const finish = why => {
      if (!done) {
        done = true;
        reason = why;
        this.sock.write("DONE\r\n").catch(() => {});
      }
    };
    await this.sock.write(`${tag} IDLE\r\n`);
    const timer = setTimeout(() => finish("timeout"), maxMs);
    this._idleStop = () => finish("stopped");
    try {
      for (;;) {
        const chunks = await this._readResponse(maxMs + 30_000);
        const head = typeof chunks[0] === "string" ? chunks[0] : "";
        if (head.startsWith(`${tag} `)) {
          const m = /^(OK|NO|BAD)\b\s*(.*)$/i.exec(head.slice(tag.length + 1)) || ["", "BAD", head];
          if (m[1].toUpperCase() !== "OK") {
            throw fail(`Сервер отклонил ожидание писем: ${m[2] || m[1]}`, "no", { server: m[2] });
          }
          return reason;
        }
        if (/^\* BYE/i.test(head)) {
          throw fail("Сервер закрыл соединение", "network");
        }
        const m = /^\* (\d+) (EXISTS|EXPUNGE|FETCH)\b/i.exec(head);
        if (m && !done) {
          if (m[2].toUpperCase() === "EXISTS") {
            const count = Number(m[1]);
            const grew = count > (this.selected?.exists ?? 0);
            if (this.selected) {
              this.selected.exists = count;
            }
            finish(grew ? "exists" : "changed");
          } else {
            finish("changed");
          }
        }
      }
    } finally {
      clearTimeout(timer);
      this._idleStop = null;
    }
  }

  /** Прервать ожидание idle(): оно вернёт "stopped". */
  stopIdle() {
    this._idleStop?.();
  }

  async logout() {
    try {
      await this.cmd("LOGOUT", { timeoutMs: 5000 });
    } catch (e) {}
    this.sock.close();
  }

  close() {
    this.sock.close();
  }
}
