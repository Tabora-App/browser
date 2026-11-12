// Запуск проверок веб-версии под Node: каждый файл test/*.test.mjs собирается esbuild (так же, как
// приложение) и выполняется. Аргументы: имена проверок без расширения (по умолчанию все).
//   node test/run.mjs core            # одна проверка
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs account
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPlugin, webSet } from "../../i18n/catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../../.build/web-test");
mkdirSync(out, { recursive: true });
const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(here).filter(f => f.endsWith(".test.mjs")).map(f => f.replace(/\.test\.mjs$/, ""));
let failed = 0;
for (const name of names) {
  const outfile = join(out, `${name}.mjs`);
  await build({ entryPoints: [join(here, `${name}.test.mjs`)], bundle: true, platform: "node", format: "esm", target: "node20", outfile, logLevel: "warning", plugins: [catalogPlugin(webSet)], nodePaths: [join(here, "../node_modules")], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  const r = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    failed++;
  }
}
process.exit(failed ? 1 : 0);
