/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Записи паролей сайтов в синхронизации (набор logins). Вид записи — тот же, что пишет браузер на
 * компьютере: { g: номер пароля в хранилище, o: адрес сайта, f: адрес формы | null, r: область
 * HTTP-входа | null, u: имя, p: пароль, uf, pf: имена полей, c: создан, t: пароль менялся }.
 * Проверка записи перенесена из sync/SyncSources.sys.mjs без изменений
 * (tools/web/test/parity.test.mjs сверяет): запись, которую принял бы компьютер, принимается и здесь. */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Номер записи по номеру пароля в хранилище: «{uuid}» без скобок, короткие номера как есть. */
function loginId(guid) {
  const m = /^\{([0-9a-fA-F-]{36})\}$/.exec(guid || "");
  const id = m ? m[1] : guid;
  return ID_RE.test(id || "") ? id : "";
}

function loginValid(id, d) {
  return (
    !!d && typeof d.o === "string" && /^[a-z][a-z0-9+.-]*:\/\/[^\s]{1,300}$/i.test(d.o) && typeof d.u === "string" && d.u.length <= 512 &&
    typeof d.p === "string" && d.p.length >= 1 && d.p.length <= 4096 && (d.f === null || typeof d.f === "string") && (d.r === null || typeof d.r === "string") &&
    (d.f === null) !== (d.r === null) && loginId(d.g) === id
  );
}

export { loginId, loginValid };
