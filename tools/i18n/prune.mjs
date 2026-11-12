// Убрать из общих словарей надписи, которых больше нет ни в веб-версии, ни в оболочке браузера:
//   node tools/i18n/prune.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANGS, ROOT, collect, desktopSet, webSet } from "./catalog.mjs";

const used = new Set([...collect(webSet()).keys.keys(), ...collect(desktopSet()).keys.keys()]);
let extra = 0;
for (const lang of LANGS) {
  const file = join(ROOT, "i18n", `${lang}.json`);
  const dict = JSON.parse(readFileSync(file, "utf8"));
  const gone = Object.keys(dict).filter(k => !used.has(k));
  extra += gone.length;
  console.log(`${lang}: лишних ${gone.length}${gone.length ? ": " + gone.slice(0, 4).map(k => JSON.stringify(k).slice(0, 40)).join(", ") : ""}`);
  if (gone.length && !process.argv.includes("--check")) {
    gone.forEach(k => delete dict[k]);
    writeFileSync(file, JSON.stringify(dict, null, 1) + "\n");
  }
}
process.exit(process.argv.includes("--check") && extra ? 1 : 0);
