// Словари переводов для сборки: какие надписи встречаются в коде приложения и что для них есть
// в i18n/<язык>.json. Используется сборкой (esbuild-модуль «tabora-i18n-catalog») и проверкой.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { full } from "acorn-walk";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../..");
export const LANGS = ["en", "uk", "es"];
const CYR = /[А-Яа-яЁё]/;

export function listFiles(dir, exts = [".js", ".mjs"], skip = []) {
  const out = [];
  const walk = d => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (skip.some(s => p.includes(s))) {
        continue;
      }
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (exts.some(e => f.endsWith(e))) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

const keyOf = quasi => quasi.quasis.map(q => q.value.cooked).reduce((all, part, i) => `${all}{${i - 1}}${part}`);

/** Надписи из файла: помеченные t`…` и переданные литералом в tr("…").
 *  raw: true — все строки с русским текстом (файлы, общие с другим приложением: их текст
 *  переводится при показе через tr). Возвращает Map «надпись → где встретилась». */
export function keysOf(file, { raw = false } = {}) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const keys = new Map();
  const line = pos => src.slice(0, pos).split("\n").length;
  const add = (key, node) => keys.has(key) || keys.set(key, `${file.replace(ROOT + "/", "")}:${line(node.start)}`);
  full(ast, node => {
    if (node.type === "TaggedTemplateExpression" && node.tag.type === "Identifier" && node.tag.name === "t") {
      add(keyOf(node.quasi), node);
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "tr" && node.arguments[0]?.type === "Literal" && typeof node.arguments[0].value === "string") {
      add(node.arguments[0].value, node);
    } else if (raw && node.type === "Literal" && typeof node.value === "string" && CYR.test(node.value)) {
      add(node.value, node);
    } else if (raw && node.type === "TemplateLiteral" && node.quasis.some(q => CYR.test(q.value.cooked ?? ""))) {
      add(keyOf(node), node);
    }
  });
  return keys;
}

export function readCatalog(lang) {
  const p = join(ROOT, "i18n", `${lang}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

/** Набор приложения: { files: […], raw: […] } → { keys: Map, catalogs: { en: {…}, … }, missing: { en: […], … } }. */
export function collect({ files, raw = [] }) {
  const keys = new Map();
  for (const f of files) {
    keysOf(f).forEach((where, key) => keys.has(key) || keys.set(key, where));
  }
  for (const f of raw) {
    keysOf(f, { raw: true }).forEach((where, key) => keys.has(key) || keys.set(key, where));
  }
  const catalogs = {};
  const missing = {};
  for (const lang of LANGS) {
    const all = readCatalog(lang);
    catalogs[lang] = {};
    missing[lang] = [];
    for (const key of keys.keys()) {
      if (typeof all[key] === "string" && all[key] !== "") {
        catalogs[lang][key] = all[key];
      } else {
        missing[lang].push(key);
      }
    }
  }
  return { keys, catalogs, missing };
}

/** Что входит в веб-версию. Файлы, общие с браузером для компьютера, и рабочие потоки не помечены:
 *  их текст переводится при показе. */
export function webSet() {
  const dir = join(ROOT, "web/src");
  const rawNames = ["core/password.js", "core/pgp-ops.js", "core/mime.js", "core/kdf.worker.js", "core/pgp.worker.js", "core/kdf-core.js"].map(n => join(dir, n));
  const all = listFiles(dir, [".js"]);
  return { files: all.filter(f => !rawNames.includes(f)), raw: all.filter(f => rawNames.includes(f)) };
}

/** Модули для esbuild: import("tabora-i18n-catalog/en") — словарь одного языка отдельным файлом,
 *  чтобы человек скачивал только свой язык. */
export function catalogPlugin(set) {
  let cache = null;
  return {
    name: "tabora-i18n-catalog",
    setup(build) {
      build.onStart(() => {
        cache = null;
      });
      build.onResolve({ filter: /^tabora-i18n-catalog\/[a-z]+$/ }, args => ({ path: args.path.split("/")[1], namespace: "tabora-i18n" }));
      build.onLoad({ filter: /.*/, namespace: "tabora-i18n" }, args => {
        cache ||= collect(set()).catalogs;
        return { contents: `export default ${JSON.stringify(cache[args.path] || {})};`, loader: "js" };
      });
    },
  };
}
