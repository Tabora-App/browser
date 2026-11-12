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
  let ast;
  try {
    ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  } catch (e) {
    // обычный скрипт окна (не модуль)
    ast = parse(src, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  }
  const keys = new Map();
  const line = pos => src.slice(0, pos).split("\n").length;
  const add = (key, node) => keys.has(key) || keys.set(key, `${file.replace(ROOT + "/", "")}:${line(node.start)}`);
  full(ast, node => {
    // тег t (веб-версия) или tt (оболочка браузера); tr/ttr("…") — перевод готового текста
    if (node.type === "TaggedTemplateExpression" && node.tag.type === "Identifier" && (node.tag.name === "t" || node.tag.name === "tt")) {
      add(keyOf(node.quasi), node);
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && (node.callee.name === "tr" || node.callee.name === "ttr") && node.arguments[0]?.type === "Literal" && typeof node.arguments[0].value === "string") {
      add(node.arguments[0].value, node);
    } else if (raw && node.type === "Literal" && typeof node.value === "string" && CYR.test(node.value)) {
      add(node.value, node);
    } else if (raw && node.type === "TemplateLiteral" && node.quasis.some(q => CYR.test(q.value.cooked ?? ""))) {
      add(keyOf(node), node);
    }
  });
  return keys;
}

export function readCatalog(lang, dir = "i18n") {
  const p = join(ROOT, dir, `${lang}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

/** Сообщения сервера из исходника на Rust: строки с русским текстом, кроме журнала (eprintln!,
 *  panic!, expect…), схемы базы (сырые строки) и проверок. Подстановки format! («{}», «{имя}»)
 *  записываются как {0}, {1}… — по таким образцам сервер находит перевод готового текста. */
export function rustKeysOf(file) {
  const src = readFileSync(file, "utf8");
  const keys = new Map();
  const SKIP = new Set(["eprintln!", "println!", "print!", "eprint!", "panic!", "unreachable!", "assert!", "assert_eq!", "assert_ne!", "debug_assert!", "expect", "unimplemented!", "todo!"]);
  const stack = [];
  let i = 0;
  let lineNo = 1;
  const end = src.indexOf("#[cfg(test)]");
  const stop = end < 0 ? src.length : end;
  while (i < stop) {
    const ch = src[i];
    if (ch === "\n") {
      lineNo++;
      i++;
    } else if (src.startsWith("//", i)) {
      while (i < stop && src[i] !== "\n") i++;
    } else if (src.startsWith("/*", i)) {
      const j = src.indexOf("*/", i + 2);
      const to = j < 0 ? stop : j + 2;
      lineNo += src.slice(i, to).split("\n").length - 1;
      i = to;
    } else if (ch === "r" && /^r#*"/.test(src.slice(i, i + 8)) && !/[A-Za-z0-9_]/.test(src[i - 1] || "")) {
      const hashes = /^r(#*)"/.exec(src.slice(i, i + 8))[1];
      const j = src.indexOf(`"${hashes}`, i + 2 + hashes.length);
      const to = j < 0 ? stop : j + 1 + hashes.length;
      lineNo += src.slice(i, to).split("\n").length - 1;
      i = to; // сырые строки — схема базы и подобное, не сообщения
    } else if (ch === "'") {
      const m = /^'(\\.|\\u\{[0-9a-fA-F]+\}|[^\\'])'/.exec(src.slice(i, i + 12));
      i += m ? m[0].length : 1;
    } else if (ch === '"') {
      const startLine = lineNo;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          const n = src[j + 1];
          if (n === "n") out += "\n";
          else if (n === "t") out += "\t";
          else if (n === "r") out += "\r";
          else if (n === "0") out += "\0";
          else if (n === "u") {
            const m = /^\{([0-9a-fA-F]+)\}/.exec(src.slice(j + 2, j + 12));
            out += m ? String.fromCodePoint(parseInt(m[1], 16)) : "";
            j += m ? m[0].length : 0;
          } else if (n === "\n") {
            lineNo++;
            j += 2;
            while (/\s/.test(src[j])) {
              if (src[j] === "\n") lineNo++;
              j++;
            }
            continue; // перенос строки внутри литерала: пробелы следующей строки не считаются
          } else out += n;
          j += 2;
        } else {
          if (src[j] === "\n") lineNo++;
          out += src[j++];
        }
      }
      i = j + 1;
      if (CYR.test(out) && !stack.some(n => SKIP.has(n))) {
        let slot = 0;
        let key = "";
        for (let k = 0; k < out.length; k++) {
          if (out.startsWith("{{", k)) {
            key += "{";
            k++;
          } else if (out.startsWith("}}", k)) {
            key += "}";
            k++;
          } else if (out[k] === "{") {
            const close = out.indexOf("}", k);
            if (close < 0) {
              key += out[k];
            } else {
              key += `{${slot++}}`;
              k = close;
            }
          } else {
            key += out[k];
          }
        }
        if (!keys.has(key)) {
          keys.set(key, `${file.replace(ROOT + "/", "")}:${startLine}`);
        }
      }
    } else if (ch === "(") {
      const m = /([A-Za-z_][A-Za-z0-9_]*!?)\s*$/.exec(src.slice(Math.max(0, i - 40), i));
      stack.push(m ? m[1] : "");
      i++;
    } else if (ch === ")") {
      stack.pop();
      i++;
    } else {
      i++;
    }
  }
  return keys;
}

