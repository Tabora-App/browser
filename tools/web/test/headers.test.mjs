// Заголовки безопасности веб-версии заданы в двух местах: tools/web/headers.mjs (сервер разработки)
// и infra/nginx/app-*.inc (рабочий nginx). Они обязаны совпадать: иначе на рабочем сервере страница
// получит не ту политику содержимого, с которой её проверяли.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headersFor } from "../headers.mjs";
import { check, summary } from "./lib.mjs";

const repo = process.env.TABORA_REPO || join(process.cwd(), "../..");
const read = p => readFileSync(join(repo, p), "utf8");
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
