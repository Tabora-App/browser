// The support site on a local server (scratchpad srv2/local.sh): the narrow sign-in, requests of
// an account and requests without an account.
//   TABORA_API=http://127.0.0.1:7711 TABORA_OUTBOX=<the server's letters> node test/run.mjs support
import { readdirSync, readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { DeskSession, deskLabel } from "../../../web/src/support/session.js";
import { check, rejects, summary, totp } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const OUTBOX = process.env.TABORA_OUTBOX || "";
const name = `desk${Date.now().toString(36)}`;
const email = `${name}@tabora.app`;
const PASS = "Desk-Check-pass-17!";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const letters = to => readdirSync(OUTBOX).filter(f => f.endsWith(".json")).sort().map(f => JSON.parse(readFileSync(`${OUTBOX}/${f}`, "utf8"))).filter(m => m.to === to);

// an account made the usual way, in the web app
const web = new Account({ api: new Api(API), store: new MemoryStore() });
await web.register(name, PASS);
const made = await web.api.supportCreate(web.token, { subject: "Вопрос из приложения", text: "Написано в веб-версии" });

// ---- the sign-in of the support site ----
const store = new MemoryStore();
const api = new Api(API);
const desk = new DeskSession({ api, store });
const events = [];
desk.subscribe(e => events.push(e));
check("чужой домен и кривое имя отклоняются до сервера; неверный пароль — сервером", [await rejects(() => desk.signIn("kot@example.org", "x")), await rejects(() => desk.signIn("a..b", "x")), await rejects(() => desk.signIn(name, "Wrong-pass-123!"))], ["bad-email", "bad-email", "bad-credentials"]);
await desk.signIn(name, PASS);
const saved = await store.load();
check("вход на сайте поддержки: сессия есть, в хранилище только адрес и токен — ни ключа данных, ни доступа к почте", [desk.signedIn, desk.email, Object.keys(saved).sort(), events], [true, email, ["email", "token"], ["signed-in"]]);
check("название входа в списке устройств говорит, что это сайт поддержки", [/^Сайт поддержки/.test(deskLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")), (await web.api.devices(web.token)).some(d => /^Сайт поддержки/.test(d.name))], [true, true]);
const mine = await api.supportTickets(desk.token);
check("сессия сайта видит обращения аккаунта, созданные в приложении", [mine.staff, mine.tickets.map(x => x.id), (await api.supportTicket(desk.token, made.id)).messages[0].text], [false, [made.id], "Написано в веб-версии"]);
const replied = await api.supportReply(desk.token, made.id, { text: "Дополнение с сайта", files: [{ name: "note.txt", type: "text/plain", data: Buffer.from("строка").toString("base64") }] });
const blob = await api.supportFile(desk.token, replied.messages[1].files[0].id);
const second = await api.supportCreate(desk.token, { subject: "Создано на сайте", text: "Текст", meta: { site: "support" } });
check("…отвечает в них с вложением, скачивает его и создаёт новые", [replied.messages.length, replied.messages[1].files[0].name, await blob.text(), second.id > made.id, (await api.supportStatus(desk.token, second.id, "closed")).status], [2, "note.txt", "строка", true, "closed"]);
check("…но к почте, ключам, устройствам, настройкам входа и синхронизации не допускается",
  [await rejects(() => api.devices(desk.token)), await rejects(() => api.security(desk.token)), await rejects(() => api.aliases(desk.token)), await rejects(() => api.mailKeys(desk.token)), await rejects(() => api.syncPull(desk.token)), await rejects(() => api.mailPassword(desk.token)), await rejects(() => api.pairStart(desk.token))],
  Array(7).fill("session-scope"));

// the saved sign-in comes back; signing out ends it on the server
const again = new DeskSession({ api: new Api(API), store });
check("сохранённый вход поднимается без пароля", [await again.restore(), again.signedIn, again.email, (await again.api.supportTickets(again.token)).tickets.length], [true, true, email, 2]);
await desk.signOut();
check("выход завершает сессию на сервере и стирает запись", [desk.signedIn, await store.load(), await rejects(() => again.api.supportTickets(again.token)), again.signedIn, events.slice(-1)], [false, null, "session-expired", false, ["signed-out"]]);

// ---- two-step protection ----
const setup = await web.api.twoFactorSetup(web.token, await web.loginHashFor(PASS));
await web.api.twoFactorEnable(web.token, await totp(setup.secret));
const two = new DeskSession({ api: new Api(API), store: new MemoryStore() });
const needs = await rejects(() => two.signIn(name, PASS));
const wrong = await rejects(() => two.signIn(name, "", { totp: "000000" }));
await sleep(31000 - (Date.now() % 30000)); // the code used to turn the protection on cannot be used twice
await two.signIn(name, "", { totp: await totp(setup.secret) });
check("аккаунт со вторым шагом: без кода входа нет, неверный код отклонён, верный входит без повторного пароля", [needs, wrong, two.signedIn, (await two.api.supportTickets(two.token)).tickets.length], ["2fa-required", "bad-2fa", true, 2]);
await two.signOut();

// ---- a request without an account ----
if (OUTBOX) {
  const guestMail = `guest.${name}@example.org`;
  const g = new Api(API);
  check("без адреса для ответа и с адресом Tabora обращение не принимается", [await rejects(() => g.supportGuestCreate({ email: "", subject: "Тема обращения", text: "Текст", lang: "ru" })), await rejects(() => g.supportGuestCreate({ email, subject: "Тема обращения", text: "Текст", lang: "ru" }))], ["support-invalid", "support-invalid"]);
  const sent = await g.supportGuestCreate({ email: guestMail, subject: "Не приходит код", text: "Жду код входа уже час", lang: "uk" });
  const first = letters(guestMail)[0];
  const key = (/#t=(\d+\.[A-Za-z0-9_-]{32})/.exec(first?.text || "") || [])[1] || "";
  check("обращение без аккаунта: на адрес уходит письмо со ссылкой на языке обращения и без текста автора", [sent, !!key, /^Tabora: підтвердьте звернення № \d+$/.test(first?.subject || ""), /Жду код|Не приходит/.test(first?.text || "")], [{ sent: true }, true, true, false]);
  check("ключ с опечаткой ничего не открывает", await rejects(() => g.supportGuestOpen(key.replace(/.$/, c => (c === "A" ? "B" : "A")))), "not-found");
  const opened = await g.supportGuestOpen(key);
  check("ссылка открывает обращение его автору", [opened.guest, opened.email, opened.staff, opened.status, opened.messages.map(m => [m.from, m.text])], [true, guestMail, false, "open", [["user", "Жду код входа уже час"]]]);
  const more = await g.supportGuestReply(key, "Код пришёл, спасибо");
  check("автор пишет ещё и закрывает обращение", [more.messages.length, (await g.supportGuestStatus(key, "closed")).status, await rejects(() => g.supportGuestStatus(key, "gone"))], [2, "closed", "support-invalid"]);
  check("обычному аккаунту чужое обращение без аккаунта не видно", await rejects(() => web.api.supportTicket(web.token, opened.id)), "not-found");
}

summary();
