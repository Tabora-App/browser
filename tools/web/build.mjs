// Сборка веб-версии Tabora: web/ → каталог для раздачи (по умолчанию .build/web).
//   node tools/web/build.mjs [каталог] [--dev]
// Версии пакетов закреплены в package-lock.json (ставятся `npm ci --ignore-scripts`). Имена файлов
// скриптов и стилей содержат хеш содержимого: nginx отдаёт /assets/ как неизменяемые, а index.html —
// без кэша, поэтому новая сборка подхватывается сразу и целиком.
//
// В каталоге получается:
//   index.html                   страница приложения (ссылки на файлы с хешем)
//   assets/app-<хеш>.js|css      приложение
//   assets/kdf-<хеш>.js          рабочий поток вывода ключей из пароля (Argon2id)
//   assets/pgp-<хеш>.js          рабочий поток OpenPGP
//   assets/fonts/*.woff2         шрифты (те же файлы, что у сайта)
//   frame/*.html                 пустые документы для рамок письма (у них своя политика содержимого)
//   manifest.webmanifest, icons/ установка на экран телефона
//   build.json                   состав сборки с суммами SHA-256
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPlugin, webSet } from "../i18n/catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const out = resolve(args.find(a => !a.startsWith("--")) || join(root, ".build/web"));
const src = join(root, "web");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

const common = {
  bundle: true,
  platform: "browser",
  // без «es2020»: приложению нужен await на верхнем уровне модуля (словарь языка); он есть во всех
  // перечисленных браузерах, а старше них приложение всё равно не запускается (static/compat.js)
  target: ["chrome90", "firefox90", "safari15"],
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

// 1. рабочие потоки: обычные (не модульные) скрипты — так они запускаются и в старых браузерах телефонов
const workers = {};
for (const name of ["kdf", "pgp"]) {
  const entry = join(src, `src/core/${name}.worker.js`);
  const r = await build({ ...common, entryPoints: { [name]: entry }, format: "iife", outdir: join(out, "assets"), entryNames: "[name]-[hash]", absWorkingDir: root });
  workers[name] = outName(r, entry);
}

// 2. приложение и стили
const mainEntry = join(src, "src/main.js");
const cssEntry = join(src, "src/styles/app.css");
const version = JSON.parse(readFileSync(join(root, "browser.json"), "utf8")).brands?.release?.displayVersion || "";
const app = await build({
  ...common,
  entryPoints: { app: mainEntry, style: cssEntry },
  format: "esm",
  splitting: true, // редко нужное (чтение QR-кодов) подгружается отдельным файлом
  chunkNames: "chunk-[hash]",
  outdir: join(out, "assets"),
  entryNames: "[name]-[hash]",
  absWorkingDir: root,
  external: ["/assets/fonts/*"],
  // переводы: в сборку попадают только надписи, которые встречаются в коде веб-версии (i18n/*.json)
  plugins: [catalogPlugin(webSet)],
  define: { __KDF_WORKER__: JSON.stringify(workers.kdf), __PGP_WORKER__: JSON.stringify(workers.pgp), __APP_VERSION__: JSON.stringify(version), __DEV__: JSON.stringify(dev) },
});
const js = outName(app, mainEntry);
const css = outName(app, cssEntry);

// 3. статика
cpSync(join(src, "static"), out, { recursive: true });
mkdirSync(join(out, "assets/fonts"), { recursive: true });
for (const f of readdirSync(join(src, "fonts"))) {
  if (f.endsWith(".woff2")) {
    cpSync(join(src, "fonts", f), join(out, "assets/fonts", f));
  }
}

// 4. страница
const html = readFileSync(join(src, "index.html"), "utf8").replace("__APP_JS__", js).replace("__APP_CSS__", css);
if (/__APP_(JS|CSS)__/.test(html)) {
  throw new Error("в index.html остались незаполненные места");
}
writeFileSync(join(out, "index.html"), html);

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
writeFileSync(join(out, "build.json"), `${JSON.stringify({ version, files }, null, 1)}\n`);
const size = f => `${(statSync(join(out, f.slice(1))).size / 1024).toFixed(0)} КБ`;
console.log(`веб-версия собрана: ${relative(root, out)} — приложение ${size(js)}, стили ${size(css)}, kdf ${size(workers.kdf)}, pgp ${size(workers.pgp)}, файлов ${Object.keys(files).length}${dev ? " (сборка для разработки)" : ""}`);
