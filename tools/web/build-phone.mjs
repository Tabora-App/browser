// Сборка модуля аккаунта для приложения на телефоне: web/src/phone + web/phone → каталог расширения,
// которое приложение Android ставит как встроенное (assets/extensions/tabora).
//   node tools/web/build-phone.mjs [каталог] [--api <адрес сервера>] [--fill-test <адрес страницы>] [--dev]
// Модуль собирается из того же кода, что веб-версия (вход, ключи, шифрование), и тех же закреплённых
// пакетов (package-lock.json). --api (местный сервер аккаунтов) и --fill-test (страница без https,
// на которой разрешён автоввод кодов) нужны только для проверок: такая сборка помечена в
// build.json и в выпуск не годится.
//
// В каталоге получается:
//   manifest.json                описание расширения: права только на сервер аккаунтов и связь с приложением
//   background.html              фоновая страница: вход и синхронизация (web/src/phone/background.js)
//   index.html                   экран «Аккаунт Tabora» (web/src/phone/main.js)
//   codes.html                   экран «Коды входа» (web/src/phone/codes-main.js)
//   mail.html                    экран «Почта» (web/src/phone/mail-main.js): почта веб-версии с общим входом
//   frame/*.html                 пустые документы для рамок письма (своя политика содержимого, без скриптов)
//   assets/fill.js               скрипт автоввода кода на страницах сайтов (web/src/phone/fill.js)
//   assets/…                     скрипты, стили, рабочие потоки (вывод ключей, OpenPGP), шрифты
//   build.json                   состав сборки с суммами SHA-256
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPlugin, webSet } from "../i18n/catalog.mjs";

const PRODUCTION_API = "https://api.tabora.app";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const apiAt = args.indexOf("--api");
const api = (apiAt >= 0 ? args[apiAt + 1] : PRODUCTION_API).replace(/\/+$/, "");
if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(api)) {
  throw new Error(`--api: нужен адрес вида https://имя[:порт], получено «${api}»`);
}
const fillAt = args.indexOf("--fill-test");
const fillTest = fillAt >= 0 ? args[fillAt + 1].replace(/\/+$/, "") : "";
if (fillTest && !/^http:\/\/[a-z0-9.-]+(:\d+)?$/i.test(fillTest)) {
  throw new Error(`--fill-test: нужен адрес вида http://имя[:порт], получено «${fillTest}»`);
}
const out = resolve(args.find((a, i) => !a.startsWith("--") && (apiAt < 0 || i !== apiAt + 1) && (fillAt < 0 || i !== fillAt + 1)) || join(root, ".build/phone"));
const src = join(root, "web");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

const common = {
  bundle: true,
  platform: "browser",
  target: ["firefox128"],
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "eof",
  logLevel: "warning",
  nodePaths: [join(here, "node_modules")],
  metafile: true,
};

function outName(result, entry) {
  const hit = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint && resolve(root, o.entryPoint) === resolve(entry));
  if (!hit) {
    throw new Error(`нет результата сборки для ${entry}`);
  }
  return `/${relative(out, resolve(root, hit[0])).split("\\").join("/")}`;
}

// 1. рабочие потоки
const workers = {};
for (const name of ["kdf", "pgp"]) {
  const entry = join(src, `src/core/${name}.worker.js`);
  const r = await build({ ...common, entryPoints: { [name]: entry }, format: "iife", outdir: join(out, "assets"), entryNames: "[name]-[hash]", absWorkingDir: root });
  workers[name] = outName(r, entry);
}

// 2. фоновая страница, экран аккаунта и стили
const entries = {
  background: join(src, "src/phone/background.js"), app: join(src, "src/phone/main.js"), codes: join(src, "src/phone/codes-main.js"), mail: join(src, "src/phone/mail-main.js"),
  style: join(src, "src/styles/phone.css"), mailstyle: join(src, "src/styles/phone-mail.css"),
};
const version = JSON.parse(readFileSync(join(root, "browser.json"), "utf8")).brands?.release?.displayVersion || "";
const app = await build({
  ...common,
  entryPoints: entries,
  format: "esm",
  splitting: true, // общее для фоновой страницы и экрана лежит в одном файле
  chunkNames: "chunk-[hash]",
  outdir: join(out, "assets"),
  entryNames: "[name]-[hash]",
  absWorkingDir: root,
  external: ["/assets/fonts/*"],
  plugins: [catalogPlugin(webSet)],
  define: { __KDF_WORKER__: JSON.stringify(workers.kdf), __PGP_WORKER__: JSON.stringify(workers.pgp), __APP_VERSION__: JSON.stringify(version), __DEV__: JSON.stringify(dev), __API_BASE__: JSON.stringify(api), __FILL_TEST_ORIGIN__: JSON.stringify(fillTest) },
});

