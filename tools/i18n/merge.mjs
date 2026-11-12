// Принять готовые переводы в словари: node tools/i18n/merge.mjs <язык> <файл.json>… [--dir=i18n] [--replace]
// Файл — { "русская надпись": "перевод", … }. Проверяется то, что ломает интерфейс: места
// подстановки {0}, {1}… и число форм слова. Уже переведённое не заменяется без --replace.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANGS, ROOT } from "./catalog.mjs";

const FORMS = { en: 2, es: 2, uk: 3 };
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith("--"));
const [lang, ...files] = args.filter(a => !a.startsWith("--"));
if (!LANGS.includes(lang) || !files.length) {
  console.error("node tools/i18n/merge.mjs <en|uk|es> <файл.json>… [--dir=i18n] [--replace]");
  process.exit(2);
}
const dir = (flags.find(f => f.startsWith("--dir=")) || "--dir=i18n").slice(6);
const replace = flags.includes("--replace");
const target = join(ROOT, dir, `${lang}.json`);
const dict = JSON.parse(readFileSync(target, "utf8"));
const slots = s => (s.match(/\{\d+\}/g) || []).sort().join(" ");
// «слово|слова|слов»: формы одного слова без пробелов по краям
const isForms = key => /^[^|]+\|[^|]+\|[^|]+$/.test(key) && !/\s\|\s/.test(key);

let added = 0, kept = 0;
const bad = [];
for (const file of files) {
  for (const [key, value] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) {
    if (typeof value !== "string" || !value) {
      bad.push([key, "пустой перевод"]);
    } else if (slots(key) !== slots(value)) {
      bad.push([key, `подстановки: ${slots(key) || "нет"} → ${slots(value) || "нет"}`]);
    } else if (isForms(key) && value.split("|").length !== FORMS[lang]) {
      bad.push([key, `форм слова ${value.split("|").length}, нужно ${FORMS[lang]}`]);
    } else if (dict[key] !== undefined && dict[key] !== value && !replace) {
      kept++;
    } else {
      dict[key] === undefined && added++;
      dict[key] = value;
    }
  }
}
writeFileSync(target, JSON.stringify(dict, null, 1) + "\n");
console.log(`${lang}: добавлено ${added}, оставлено прежних ${kept}, отклонено ${bad.length}`);
bad.slice(0, 30).forEach(([key, why]) => console.log(`  ${why}: ${JSON.stringify(key).slice(0, 90)}`));
process.exit(bad.length ? 1 : 0);
