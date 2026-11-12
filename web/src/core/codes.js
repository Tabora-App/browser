/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Записи кодов входа в синхронизации (набор otp). Вид записи — тот же, что пишет браузер на
 * компьютере (sync/SyncSources.sys.mjs): { i: сервис, a: аккаунт, s: секрет Base32, al, d, p,
 * w: [{ host, sub }] — сайты, на которых код предлагается, c: когда создана }.
 * Правила привязки к сайтам повторяют vault/Otp.sys.mjs: точный хост, поддомены — только если
 * человек разрешил их сам. */

import { randomId } from "./bytes.js";
import { base32Decode, base32Encode, hotp } from "./otp.js";
import { t } from "./i18n.js";

function fail(message, code = "bad-code") {
  return Object.assign(new Error(message), { code });
}

const clean = (v, max) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);

/** Хост из произвольного ввода: «https://GitHub.com/login» → «github.com». */
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

/** Сайты записи: «github.com, gitlab.com» → [{ host, sub }], не больше восьми. */
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

/** Сайт по названию сервиса, если оно само похоже на домен (github.com). Точный хост, без поддоменов. */
function guessSites(issuer) {
  const s = String(issuer || "").trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? normalizeSites([s]) : [];
}

/** Новая запись кода: { id, data }. Секрет — Base32, как его показывают сайты. */
export async function newOtp({ issuer, account, secret, algorithm = "SHA1", digits = 6, period = 30, sites = null }) {
  const al = String(algorithm || "SHA1").toUpperCase();
  const d = Number(digits || 6);
  const p = Number(period || 30);
  if (!["SHA1", "SHA256", "SHA512"].includes(al) || ![6, 7, 8].includes(d) || !(p >= 15 && p <= 120)) {
    throw fail(t`Такие параметры кода не поддерживаются`);
  }
  let bytes;
  try {
    bytes = base32Decode(secret);
  } catch (e) {
    throw fail(t`Секрет введён с ошибкой: в нём только латинские буквы и цифры 2–7`);
  }
  if (bytes.length < 8) {
    throw fail(t`Секрет слишком короткий`);
  }
  await hotp(bytes, 0, { algorithm: al, digits: d });
  const i = clean(issuer, 48);
  const a = clean(account, 96);
  if (!i && !a) {
    throw fail(t`Укажите сервис или аккаунт`);
  }
  const id = `o${Date.now().toString(36)}${randomId(6).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 5)}`;
  return { id, data: { i, a, s: base32Encode(bytes), al, d, p, w: sites ? normalizeSites(sites) : guessSites(i), c: new Date().toISOString() } };
}

/** Годится ли запись, пришедшая синхронизацией: по негодной код не считается и не предлагается. */
export function otpValid(d) {
  return !!d && typeof d.s === "string" && d.s.length >= 13 && ["SHA1", "SHA256", "SHA512"].includes(d.al) && [6, 7, 8].includes(d.d) && d.p >= 15 && d.p <= 120;
}

/** Как хост страницы совпадает с записью: "exact", "sub" (по разрешённым поддоменам) или null. */
export function matchHost(data, host) {
  const h = String(host || "").toLowerCase();
  let best = null;
  for (const s of Array.isArray(data?.w) ? data.w : []) {
    if (!s || typeof s.host !== "string") {
      continue;
    }
    if (s.host === h) {
      return "exact";
    }
    if (s.sub && h.endsWith(`.${s.host}`)) {
      best = "sub";
    }
  }
  return best;
}
