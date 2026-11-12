// Сервер разработки веб-версии: раздаёт собранный каталог с теми же заголовками, что рабочий nginx,
// и пересылает запросы к серверу аккаунтов и к почте, как это делает nginx на app.tabora.app.
//   node tools/web/dev.mjs [порт] [каталог]
//   TABORA_API=http://127.0.0.1:7711   сервер аккаунтов (по умолчанию локальный)
//   TABORA_JMAP=https://mx.tabora.app  почтовый сервер (JMAP)
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headersFor } from "./headers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8770;
const dir = resolve(process.argv[3] || join(here, "../../.build/web"));
const API = new URL(process.env.TABORA_API || "http://127.0.0.1:7711");
const JMAP = new URL(process.env.TABORA_JMAP || "https://mx.tabora.app");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };

function proxy(req, res, target) {
  const lib = target.protocol === "https:" ? httpsRequest : httpRequest;
  // адрес клиента для сервера аккаунтов — адрес соединения; в проверках (TABORA_DEV_TRUST_XFF=1)
  // его можно задать заголовком, чтобы изобразить посетителей с разных адресов
  const client = (process.env.TABORA_DEV_TRUST_XFF && req.headers["x-forwarded-for"]) || req.socket.remoteAddress || "127.0.0.1";
  const headers = { ...req.headers, host: target.host, "x-forwarded-for": client };
  delete headers.origin;
  delete headers.referer;
  const up = lib({ protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: req.method, path: req.url, headers, family: 4 }, r => {
    const h = { ...r.headers };
    delete h["www-authenticate"]; // иначе браузер покажет своё окно входа вместо формы приложения
    delete h["strict-transport-security"];
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on("error", e => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "offline", message: `сервер недоступен: ${e.message}` }));
  });
  req.pipe(up);
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.startsWith("/v1/") || path.startsWith("/.well-known/openpgpkey/")) {
    return proxy(req, res, API);
  }
  if (path === "/jmap" || path.startsWith("/jmap/")) {
    return proxy(req, res, JMAP);
  }
  let file = normalize(join(dir, path));
  if (!file.startsWith(dir)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, "index.html");
  }
  if (!existsSync(file)) {
    if (extname(path)) {
      res.writeHead(404, headersFor(path)).end("нет такого файла");
      return;
    }
    file = join(dir, "index.html"); // адреса разделов обслуживает само приложение
  }
  const h = headersFor(path);
  delete h["Strict-Transport-Security"]; // сервер разработки работает по http
  res.writeHead(200, { ...h, "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Content-Length": statSync(file).size });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`веб-версия: http://127.0.0.1:${port}/ (аккаунты → ${API.origin}, почта → ${JMAP.origin})`));
