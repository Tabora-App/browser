// Почта на настоящем ящике тестового аккаунта (рабочий сервер): списки, переписка, отметки,
// отправка себе с вложением, зашифрованное письмо, черновик. За собой убирает.
//   TABORA_MAIL_ACCOUNT=имя TABORA_MAIL_PASSWORD_FILE=файл node test/run.mjs mail
import { readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { hex, random, utf8 } from "../../../web/src/core/bytes.js";
import { Jmap } from "../../../web/src/core/jmap.js";
import { Mail } from "../../../web/src/core/mail.js";
import { MailPgp } from "../../../web/src/core/mailpgp.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { check, rejects, summary } from "./lib.mjs";

const name = process.env.TABORA_MAIL_ACCOUNT;
const password = readFileSync(process.env.TABORA_MAIL_PASSWORD_FILE, "utf8").trim();
const account = new Account({ api: new Api(process.env.TABORA_API || "https://api.tabora.app"), store: new MemoryStore() });
await account.signIn(name, password);
const pgp = new MailPgp(account);
const mail = new Mail({ account, jmap: new Jmap(account, process.env.TABORA_JMAP || "https://mx.tabora.app"), pgp });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const cleanup = [];

async function arrive(subject, folder = "inbox") {
  for (let i = 0; i < 40; i++) {
    await mail.folders({ refresh: true });
    const { items } = await mail.list({ folderId: mail.box(folder).id, limit: 10 });
    const hit = items.find(it => it.subject === subject);
    if (hit) {
      return hit;
    }
    await sleep(750);
  }
  return null;
}

try {
  check("вход и ключи", [account.signedIn, account.keys.state, pgp.ready], [true, "ok", true]);
  const boxes = await mail.folders();
  check("папки: служебные на месте, названия по-русски, порядок как в почте", boxes.filter(b => b.role).map(b => `${b.role}:${b.name}`), ["inbox:Входящие", "drafts:Черновики", "sent:Отправленные", "archive:Архив", "junk:Спам", "trash:Корзина"]);
  const inbox = mail.box("inbox");
  const page = await mail.list({ folderId: inbox.id, limit: 5 });
  check("список входящих: переписки с темой, отправителем, датой и счётом писем", [page.items.length > 0, page.total >= page.items.length, page.items.every(i => i.subject && i.date && i.count >= 1 && Array.isArray(i.ids) && typeof i.unread === "boolean")], [true, true, true]);
  const first = page.items[0];
  const thread = await mail.thread(first.threadId);
  check("переписка открывается: у писем есть текст или вёрстка", [thread.length >= 1, thread.every(m => typeof m.text === "string" && typeof m.html === "string" && m.from && Array.isArray(m.attachments))], [true, true]);
  const unreadOnly = await mail.list({ folderId: inbox.id, view: "unread", limit: 50 });
  check("отбор «непрочитанные» отдаёт только непрочитанные", unreadOnly.items.every(i => i.unread), true);

  // отметки: поставить и вернуть как было
  const m0 = thread[thread.length - 1];
  await mail.setStar([m0.id], !m0.starred);
  await mail.setSeen([m0.id], m0.unread);
  let again = await mail.message(m0.id);
  check("звезда и «прочитано» меняются", [again.starred, again.unread], [!m0.starred, !m0.unread]);
  await mail.setStar([m0.id], m0.starred);
  await mail.setSeen([m0.id], !m0.unread);
  again = await mail.message(m0.id);
  check("и возвращаются как были", [again.starred, again.unread], [m0.starred, m0.unread]);

  // обычное письмо себе с вложением и оформлением
  const file = random(5000);
  const subject1 = `Проверка веб-версии ${stamp}`;
  const sent1 = await mail.send({ to: [account.email], subject: subject1, text: "Привет!\nЭто письмо из веб-версии.", html: "<p>Привет!</p><p>Это письмо из <b>веб-версии</b>.</p>", attachments: [{ name: "данные.bin", type: "application/octet-stream", bytes: file }] });
  cleanup.push(sent1.id);
  check("письмо отправлено", [!!sent1.id, /@tabora\.app$/.test(sent1.messageId), sent1.encrypted], [true, true, false]);
  const got1 = await arrive(subject1);
  check("письмо пришло во входящие непрочитанным и с отметкой вложения", [!!got1, got1?.unread, got1?.hasAttachment, got1?.from.email], [true, true, true, account.email]);
  const th1 = await mail.thread(got1.threadId);
  const in1 = th1.find(m => m.mailboxIds.includes(inbox.id));
  cleanup.push(...th1.map(m => m.id));
  check("в переписке письмо из «Отправленных» и письмо из «Входящих»", [th1.length, th1.some(m => m.mailboxIds.includes(mail.box("sent").id))], [2, true]);
  check("текст, вёрстка и вложение дошли без искажений", [in1.text.trim(), /<b>веб-версии<\/b>/.test(in1.html), in1.attachments.map(a => [a.name, a.size]), hex(await mail.attachment(in1, in1.attachments[0])) === hex(file), in1.pgp], ["Привет!\nЭто письмо из веб-версии.", true, [["данные.bin", 5000]], true, null]);

  // зашифрованное письмо себе
  const plan = await mail.plan(account.email, [account.email]);
  check("шифрование себе возможно", [plan.available, plan.possible], [true, true]);
  check("внешнему адресу отсюда зашифровать нельзя", (await mail.plan(account.email, ["someone@example.org"])).possible, false);
  const subject2 = `Секретная проверка ${stamp}`;
  const sent2 = await mail.send({ to: [account.email], subject: subject2, text: "Тайный текст письма", html: "<p>Тайный <i>текст</i> письма</p>", attachments: [{ name: "тайна.txt", type: "text/plain", bytes: utf8("содержимое вложения") }], encrypt: true });
  cleanup.push(sent2.id);
  const got2 = await arrive(subject2);
  const th2 = await mail.thread(got2.threadId);
  cleanup.push(...th2.map(m => m.id));
  const in2 = th2.find(m => m.mailboxIds.includes(inbox.id));
  check("зашифрованное письмо пришло, расшифровано, подпись верна", [in2.pgp, in2.text.trim(), /<i>текст<\/i>/.test(in2.html)], [{ encrypted: true, signature: "valid", signer: account.email }, "Тайный текст письма", true]);
  check("вложение из зашифрованного письма открывается", [in2.attachments.map(a => a.name), new TextDecoder().decode(await mail.attachment(in2, in2.attachments[0]))], [["тайна.txt"], "содержимое вложения"]);
  const raw2 = new TextDecoder().decode(await mail.jmap.download(in2.blobId, { name: "m.eml", type: "message/rfc822" }));
  check("на сервере письмо лежит зашифрованным: ни текста, ни имени вложения в нём нет", [raw2.includes("multipart/encrypted"), raw2.includes("Тайный"), raw2.includes("0KLQsNC50L3Ri9C5"), /тайна|=D1=82=D0=B0=D0=B9=D0=BD=D0=B0/.test(raw2), raw2.includes("Autocrypt:")], [true, false, false, false, true]);
  check("письмо со скрытой копией зашифрованным не уходит", await rejects(() => mail.send({ to: [account.email], bcc: ["x@example.org"], subject: "x", text: "x", encrypt: true })), "pgp");

  // ответ
  const reply = await mail.send({ to: [account.email], subject: `Re: ${subject1}`, text: "Ответ", original: in1 });
  cleanup.push(reply.id);
  await arrive(`Re: ${subject1}`);
  const th3 = await mail.thread(got1.threadId);
  cleanup.push(...th3.map(m => m.id));
  check("ответ лёг в ту же переписку, исходное письмо отмечено отвеченным", [th3.length >= 3, (await mail.message(in1.id)).answered], [true, true]);

  // черновик
  const draft1 = await mail.saveDraft({ to: ["friend@example.org"], subject: `Черновик ${stamp}`, text: "недописанное письмо", html: "<p>недописанное письмо</p>" });
  const draft2 = await mail.saveDraft({ to: ["friend@example.org"], subject: `Черновик ${stamp}`, text: "недописанное письмо, вторая версия", replaces: draft1 });
  cleanup.push(draft2);
  const drafts = await mail.list({ folderId: mail.box("drafts").id, limit: 20 });
  const d = await mail.message(draft2);
  check("черновик сохранён в «Черновики», прежняя версия удалена, содержимое зашифровано для себя", [drafts.items.filter(i => i.subject === `Черновик ${stamp}`).length, d.draft, d.text.trim(), d.pgp?.encrypted, d.to.map(t => t.email)], [1, true, "недописанное письмо, вторая версия", true, ["friend@example.org"]]);

  // поиск
  const found = await mail.list({ folderId: inbox.id, query: `Секретная проверка ${stamp}` });
  check("поиск находит письмо по теме", found.items.some(i => i.subject === subject2), true);

  // перенос в корзину и удаление
  await mail.move([in1.id], "trash");
  check("письмо перенесено в корзину", (await mail.message(in1.id)).mailboxIds, [mail.box("trash").id]);
  check("изменения в ящике видны опросом", await mail.changed().then(() => typeof mail.state), "string");
} finally {
  const ids = [...new Set(cleanup)];
  await mail.remove(ids, { forever: true }).catch(e => console.log("уборка не удалась:", e.message));
  const left = await mail.jmap.call([["Email/get", { ids, properties: ["id"] }]]).then(([r]) => r.list.length).catch(() => -1);
  check("проверочные письма убраны", left, 0);
  await account.signOut();
}
summary();
