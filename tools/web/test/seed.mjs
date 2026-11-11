// Наполнить аккаунт на локальном сервере данными для снимков и ручной проверки интерфейса:
// пароли, коды, закладки, вкладки «компьютера», обращение в поддержку.
//   node <сборка> <адрес сервера> <имя> <файл с паролем>
import { readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { marksAdd, newLogin, newOtp } from "../../../web/src/core/records.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";

const [api, name, passwordFile] = process.argv.slice(2);
const password = readFileSync(passwordFile, "utf8").trim();
const account = new Account({ api: new Api(api), store: new MemoryStore("web-seed000000000000000001") });
try {
  await account.register(name, password);
} catch (e) {
  if (e.code !== "taken") throw e;
  await account.signIn(name, password);
}
const sync = new SyncClient(account);
await sync.refresh();
if (!sync.list("logins").length) {
  for (const [site, username, pw] of [["github.com", "anna.k", "gh-Demo-Secret-9!x"], ["mail.yandex.ru", "anna@yandex.ru", "ya-Demo-77-secret"], ["booking.com", "anna.k@tabora.app", "bk-Trip-2026-demo"], ["ozon.ru", "+7 900 000-00-00", "oz-demo-Pass-31"], ["gosuslugi.ru", "anna.k@tabora.app", "gu-Demo-Long-Pass-5"], ["figma.com", "anna.k@tabora.app", "fg-Demo-Design-12"], ["aviasales.ru", "anna.k@tabora.app", "av-demo-Fly-88"]]) {
    const l = newLogin({ site, username, password: pw });
    await sync.put("logins", l.id, l.data);
  }
  for (const [issuer, acc, secret] of [["GitHub", "anna.k", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"], ["Яндекс", "anna@yandex.ru", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"], ["Госуслуги", "anna.k@tabora.app", "MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK"], ["Figma", "anna.k@tabora.app", "KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU"]]) {
    const o = await newOtp({ issuer, account: acc, secret });
    await sync.put("otp", o.id, o.data);
    await new Promise(r => setTimeout(r, 5));
  }
  const folder = marksAdd(sync.list("marks"), "toolbar_____", { title: "Работа" });
  await sync.write(folder.changes);
  for (const [title, url] of [["Макеты", "https://www.figma.com/files"], ["Задачи", "https://github.com/issues"], ["Документация", "https://developer.mozilla.org/ru/"]]) {
    await sync.write(marksAdd(sync.list("marks"), folder.id, { title, url }).changes);
  }
  const trip = marksAdd(sync.list("marks"), "toolbar_____", { title: "Поездка в Казань" });
  await sync.write(trip.changes);
  await sync.write(marksAdd(sync.list("marks"), trip.id, { title: "Билеты", url: "https://www.aviasales.ru/" }).changes);
  for (const [title, url] of [["Сайт Tabora", "https://tabora.app/"], ["Погода", "https://yandex.ru/pogoda"], ["Рецепт сырников", "https://eda.ru/recepty/zavtraki/syrniki"]]) {
    await sync.write(marksAdd(sync.list("marks"), "toolbar_____", { title, url }).changes);
  }
  await sync.put("tabs", "seeddevicemacbook00000001", { name: "MacBook Анны", at: Date.now() - 4 * 60000, tabs: [{ t: "Tabora — браузер без рекламы, с почтой и кошельком", u: "https://tabora.app/", p: 1 }, { t: "Расписание поездов Москва — Казань", u: "https://www.tutu.ru/poezda/rasp_d.php?nnst1=2000000&nnst2=2060500" }, { t: "MDN: CSS Grid", u: "https://developer.mozilla.org/ru/docs/Web/CSS/CSS_grid_layout" }, { t: "Как выбрать палатку — статья", u: "https://sport-marafon.ru/article/kak-vybrat-palatku/" }] });
  await sync.put("tabs", "seeddeviceimac0000000002", { name: "iMac дома", at: Date.now() - 26 * 3600000, tabs: [{ t: "Рецепт сырников", u: "https://eda.ru/recepty/zavtraki/syrniki" }, { t: "Госуслуги", u: "https://www.gosuslugi.ru/" }] });
  const t = await account.api.supportCreate(account.token, { subject: "Не приходит код с одного сайта", text: "Добрый день! Письмо с кодом от booking.com не приходит уже полчаса. Остальная почта работает.", meta: { app: "Веб-версия" } });
  console.log("обращение №", t.id);
}
console.log(JSON.stringify({ email: account.email, keys: account.keys.state, logins: sync.list("logins").length, otp: sync.list("otp").length, marks: sync.list("marks").length, tabs: sync.list("tabs").length }));
