// Код, перенесённый из браузера без изменений, должен оставаться тем же, что в браузере: если
// исходный модуль поправили, а копию в веб-версии нет, пароли, коды или письма начнут
// обрабатываться по-разному. Проверка сравнивает перенесённые части с их источниками.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summary } from "./lib.mjs";

const repo = process.env.TABORA_REPO || join(process.cwd(), "../..");
const read = p => readFileSync(join(repo, p), "utf8");
const between = (text, from, to) => {
  const a = text.indexOf(from);
  const b = to ? text.indexOf(to, a) : text.length;
  if (a < 0 || b < 0) {
    throw new Error(`не найдено: ${from.slice(0, 40)}`);
  }
  return text.slice(a, b).trimEnd();
};
const T = "src/browser/base/content/tabora";
const cases = [
  ["оценка пароля", `${T}/vault/Vault.sys.mjs`, "web/src/core/password.js", "const COMMON = new Set(", "/* ---------- счётчик неудачных попыток ---------- */", s => s, s => s],
  ["коды входа", `${T}/vault/Otp.sys.mjs`, "web/src/core/otp.js", 'const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";', "function stamp() {", s => s.replace(/\btt`/g, "t`"), s => s],
  ["проверка записи пароля", `${T}/sync/SyncSources.sys.mjs`, "web/src/core/logins.js", "/** Номер записи по номеру пароля в хранилище", "const logins = {", s => s, s => s.replace(/\n\nexport \{ loginId, loginValid \};$/, "")],
  ["операции OpenPGP", `${T}/mail/pgp/host.mjs`, "web/src/core/pgp-ops.js", "const HASH = {", "window.pgpCall = ", s => s.replace("const API = {", "export const API = {"), s => s],
  ["разбор и сборка писем", `${T}/mail/net/Mime.sys.mjs`, "web/src/core/mime.js", "/* ---- байты и кодировки ---- */", "", s => s.replace("lazy.parser.parseFromString", "new DOMParser().parseFromString"), s => s],
];
for (const [name, source, copy, from, to, fixSource, fixCopy] of cases) {
  const want = fixSource(between(read(source), from, to));
  const got = fixCopy(between(read(copy), from, ""));
  check(`${name}: копия в веб-версии совпадает с модулем браузера`, got === want, true);
}
summary();
