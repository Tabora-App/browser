// Заголовки ответов веб-версии. Один источник для сервера разработки (dev.mjs) и для проверки
// настроек nginx (infra/nginx/app.conf должен отдавать то же самое: test/headers.test.mjs).
//
// Приложению разрешено только своё: скрипты, стили, шрифты и запросы — с того же имени. Ни одного
// стороннего адреса и ни одного встроенного скрипта или стиля. 'wasm-unsafe-eval' нужен быстрому
// расчёту ключа из пароля (WebAssembly); он не разрешает eval обычных скриптов.
export const SECURITY = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

export const APP_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
  "worker-src 'self'; frame-src 'self'; manifest-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Рамка письма: документ без скриптов, в который приложение вкладывает очищенную вёрстку письма.
// Ей нужны встроенные стили (письма свёрстаны ими), но не нужны ни сеть, ни скрипты. Во втором
// документе разрешены картинки с чужих серверов — его рамка получает, когда человек нажал
// «Показать картинки».
const FRAME = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const FRAME_CSP = `${FRAME}; img-src data: blob:`;
export const FRAME_REMOTE_CSP = `${FRAME}; img-src data: blob: https:`;

export function headersFor(path) {
  if (path === "/frame/mail.html") {
    return { ...SECURITY, "Content-Security-Policy": FRAME_CSP, "X-Frame-Options": "SAMEORIGIN", "Cache-Control": "no-cache" };
  }
  if (path === "/frame/mail-remote.html") {
    return { ...SECURITY, "Content-Security-Policy": FRAME_REMOTE_CSP, "X-Frame-Options": "SAMEORIGIN", "Cache-Control": "no-cache" };
  }
  const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return { ...SECURITY, "Content-Security-Policy": APP_CSP, "X-Frame-Options": "DENY", "Cache-Control": cache };
}
