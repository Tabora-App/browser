// Autofill addresses and bank cards in the phone app (web/src/phone/autofill.js) against the local
// server: records of the "computer" appear in the app's storage, records saved on the phone reach
// the computer in the form the desktop browser reads, twins merge into one record, edits and
// deletions go both ways, cards are synced only after the switch is turned on, and the card's
// security code is never taken. The app is replaced by a stand-in whose storage gives records its
// own IDs, like the real one.
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs autofill
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";
import { addressFields, cardFields } from "../../../web/src/phone/autofill.js";
import { Service } from "../../../web/src/phone/service.js";
import { NativeStore } from "../../../web/src/phone/store.js";
import { check, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `af${Date.now().toString(36)}`;
const PASSWORD = "Autofill-Check-pass-17!";
const PHONE_ID = `and-${Date.now().toString(36)}aaaaaaaaaa`.slice(0, 22);
const DESK_ID = "web-computer0000000000";

/** The app: keeps the sign-in and the module's data, and the autofill storage with its own IDs. */
// the app's storage works out the card's network by itself and under its own names
const stored = (kind, f) => (kind === "cards" ? { ...f, "cc-type": f["cc-number"].startsWith("4") ? "visa" : "other" } : { ...f });

class FakeApp {
  /** Save a record on the phone, as the app itself does. */
  save(kind, f, at = Date.now()) {
    const guid = `app-${kind[0]}${++this.seq}`;
    this[kind].set(guid, { guid, f: stored(kind, f), c: at, m: at });
    return guid;
  }
  fields(kind) {
    return [...this[kind].values()].map(r => r.f);
  }
  constructor() {
    this.saved = null;
    this.data = {};
    this.addresses = new Map(); // the app's autofill storage: its own ID → { guid, f, c, m }
    this.cards = new Map();
    this.seq = 0;
    this.calls = [];
    this.broken = false;
    this.states = [];
    this.handlers = [];
  }
  get last() {
    return this.states[this.states.length - 1];
  }
  connect() {}
  onMessage(fn) {
    this.handlers.push(fn);
  }
  /** A message from the app to the module. */
  say(message) {
    this.handlers.forEach(fn => fn(message));
  }
  post(message) {
    if (message.type === "state") {
      this.states.push(JSON.parse(JSON.stringify(message)));
    }
  }
  async call(message) {
    const m = /^(addresses|cards)-(list|add|update|delete)$/.exec(message.type);
    if (m) {
      this.calls.push(message.type);
      if (this.broken) {
        return {};
      }
      const box = this[m[1]];
      if (m[2] === "list") {
        return { items: [...box.values()].map(r => JSON.parse(JSON.stringify(r))) };
      }
      if (m[2] === "add") {
        const guid = `app-${m[1][0]}${++this.seq}`;
        box.set(guid, { guid, f: stored(m[1], message.f), c: Date.now(), m: Date.now() });
        return { guid };
      }
      if (m[2] === "update") {
        if (!box.has(message.guid)) {
          return { error: "no such record" };
        }
        box.set(message.guid, { ...box.get(message.guid), f: stored(m[1], message.f), m: Date.now() });
        return { ok: true };
      }
      box.delete(message.guid);
      return { ok: true };
    }
    if (message.type === "marks-tree") {
      return { nodes: [] };
    }
    if (message.type === "logins-list") {
      return { logins: [] };
    }
    if (message.type === "spaces-list") {
      return { spaces: [] };
    }
    return { ok: true };
  }
  async request(message) {
    if (message.type === "store-load") {
      return { deviceId: PHONE_ID, deviceName: "Проверочный телефон", session: this.saved };
    }
    if (message.type === "store-save") {
      this.saved = message.session;
      return { ok: true };
    }
    if (message.type === "store-clear") {
      this.saved = null;
      return { ok: true };
    }
    if (message.type === "data-load") {
      return { value: this.data[message.name] ?? null };
    }
    if (message.type === "data-save") {
      this.data[message.name] = message.value;
      return { ok: true };
    }
    if (message.type === "data-clear") {
      delete this.data[message.name];
      return { ok: true };
    }
    return {};
  }
}

const memory = (on = true) => ({ get: () => on, set: v => (on = v) });
const off = { tabs: memory(false), codes: memory(false), logins: memory(false), marks: memory(false), spaces: memory(false), history: memory(false) };
const phone = (app, cards = memory(false)) => new Service({ bridge: app, store: new NativeStore(app), api: new Api(API), settings: { ...off, addresses: memory(), cards } });

/* ---- checks of the fields ---- */

check("поля адреса: только известные, строки, страна из двух букв", [
  addressFields({ name: " Анна ", tel: "+380441234567", country: "Украина", extra: "x", email: 5, "cc-number": "4111111111111111" }),
  addressFields({ organization: "", extra: "только лишнее" }),
], [{ name: "Анна", tel: "+380441234567" }, null]);
check("поля карты: номер из 12–19 цифр обязателен, код безопасности не берётся", [
  cardFields({ "cc-number": "4111 1111-1111 1111", "cc-name": "ANNA", "cc-exp-month": "12", "cc-exp-year": 2030, "cc-csc": "123", "cc-type": "visa" }),
  cardFields({ "cc-number": "12ab", "cc-name": "X" }),
  cardFields({ "cc-number": "5555555555554444", "cc-exp-month": 13, "cc-exp-year": 1999 }),
], [{ "cc-number": "4111111111111111", "cc-name": "ANNA", "cc-exp-month": 12, "cc-exp-year": 2030, "cc-type": "visa" }, null, { "cc-number": "5555555555554444" }]);

/* ---- the "computer" ---- */

const computer = new Account({ api: new Api(API), store: new MemoryStore(DESK_ID) });
await computer.register(name, PASSWORD);
const desk = new SyncClient(computer);
await desk.refresh();
await desk.write([
  { c: "addresses", id: "deskaddr0001", data: { f: { name: "Борис Компьютерный", "street-address": "пр. Сервера, 7", country: "PL", tel: "+48111222333", "cc-csc": "123" }, c: 1, m: 2 } },
  { c: "addresses", id: "twinaddr0001", data: { f: { name: "Двойник", "street-address": "ул. Одинаковая, 2", country: "UA" }, c: 1, m: 2 } },
  { c: "cards", id: "deskcard0001", data: { f: { "cc-number": "5555555555554444", "cc-name": "BORIS DESK", "cc-exp-month": 3, "cc-exp-year": 2031, "cc-type": "mastercard", "cc-csc": "999" }, c: 1, m: 2 } },
  { c: "cards", id: "badcard00001", data: { f: { "cc-number": "не номер" }, c: 1, m: 2 } },
]);
const deskList = c => desk.list(c).map(r => [r.id, r.data.f]).sort((a, b) => JSON.stringify(a[1]).localeCompare(JSON.stringify(b[1])));

/* ---- sign-in: addresses merge, cards wait for the switch ---- */

const app = new FakeApp();
app.save("addresses", { name: "Анна Телефонная", "street-address": "ул. Проверочная, 1", "address-level2": "Киев", country: "UA", tel: "+380441234567" });
app.save("addresses", { name: "Двойник", "street-address": "ул. Одинаковая, 2", country: "UA" });
app.save("cards", { "cc-number": "4111111111111111", "cc-name": "ANNA PHONE", "cc-exp-month": 12, "cc-exp-year": 2030 });
const cardsSwitch = memory(false);
let svc = phone(app, cardsSwitch);
await svc.ready;
await svc.account.signIn(name, PASSWORD);
await svc.run();
await desk.refresh();
check("адреса компьютера появились на телефоне, лишние поля отброшены; одинаковый адрес остался один", app.fields("addresses").map(f => f.name).sort(), ["Анна Телефонная", "Борис Компьютерный", "Двойник"]);
check("адрес телефона ушёл в аккаунт в том виде, который читает компьютер; двойник остался под номером компьютера", [
  deskList("addresses").map(([, f]) => f.name).sort(), deskList("addresses").find(([, f]) => f.name === "Двойник")[0],
  /^[0-9a-f]{12}$/.test(deskList("addresses").find(([, f]) => f.name === "Анна Телефонная")[0]), deskList("addresses").find(([, f]) => f.name === "Анна Телефонная")[1],
], [["Анна Телефонная", "Борис Компьютерный", "Двойник"], "twinaddr0001", true, { name: "Анна Телефонная", "street-address": "ул. Проверочная, 1", "address-level2": "Киев", country: "UA", tel: "+380441234567" }]);
check("карты, пока набор выключен, не трогаются: ни в аккаунт, ни из аккаунта", [app.fields("cards").length, desk.list("cards").length, app.calls.some(c => c.startsWith("cards-")), svc.state().cardsOn, svc.state().addressesOn, svc.state().addresses], [1, 2, false, false, true, 3]);
const rev = desk.rev;
await svc.run();
await desk.refresh();
check("повторная сверка без перемен ничего не пишет", desk.rev, rev);

/* ---- cards after the switch ---- */

await svc.setAutofill("cards", true);
await svc.run();
await desk.refresh();
check("после включения: карта компьютера легла на телефон без кода безопасности, негодная не взята", [app.fields("cards").map(f => [f["cc-number"], f["cc-name"], f["cc-exp-month"], f["cc-exp-year"]]).sort(), JSON.stringify(app.fields("cards")).includes("999")],
  [[["4111111111111111", "ANNA PHONE", 12, 2030], ["5555555555554444", "BORIS DESK", 3, 2031]], false]);
check("карта телефона ушла в аккаунт: номер, срок, имя; сеть карты у каждого хранилища своя и в сравнении не участвует", [
  deskList("cards").filter(([id]) => id !== "badcard00001").map(([, f]) => [f["cc-number"], f["cc-name"]]).sort(), desk.get("cards", "deskcard0001").f["cc-type"], svc.state().cards,
], [[["4111111111111111", "ANNA PHONE"], ["5555555555554444", "BORIS DESK"]], "mastercard", 2]);
const rev2 = desk.rev;
await svc.run();
await desk.refresh();
check("сеть карты, записанная хранилищем телефона по-своему, не вызывает перезаписи туда-сюда", desk.rev, rev2);

/* ---- edits and deletions both ways ---- */

await desk.put("addresses", "deskaddr0001", { f: { name: "Борис Компьютерный", "street-address": "пр. Сервера, 7", country: "PL", tel: "+48999888777" }, c: 1, m: Date.now() });
await desk.remove("cards", "deskcard0001");
await svc.run();
check("правка адреса и удаление карты на компьютере дошли до телефона", [app.fields("addresses").find(f => f.name === "Борис Компьютерный").tel, app.fields("cards").map(f => f["cc-number"])], ["+48999888777", ["4111111111111111"]]);
const anna = [...app.addresses.values()].find(r => r.f.name === "Анна Телефонная");
app.addresses.set(anna.guid, { ...anna, f: { ...anna.f, tel: "+380501112233" }, m: Date.now() + 1000 });
const twin = [...app.addresses.values()].find(r => r.f.name === "Двойник");
app.addresses.delete(twin.guid);
await svc.run();
await desk.refresh();
check("правка и удаление на телефоне дошли до компьютера", [deskList("addresses").find(([, f]) => f.name === "Анна Телефонная")[1].tel, desk.get("addresses", "twinaddr0001")], ["+380501112233", null]);

/* ---- the app does not answer; restart ---- */

app.broken = true;
await svc.run();
check("приложение не ответило об адресах и картах: остальное сверено, ошибка видна", [svc.state().status, !!svc.state().addressesError, !!svc.state().cardsError], ["ok", true, true]);
app.broken = false;
await svc.saveNow();
svc.stop();
app.handlers = [];
svc = phone(app, cardsSwitch);
await svc.ready;
const before = [app.addresses.size, app.cards.size, desk.rev];
await svc.run();
await desk.refresh();
check("после перезапуска повторная сверка ничего не дублирует и не пишет", [app.addresses.size, app.cards.size, desk.rev, svc.state().addressesError], [before[0], before[1], before[2], ""]);

/* ---- turning off ---- */

await svc.setAutofill("cards", false);
await desk.put("cards", "latecard0001", { f: { "cc-number": "378282246310005", "cc-name": "LATE" }, c: 1, m: 2 });
await svc.run();
await desk.refresh();
check("карты выключили: новая карта с компьютера на телефон не приходит, карта телефона в аккаунте осталась", [app.fields("cards").length, desk.list("cards").some(r => r.data.f["cc-number"] === "4111111111111111"), app.data.cards], [1, true, undefined]);

svc.stop();
await computer.signOut();
summary();
