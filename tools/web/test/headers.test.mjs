// The security headers of the web app are defined in two places: tools/web/headers.mjs (development
// server) and infra/nginx/app-*.inc in the server repository (production nginx, Tabora-App/server).
// They must match: otherwise the production page gets a content policy it was not tested with.
// The server repository is looked for next to this one (../tabora-server or ../server) or at
// TABORA_SERVER_REPO; without it the check is skipped.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { headersFor } from "../headers.mjs";
import { check, summary } from "./lib.mjs";

const repo = process.env.TABORA_REPO || join(process.cwd(), "../..");
const server = [process.env.TABORA_SERVER_REPO, join(repo, "../tabora-server"), join(repo, "../server")].find(d => d && existsSync(join(d, "infra/nginx/app.conf")));
if (!server) {
  console.log("SKIP nginx headers: no checkout of Tabora-App/server found (set TABORA_SERVER_REPO)");
  summary();
  process.exit(0);
}
const read = p => readFileSync(join(server, p), "utf8");
const parse = text => Object.fromEntries([...text.matchAll(/^\s*add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always;/gm)].map(m => [m[1], m[2]]));
const without = (h, ...names) => Object.fromEntries(Object.entries(h).filter(([k]) => !names.includes(k)));

for (const [file, path] of [["app-headers.inc", "/"], ["app-frame-headers.inc", "/frame/mail.html"], ["app-frame-remote-headers.inc", "/frame/mail-remote.html"]]) {
  check(`${file}: заголовки nginx совпадают с заголовками сервера разработки для ${path}`, parse(read(`infra/nginx/${file}`)), without(headersFor(path), "Cache-Control"));
}
const conf = read("infra/nginx/app.conf");
const block = name => {
  const a = conf.indexOf(`location ${name} {`);
  return a < 0 ? "" : conf.slice(a, conf.indexOf("}", a));
};
check("страница, файлы сборки и рамки письма получают каждый свои заголовки", [
  /tabora-app-headers\.conf/.test(block("/")), /"no-cache"/.test(block("/")),
  /tabora-app-headers\.conf/.test(block("/assets/")), /immutable/.test(block("/assets/")),
  /tabora-app-frame-headers\.conf/.test(block("= /frame/mail.html")), /tabora-app-frame-remote-headers\.conf/.test(block("= /frame/mail-remote.html")),
], [true, true, true, true, true, true]);
check("сервер аккаунтов отвечает на том же имени, что страница, и не показывает окно входа браузера", [/proxy_pass http:\/\/127\.0\.0\.1:7700/.test(block("/v1/")), /proxy_hide_header WWW-Authenticate/.test(block("/v1/")), /location \/jmap/.test(conf)], [true, true, false]);
const csp = headersFor("/")["Content-Security-Policy"];
check("политика содержимого страницы: ни встроенных скриптов, ни чужих адресов", [/'unsafe-inline'|'unsafe-eval'[^-]|https?:|\*/.test(csp), /default-src 'none'/.test(csp), /connect-src 'self'/.test(csp), /frame-ancestors 'none'/.test(csp)], [false, true, true, true]);
summary();