export function serverKeys() {
  const keys = new Map();
  for (const f of listFiles(join(ROOT, "server/src"), [".rs"])) {
    rustKeysOf(f).forEach((where, key) => keys.has(key) || keys.set(key, where));
  }
  return keys;
}

/** Набор приложения: { files: […], raw: […] } → { keys: Map, catalogs: { en: {…}, … }, missing: { en: […], … } }. */
export function collect({ files = [], raw = [], keys: ready = null, dir = "i18n" }) {
  const keys = ready || new Map();
  for (const f of files) {
    keysOf(f).forEach((where, key) => keys.has(key) || keys.set(key, where));
  }
  for (const f of raw) {
    keysOf(f, { raw: true }).forEach((where, key) => keys.has(key) || keys.set(key, where));
  }
  const catalogs = {};
  const missing = {};
  for (const lang of LANGS) {
    const all = readCatalog(lang, dir);
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

/** Надписи из разметки страницы: текст и подписи элементов с русскими буквами — то, что переводит
 *  translateDocument в I18n.sys.mjs (тот же приём: текст узла без краевых пробелов). */
export function htmlKeysOf(file) {
  const src = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  const keys = new Map();
  const where = file.replace(ROOT + "/", "");
  const unescape = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, "\u00a0");
  for (const m of src.matchAll(/>([^<>]*[А-Яа-яЁё][^<>]*)</g)) {
    const key = unescape(m[1]).trim().replace(/\s+/g, " ");
    keys.has(key) || keys.set(key, where);
  }
  for (const m of src.matchAll(/\b(?:title|placeholder|aria-label|alt|label|tooltiptext|value)="([^"]*[А-Яа-яЁё][^"]*)"/g)) {
    const key = unescape(m[1]);
    keys.has(key) || keys.set(key, where);
  }
  return keys;
}

/** Что входит в оболочку браузера (chrome://tabora/content/): модули и скрипты окон помечены
 *  тегом tt`…`, разметка страниц переводится при загрузке, общий с веб-версией код почты
 *  (Mime, OpenPGP) — при показе. */
export function desktopSet() {
  const dir = join(ROOT, "src/browser/base/content/tabora");
  const all = listFiles(dir, [".js", ".mjs"], ["/vendor/", "/fonts/", "/i18n/"]);
  const rawNames = ["mail/net/Mime.sys.mjs", "mail/pgp/host.mjs", "shield/ShieldEngine.sys.mjs"].map(n => join(dir, n));
  const keys = new Map();
  for (const f of listFiles(dir, [".html", ".xhtml"], ["/vendor/"])) {
    htmlKeysOf(f).forEach((where, key) => keys.has(key) || keys.set(key, where));
  }
  return { files: all.filter(f => !rawNames.includes(f)), raw: all.filter(f => rawNames.includes(f) && !f.endsWith("ShieldEngine.sys.mjs")), keys };
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
