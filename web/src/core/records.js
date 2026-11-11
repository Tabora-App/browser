/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Записи синхронизации в том виде, в каком их понимает браузер Tabora (sync/SyncSources.sys.mjs).
 * Здесь — создание и проверка записей: запись, которую браузер сочтёт неверной, он молча
 * пропустит, поэтому веб-версия проверяет её до отправки.
 *
 *   logins  пароль сайта   { g, o, f, r, u, p, uf, pf, c, t }
 *   otp     код входа      { i, a, s, al, d, p, w: [{ host, sub }], c }
 *   marks   закладка       { p, k: 1 закладка | 2 папка | 3 разделитель, n, u?, ch?, c, t }
 *   tabs    вкладки устройства { name, at, tabs: [{ t, u, p? }] } */

import { randomId, uuid } from "./bytes.js";
import { base32Decode, base32Encode, hotp } from "./otp.js";

function fail(message, code = "invalid") {
  return Object.assign(new Error(message), { code });
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/* ---- пароли сайтов ---- */

/** Адрес сайта из того, что набрал человек: «github.com/login» → «https://github.com». */
export function originOf(input) {
  let s = String(input || "").trim();
  if (!s) {
    throw fail("Укажите сайт");
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  let url;
  try {
    url = new URL(s);
  } catch (e) {
    throw fail("Не похоже на адрес сайта");
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || !/^[^\s.]+(\.[^\s.]+)+$|^localhost$/.test(url.hostname)) {
    throw fail("Не похоже на адрес сайта");
  }
  return url.origin;
}

export function hostOf(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch (e) {
    return String(origin || "");
  }
}

export function loginId(guid) {
  const m = /^\{([0-9a-fA-F-]{36})\}$/.exec(guid || "");
  const id = m ? m[1] : guid;
  return /^[A-Za-z0-9_-]{1,64}$/.test(id || "") ? id : "";
}

export function loginValid(id, d) {
  return (
    !!d && typeof d.o === "string" && /^[a-z][a-z0-9+.-]*:\/\/[^\s]{1,300}$/i.test(d.o) && typeof d.u === "string" && d.u.length <= 512 &&
    typeof d.p === "string" && d.p.length >= 1 && d.p.length <= 4096 && (d.f === null || typeof d.f === "string") && (d.r === null || typeof d.r === "string") &&
    (d.f === null) !== (d.r === null) && loginId(d.g) === id
  );
}

/** Новая запись пароля: { id, data }. */
export function newLogin({ site, username, password }) {
  const o = originOf(site);
  const now = Date.now();
  const id = uuid();
  const data = { g: `{${id}}`, o, f: "", r: null, u: str(String(username || "").trim(), 512), p: String(password || ""), uf: "", pf: "", c: now, t: now };
  if (!data.p) {
    throw fail("Введите пароль");
  }
  if (!loginValid(id, data)) {
    throw fail("Запись не сохранена: слишком длинное имя или пароль");
  }
  return { id, data };
}

/** Изменённая запись: сайт, имя и пароль меняются, остальное сохраняется. */
export function editLogin(id, old, { site, username, password }) {
  const o = originOf(site);
  const data = { ...old, o, u: str(String(username || "").trim(), 512), p: String(password || "") };
  if (o !== old.o && old.f !== null && old.f !== "") {
    data.f = ""; // сайт другой: прежний адрес формы к нему не относится
  }
  if (data.p !== old.p) {
    data.t = Date.now();
  }
  if (!data.p) {
    throw fail("Введите пароль");
  }
  if (!loginValid(id, data)) {
    throw fail("Запись не сохранена: слишком длинное имя или пароль");
  }
  return data;
}

/** Случайный пароль: буквы обоих регистров, цифры и знаки, без похожих символов. */
export function generatePassword(length = 20, { symbols = true } = {}) {
  const sets = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", ...(symbols ? ["!#$%&*+-=?@^_"] : [])];
  const all = sets.join("");
  const pick = set => {
    // без смещения: значения сверх кратного размеру набора отбрасываются
    const limit = 256 - (256 % set.length);
    for (;;) {
      const [b] = crypto.getRandomValues(new Uint8Array(1));
      if (b < limit) {
        return set[b % set.length];
      }
    }
  };
  const n = Math.max(sets.length, Math.min(64, length));
  const out = sets.map(pick);
  while (out.length < n) {
    out.push(pick(all));
  }
  for (let i = out.length - 1; i > 0; i--) {
    const limit = 256 - (256 % (i + 1));
    let b;
    do {
      [b] = crypto.getRandomValues(new Uint8Array(1));
    } while (b >= limit);
    const j = b % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

/* ---- коды входа ---- */

export function normalizeHost(raw) {
  let host = String(raw || "").trim().toLowerCase();
  if (!host) {
    return "";
  }
  try {
    host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch (e) {
    return "";
  }
  host = host.replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : "";
}

export function normalizeSites(list) {
  const out = new Map();
  for (const raw of Array.isArray(list) ? list : String(list || "").split(/[\s,;]+/)) {
    const item = raw && typeof raw === "object" ? raw : { host: raw, sub: false };
    const host = normalizeHost(item.host);
    if (host) {
      out.set(host, { host, sub: !!item.sub || !!out.get(host)?.sub });
    }
  }
  return [...out.values()].slice(0, 8);
}

function guessSites(issuer) {
  const s = String(issuer || "").trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? normalizeSites([s]) : [];
}

const clean = (v, max) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);

/** Новая запись кода: { id, data }. Секрет — Base32, как его показывают сайты. */
export async function newOtp({ issuer, account, secret, algorithm = "SHA1", digits = 6, period = 30, sites = null }) {
  const al = String(algorithm || "SHA1").toUpperCase();
  const d = Number(digits || 6);
  const p = Number(period || 30);
  if (!["SHA1", "SHA256", "SHA512"].includes(al) || ![6, 7, 8].includes(d) || !(p >= 15 && p <= 120)) {
    throw fail("Такие параметры кода не поддерживаются");
  }
  let bytes;
  try {
    bytes = base32Decode(secret);
  } catch (e) {
    throw fail("Секрет введён с ошибкой: в нём только латинские буквы и цифры 2–7");
  }
  if (bytes.length < 8) {
    throw fail("Секрет слишком короткий");
  }
  await hotp(bytes, 0, { algorithm: al, digits: d });
  const i = clean(issuer, 48);
  const a = clean(account, 96);
  if (!i && !a) {
    throw fail("Укажите сервис или аккаунт");
  }
  const id = `o${Date.now().toString(36)}${randomId(6).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 5)}`;
  return { id, data: { i, a, s: base32Encode(bytes), al, d, p, w: sites ? normalizeSites(sites) : guessSites(i), c: new Date().toISOString() } };
}

export function otpValid(d) {
  return !!d && typeof d.s === "string" && d.s.length >= 13 && ["SHA1", "SHA256", "SHA512"].includes(d.al) && [6, 7, 8].includes(d.d) && d.p >= 15 && d.p <= 120;
}

/* ---- закладки ---- */

export const MARK_ROOTS = { menu: "menu________", toolbar: "toolbar_____", unfiled: "unfiled_____", mobile: "mobile______" };
export const ROOT_NAMES = { [MARK_ROOTS.toolbar]: "Панель закладок", [MARK_ROOTS.menu]: "Меню закладок", [MARK_ROOTS.unfiled]: "Другие закладки", [MARK_ROOTS.mobile]: "С телефона" };

/** Номер закладки: 12 знаков, как у хранилища закладок браузера. */
export function markId() {
  return randomId(9).slice(0, 12);
}

export function markUrl(input) {
  let s = String(input || "").trim();
  if (!s) {
    throw fail("Укажите адрес страницы");
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    s = `https://${s}`;
  }
  let url;
  try {
    url = new URL(s);
  } catch (e) {
    throw fail("Не похоже на адрес страницы");
  }
  if (!/^https?:$/.test(url.protocol) || url.href.length > 16384) {
    throw fail("Закладка может вести только на страницу http или https");
  }
  return url.href;
}

/** Дерево закладок из записей: корни в порядке показа, у папок children в порядке ch. */
export function marksTree(list) {
  const byId = new Map(list.map(it => [it.id, { id: it.id, ...it.data, children: [] }]));
  const placed = new Set();
  for (const node of byId.values()) {
    if (node.k === 2 && Array.isArray(node.ch)) {
      for (const cid of node.ch) {
        const child = byId.get(cid);
        if (child && !placed.has(cid) && child.p === node.id) {
          node.children.push(child);
          placed.add(cid);
        }
      }
    }
  }
  // запись, которой нет в списке детей своей папки (порядок ещё не доехал): в конец папки
  for (const node of byId.values()) {
    if (!node.root && !placed.has(node.id) && byId.get(node.p)?.k === 2) {
      byId.get(node.p).children.push(node);
      placed.add(node.id);
    }
  }
  return [MARK_ROOTS.toolbar, MARK_ROOTS.menu, MARK_ROOTS.unfiled, MARK_ROOTS.mobile].map(id => byId.get(id) || { id, k: 2, root: true, ch: [], children: [] }).map(r => ({ ...r, n: ROOT_NAMES[r.id] }));
}

/* Изменения закладок считаются по текущим записям набора (list: [{ id, data }]) и уходят на сервер
 * одним запросом: порядок детей хранит папка, поэтому вместе с закладкой меняется её папка. */

function marksIndex(list) {
  return new Map(list.map(it => [it.id, it.data]));
}

function parentRecord(byId, parentId) {
  const cur = byId.get(parentId);
  if (cur) {
    return { ...cur, ch: Array.isArray(cur.ch) ? [...cur.ch] : [] };
  }
  if (Object.values(MARK_ROOTS).includes(parentId)) {
    return { k: 2, root: true, ch: [] }; // корень, порядок которого ещё не уходил на сервер
  }
  throw fail("Папка не найдена: обновите список");
}

/** Новая закладка (url) или папка (без url) в папке parentId: [{ c, id, data }]. */
export function marksAdd(list, parentId, { title, url = "" }) {
  const byId = marksIndex(list);
  const parent = parentRecord(byId, parentId);
  const id = markId();
  const now = Date.now();
  const n = String(title || "").trim().slice(0, 2000);
  const data = url ? { p: parentId, k: 1, n: n || hostOf(markUrl(url)), u: markUrl(url), c: now, t: now } : { p: parentId, k: 2, n: n || "Новая папка", ch: [], c: now, t: now };
  parent.ch.push(id);
  if (!parent.root) {
    parent.t = now;
  }
  return { id, changes: [{ c: "marks", id, data }, { c: "marks", id: parentId, data: parent }] };
}

export function marksEdit(list, id, { title, url }) {
  const cur = marksIndex(list).get(id);
  if (!cur || cur.root) {
    throw fail("Закладка не найдена: обновите список");
  }
  const data = { ...cur, n: String(title ?? cur.n).trim().slice(0, 2000), t: Date.now() };
  if (cur.k === 1 && url !== undefined) {
    data.u = markUrl(url);
  }
  return [{ c: "marks", id, data }];
}

/** Удалить закладку или папку со всем содержимым. */
export function marksRemove(list, id) {
  const byId = marksIndex(list);
  const cur = byId.get(id);
  if (!cur || cur.root) {
    throw fail("Закладка не найдена: обновите список");
  }
  const changes = [];
  const drop = (nodeId, depth = 0) => {
    if (depth > 60) {
      return;
    }
    for (const [cid, d] of byId) {
      if (d.p === nodeId && !d.root) {
        drop(cid, depth + 1);
      }
    }
    changes.push({ c: "marks", id: nodeId, data: null });
  };
  drop(id);
  const parent = byId.get(cur.p);
  if (parent && Array.isArray(parent.ch) && parent.ch.includes(id)) {
    changes.push({ c: "marks", id: cur.p, data: { ...parent, ch: parent.ch.filter(c => c !== id), ...(parent.root ? {} : { t: Date.now() }) } });
  }
  return changes;
}
