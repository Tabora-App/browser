# Заголовки сайта tabora.app. add_header в location отменяет унаследованные, поэтому этот файл
# подключается и на уровне server, и в каждом location со своим add_header.
include snippets/tabora-security.conf;
# сайт статический: стили из /site.css, скриптов нет ('self' только для подстановок Cloudflare в /cdn-cgi/)
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests" always;
