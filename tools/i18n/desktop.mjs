// Словари оболочки браузера: из i18n/<язык>.json в корне репозитория берутся надписи, которые
// встречаются в chrome://tabora/content/, и кладутся рядом с I18n.sys.mjs — оттуда их читает
// браузер. Файлы закоммичены; --check проверяет, что они соответствуют исходным словарям.
//   node tools/i18n/desktop.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LANGS, ROOT, collect, desktopSet } from "./catalog.mjs";

const out = join(ROOT, "src/browser/base/content/tabora/i18n");
const { keys, catalogs, missing } = collect(desktopSet());
let stale = 0;
for (const lang of LANGS) {
  const text = JSON.stringify(catalogs[lang], null, 0) + "\n";
  const file = join(out, `${lang}.json`);
  if (process.argv.includes("--check")) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
      console.error(`устарел ${file.replace(ROOT + "/", "")}: запустите node tools/i18n/desktop.mjs`);
      stale++;
    }
  } else {
    writeFileSync(file, text);
  }
  console.log(`${lang}: ${Object.keys(catalogs[lang]).length} из ${keys.size} надписей${missing[lang].length ? `, без перевода ${missing[lang].length}` : ""}`);
}
process.exit(stale ? 1 : 0);
