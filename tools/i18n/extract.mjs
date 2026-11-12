// Проверка и сбор словарей перевода.
//   node tools/i18n/extract.mjs web            чего не хватает в i18n/<язык>.json для веб-версии
//   node tools/i18n/extract.mjs web --todo     записать недостающие надписи в .build/i18n-todo-web.json
//   node tools/i18n/extract.mjs web --strict   код возврата 1, если чего-то не хватает или перевод испорчен
// Перевод считается испорченным, если в нём другой набор подстановок {0}, {1}… чем в исходной надписи.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANGS, ROOT, collect, webSet } from "./catalog.mjs";

const SETS = { web: webSet };
const [name, ...flags] = process.argv.slice(2);
if (!SETS[name]) {
  console.error(`набор: ${Object.keys(SETS).join(" | ")}`);
  process.exit(2);
}
const { keys, catalogs, missing } = collect(SETS[name]());
const slots = s => [...String(s).matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(",");
const forms = s => String(s).split("|").length;
let bad = 0;
console.log(`${name}: надписей ${keys.size}`);
for (const lang of LANGS) {
  const broken = [];
  for (const [key, value] of Object.entries(catalogs[lang])) {
    if (slots(key) !== slots(value)) {
      broken.push(`подстановки: «${key}» → «${value}»`);
    } else if (forms(key) > 1 && forms(value) < 2) {
      broken.push(`формы числа: «${key}» → «${value}»`);
    }
  }
  console.log(`  ${lang}: переведено ${Object.keys(catalogs[lang]).length}, не хватает ${missing[lang].length}${broken.length ? `, испорчено ${broken.length}` : ""}`);
  broken.slice(0, 10).forEach(b => console.log(`      ${b}`));
  bad += missing[lang].length + broken.length;
}
if (flags.includes("--todo")) {
  mkdirSync(join(ROOT, ".build"), { recursive: true });
  const todo = {};
  for (const lang of LANGS) {
    todo[lang] = missing[lang];
  }
  const all = [...new Set(LANGS.flatMap(l => missing[l]))];
  writeFileSync(join(ROOT, `.build/i18n-todo-${name}.json`), JSON.stringify({ keys: all, where: Object.fromEntries(all.map(k => [k, keys.get(k)])), byLang: todo }, null, 1));
  console.log(`недостающие надписи: .build/i18n-todo-${name}.json (${all.length})`);
}
process.exit(flags.includes("--strict") && bad ? 1 : 0);
