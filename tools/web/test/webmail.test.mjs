// Веб-версия и почта по сессии: приложение входит, не получая почтового пароля, и работает с ящиком
// через сервер аккаунтов. Сервер запущен с имитацией почтового сервера (server/tests/fake-jmap.mjs):
//   TABORA_API=http://127.0.0.1:7712 node test/run.mjs webmail
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { hex, random } from "../../../web/src/core/bytes.js";
import { Jmap } from "../../../web/src/core/jmap.js";
import { Mail } from "../../../web/src/core/mail.js";
import { MailPgp } from "../../../web/src/core/mailpgp.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { check, rejects, summary } from "./lib.mjs";

const API = process.env.TABORA_API;
const store = new MemoryStore();
const account = new Account({ api: new Api(API), store });
const name = `wc${Date.now().toString(36)}`;
await account.register(name, "Web-Mail-pass-93!");
const saved = await store.load();
check("после входа у страницы нет почтового пароля: ни в памяти, ни в сохранённой сессии", [account.mailBySession, account.session.mail, JSON.stringify(saved).includes("password")], [true, { address: `${name}@tabora.app`, session: true }, false]);
const jmap = new Jmap(account, { proxy: API, direct: "http://127.0.0.1:1" });
const mail = new Mail({ account, jmap, pgp: new MailPgp(account) });
const boxes = await mail.folders();
check("папки ящика приходят через сервер аккаунтов", [boxes.map(b => `${b.role}:${b.name}`), !!jmap.accountId], [["inbox:Входящие"], true]);
const bytes = random(60000);
const up = await jmap.upload(bytes, "application/octet-stream");
check("файл загружается и скачивается через сервер аккаунтов без искажений", hex(await jmap.download(up.blobId, { name: "файл.bin" })) === hex(bytes), true);
const token = account.token;
await account.api.logout(token);
check("после завершения сессии почта закрыта, и приложение само узнаёт, что вышло", [await rejects(() => jmap.call([["Mailbox/get", { ids: null }]])), account.signedIn], ["session-expired", false]);
summary();