// 2а. скрипт автоввода для страниц сайтов: один небольшой файл без зависимостей и с постоянным именем
await build({ ...common, entryPoints: { fill: join(src, "src/phone/fill.js") }, format: "iife", outdir: join(out, "assets"), entryNames: "[name]", absWorkingDir: root, define: { __FILL_TEST_ORIGIN__: JSON.stringify(fillTest) } });

// 3. fonts: the same files as the web app uses (web/fonts)
mkdirSync(join(out, "assets/fonts"), { recursive: true });
for (const f of readdirSync(join(src, "fonts"))) {
  if (f.endsWith(".woff2")) {
    cpSync(join(src, "fonts", f), join(out, "assets/fonts", f));
  }
}

// 4. страницы и описание расширения
const fill = (name, values) => {
  let text = readFileSync(join(src, "phone", name), "utf8");
  for (const [key, value] of Object.entries(values)) {
    text = text.split(key).join(value);
  }
  if (/__[A-Z_]+__/.test(text)) {
    throw new Error(`в ${name} остались незаполненные места`);
  }
  writeFileSync(join(out, name), text);
};
// Политика содержимого. Общая (manifest.json) действует на все документы модуля, включая рамки
// писем, поэтому разрешает оформление внутри письма и картинки; скрипты — только свои файлы.
// Каждая страница и каждая рамка дополнительно сужает её своей (обе действуют вместе).
const scripts = "script-src 'self' 'wasm-unsafe-eval'";
const manifestCsp = `default-src 'none'; ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src ${api}${fillTest ? ` ${fillTest}` : ""}; worker-src 'self'; frame-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'`;
const pageCsp = `default-src 'none'; ${scripts}; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src ${api}${fillTest ? ` ${fillTest}` : ""}; worker-src 'self'; frame-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'`;
const frameCsp = remote => `default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; img-src data: blob:${remote ? " https:" : ""}`;
fill("index.html", { __APP_JS__: outName(app, entries.app), __APP_CSS__: outName(app, entries.style), __PAGE_CSP__: pageCsp });
fill("codes.html", { __CODES_JS__: outName(app, entries.codes), __APP_CSS__: outName(app, entries.style), __PAGE_CSP__: pageCsp });
fill("mail.html", { __MAIL_JS__: outName(app, entries.mail), __MAIL_CSS__: outName(app, entries.mailstyle), __PAGE_CSP__: pageCsp });
// рамки письма — те же пустые документы, что у веб-версии; там политику задаёт сервер заголовком, здесь — сам документ
mkdirSync(join(out, "frame"), { recursive: true });
for (const [name, remote] of [["mail.html", false], ["mail-remote.html", true]]) {
  const text = readFileSync(join(src, "static/frame", name), "utf8");
  const marked = text.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${frameCsp(remote)}">`);
  if (marked === text) {
    throw new Error(`в ${name} не нашлось места для политики содержимого`);
  }
  writeFileSync(join(out, "frame", name), marked);
}
fill("background.html", { __BG_JS__: outName(app, entries.background) });
// версия расширения — только числа через точку; право на сервер — образец адреса без порта
// (с портом образец недействителен, и запросы упираются в запрет чужих сайтов)
fill("manifest.json", {
  __VERSION__: version.replace(/[^0-9.]/g, "") || "0", __API_ORIGIN__: api, __API_PATTERN__: `${api.replace(/:\d+$/, "")}/*`,
  __FILL_MATCHES__: JSON.stringify(["https://*/*", ...(fillTest ? [`${fillTest.replace(/:\d+$/, "")}/*`] : [])]),
  __MANIFEST_CSP__: manifestCsp,
});

// 5. состав сборки
const files = {};
const walk = dir => {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (f !== "build.json") {
      files[relative(out, p).split("\\").join("/")] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
};
walk(out);
const test = api !== PRODUCTION_API || !!fillTest;
writeFileSync(join(out, "build.json"), `${JSON.stringify({ version, api, ...(test ? { test: true } : {}), files }, null, 1)}\n`);
const size = f => `${(statSync(join(out, f.slice(1))).size / 1024).toFixed(0)} КБ`;
console.log(`модуль аккаунта для телефона собран: ${relative(root, out)} — фон ${size(outName(app, entries.background))}, экран ${size(outName(app, entries.app))}, файлов ${Object.keys(files).length}${test ? ` (сервер ${api}${fillTest ? `, автоввод на ${fillTest}` : ""}: только для проверок)` : ""}${dev ? " (сборка для разработки)" : ""}`);
