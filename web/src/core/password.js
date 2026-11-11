/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Оценка стойкости пароля. Правила те же, что в браузере Tabora: код перенесён без изменений из
 * src/browser/base/content/tabora/vault/Vault.sys.mjs (tools/web/test/parity.mjs сверяет оба файла),
 * чтобы пароль, принятый в одном месте, принимался и в другом. */

export const MIN_PASSWORD = 6;

const COMMON = new Set(["password", "password1", "password12", "password123", "password1234", "passwordpassword", "qwerty", "qwerty12", "qwerty123", "qwerty123456", "qwertyuiop", "qwertyuiop12", "qwertyuiopas", "123456", "1234567", "12345678", "123456789", "1234567890", "123456789012", "1234567890ab", "111111", "000000", "123123", "123123123123", "111111111111", "000000000000", "abc123", "abcdef", "abcdefghijkl", "aaaaaaaaaaaa", "iloveyou", "iloveyou1234", "admin", "admin123", "administrator", "welcome", "welcome1", "welcome12345", "letmein", "letmein12345", "monkey", "dragon", "sunshine", "sunshine1234", "princess", "princess1234", "football", "football1234", "baseball", "baseball1234", "superman", "superman1234", "trustno1", "trustno1trustno1", "passw0rd", "passw0rdpassw0rd", "1q2w3e4r", "1q2w3e4r5t6y", "zaq12wsx", "zaq12wsxcde3", "пароль", "пароль123", "йцукен", "qazwsx", "master", "tabora", "tabora123"]);
const SEQUENCES = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "asdfghjkl", "zxcvbnm", "йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю", "абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "1qaz2wsx3edc", "qazwsxedc"];
const WORDS = ["password", "passw0rd", "qwerty", "admin", "letmein", "welcome", "iloveyou", "пароль", "tabora", "login", "master"];

/** Оценка стойкости 0..4: 0 — не принимается вовсе, 1 — слабый (тоже не принимается). Оценка
 * считает примерную энтропию по алфавиту и длине и штрафует распространённые шаблоны:
 * последовательности, повторы, годы, известные слова. */
export function passwordStrength(password) {
  const p = String(password || "");
  if (!p) {
    return { score: 0, label: "введите пароль" };
  }
  if (p.length < MIN_PASSWORD) {
    return { score: 0, label: `не короче ${MIN_PASSWORD} символов` };
  }
  const lower = p.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(p)) {
    return { score: 0, label: "слишком распространённый" };
  }
  let pool = 0;
  if (/[a-z]/.test(p)) {
    pool += 26;
  }
  if (/[A-Z]/.test(p)) {
    pool += 26;
  }
  if (/[а-яё]/.test(p)) {
    pool += 33;
  }
  if (/[А-ЯЁ]/.test(p)) {
    pool += 33;
  }
  if (/\d/.test(p)) {
    pool += 10;
  }
  if (/[^\p{L}\p{N}]/u.test(p)) {
    pool += 33;
  }
  if (/[^a-zA-Zа-яёА-ЯЁ\d\x20-\x7e]/.test(p)) {
    pool += 40; // прочие буквы
  }
  let bits = p.length * Math.log2(Math.max(pool, 10));
  const unique = new Set(p).size;
  if (unique < p.length / 2) {
    bits *= 0.6;
  }
  if (/^(.{1,4})\1+.?$/.test(p)) {
    bits *= 0.4; // повтор короткого куска: abcabcabc
  }
  let reason = "";
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 4 <= seq.length; i++) {
      const chunk = seq.slice(i, i + 4);
      if (lower.includes(chunk) || lower.includes([...chunk].reverse().join(""))) {
        bits -= 10;
        reason = "похож на последовательность";
        i = seq.length;
      }
    }
  }
  if (/(19|20)\d\d/.test(p)) {
    bits -= 6;
  }
  for (const w of WORDS) {
    if (lower.includes(w)) {
      bits -= 15;
      reason ||= "содержит распространённое слово";
      break;
    }
  }
  let score = 1;
  if (bits >= 32) {
    score = 2;
  }
  if (bits >= 45) {
    score = 3;
  }
  if (bits >= 64) {
    score = 4;
  }
  return { score, label: score === 1 && reason ? `слабый: ${reason}` : ["слабый", "слабый", "средний", "хороший", "отличный"][score] };
}

/** Новый пароль: не короче 6 символов и не «слабый». */
export function checkNewPassword(password) {
  const s = passwordStrength(password);
  if (s.score < 2) {
    throw new Error(`Пароль: ${s.label}. Добавьте длины, цифр или знаков`);
  }
  return s;
}
