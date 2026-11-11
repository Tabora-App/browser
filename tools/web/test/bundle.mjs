// Собрать один файл проверки под Node: node test/bundle.mjs <исходник> <куда>
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [entry, outfile] = process.argv.slice(2);
await build({ entryPoints: [resolve(entry)], bundle: true, platform: "node", format: "esm", target: "node20", outfile: resolve(outfile), logLevel: "warning", nodePaths: [join(here, "../node_modules")], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
