// Build of the Tabora support site: web/ → a directory to serve (.build/support by default).
//   node tools/web/build-support.mjs [directory] [--dev]
// The site shares the web app's base (web/src/core, web/src/lib, the base styles) and has its own
// entry and screens (web/src/support). Script and style file names carry a content hash: nginx
// serves /assets/ as immutable and index.html without caching, so a new build is picked up at once.
//
// The directory gets:
//   index.html                  the page (links to the hashed files)
//   assets/support-<hash>.js    the site
//   assets/style-<hash>.css     its styles
//   assets/kdf-<hash>.js        the worker that derives the login hash from the password (Argon2id)
//   assets/fonts/*.woff2        fonts
//   compat.js, icons/           the check of the browser and the icons
//   build.json                  what the build consists of, with SHA-256 sums
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPlugin, supportSet } from "../i18n/catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const out = resolve(args.find(a => !a.startsWith("--")) || join(root, ".build/support"));
const src = join(root, "web");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

const common = {
  bundle: true,
  platform: "browser",
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
    throw new Error(`no build output for ${entry}`);
  }
  return `/${relative(out, resolve(root, hit[0])).split("\\").join("/")}`;
}

// 1. the worker: a classic script, so that it starts in older phone browsers too
const kdfEntry = join(src, "src/core/kdf.worker.js");
const worker = await build({ ...common, entryPoints: { kdf: kdfEntry }, format: "iife", outdir: join(out, "assets"), entryNames: "[name]-[hash]", absWorkingDir: root });
const kdf = outName(worker, kdfEntry);

// 2. the site and its styles
const mainEntry = join(src, "src/support/main.js");
const cssEntry = join(src, "src/styles/support.css");
const version = JSON.parse(readFileSync(join(root, "browser.json"), "utf8")).brands?.release?.displayVersion || "";
const app = await build({
  ...common,
  entryPoints: { support: mainEntry, style: cssEntry },
  format: "esm",
  splitting: true, // a language's dictionary is a file of its own: a person downloads only theirs
  chunkNames: "chunk-[hash]",
  outdir: join(out, "assets"),
  entryNames: "[name]-[hash]",
  absWorkingDir: root,
  external: ["/assets/fonts/*"],
  // translations: only the strings that occur in the site's code get into the build (i18n/*.json)
  plugins: [catalogPlugin(supportSet)],
  define: { __KDF_WORKER__: JSON.stringify(kdf), __PGP_WORKER__: JSON.stringify(""), __APP_VERSION__: JSON.stringify(version), __DEV__: JSON.stringify(dev) },
});
const js = outName(app, mainEntry);
const css = outName(app, cssEntry);

// 3. static files: the browser check, icons, fonts
cpSync(join(src, "static/compat.js"), join(out, "compat.js"));
cpSync(join(src, "static/icons"), join(out, "icons"), { recursive: true });
mkdirSync(join(out, "assets/fonts"), { recursive: true });
for (const f of readdirSync(join(src, "fonts"))) {
  if (f.endsWith(".woff2")) {
    cpSync(join(src, "fonts", f), join(out, "assets/fonts", f));
  }
}

// 4. the page
const html = readFileSync(join(src, "support.html"), "utf8").replace("__APP_JS__", js).replace("__APP_CSS__", css);
if (/__APP_(JS|CSS)__/.test(html)) {
  throw new Error("support.html still has unfilled places");
}
writeFileSync(join(out, "index.html"), html);

// 5. what the build consists of
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
const size = f => `${(statSync(join(out, f.slice(1))).size / 1024).toFixed(0)} KB`;
console.log(`support site built: ${relative(root, out)} — site ${size(js)}, styles ${size(css)}, kdf ${size(kdf)}, files ${Object.keys(files).length}${dev ? " (dev)" : ""}`);
