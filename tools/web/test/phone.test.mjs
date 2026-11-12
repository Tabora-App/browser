// Модуль аккаунта для телефона (web/src/phone) на местном сервере: вход, сохранение входа у
// приложения, вкладки телефона на другом устройстве и наоборот, выключение, выход, отзыв сессии.
// Приложение заменено имитацией канала связи; второе устройство — клиент веб-ядра, который пишет
// запись вкладок в том же виде, что браузер на компьютере.
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs phone
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";
import { Service } from "../../../web/src/phone/service.js";
import { NativeStore } from "../../../web/src/phone/store.js";
import { TabSync } from "../../../web/src/phone/tabs.js";
import { check, rejects, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `ph${Date.now().toString(36)}`;
const PASSWORD = "Phone-Check-pass-17!";
const PHONE_ID = `and-${Date.now().toString(36)}xxxxxxxxxx`.slice(0, 22);

/** Приложение: хранит вход и принимает состояние. */
class FakeApp {
  constructor() {
    this.saved = null;
    this.states = [];
    this.handlers = [];
    this.failSave = false;
  }
  connect() {}
  onMessage(fn) {
    this.handlers.push(fn);
  }
  post(message) {
    this.states.push(JSON.parse(JSON.stringify(message)));
  }
  async request(message) {
    if (message.type === "store-load") {
      return { deviceId: PHONE_ID, deviceName: "Проверочный телефон", session: this.saved };
    }
    if (message.type === "store-save") {
      if (this.failSave) {
        return {};
      }
      this.saved = message.session;
      return { ok: true };
    }
    if (message.type === "store-clear") {
      this.saved = null;
      return { ok: true };
    }
    return {};
  }
  send(message) {
    this.handlers.forEach(fn => fn(message));
  }
  get last() {
    return this.states[this.states.length - 1];
  }
}

const memory = () => {
  let on = true;
  return { get: () => on, set: v => (on = v) };
};
const phone = app => new Service({ bridge: app, store: new NativeStore(app), api: new Api(API), settings: memory() });

/* ---- аккаунт и «компьютер» ---- */

const computer = new Account({ api: new Api(API), store: new MemoryStore("web-computer0000000000") });
await computer.register(name, PASSWORD);
const desk = new SyncClient(computer);
await desk.refresh();
const DESK_ID = computer.store.deviceId();
const deskTabs = [{ t: "Статья", u: "https://example.org/article" }, { t: "Закреплённая", u: "https://example.org/pinned", p: 1 }];
await desk.put("tabs", DESK_ID, { name: "Рабочий Mac", at: Date.now(), tabs: deskTabs });

/* ---- запуск без входа ---- */

const app = new FakeApp();
let svc = phone(app);
await svc.ready;
check("без сохранённого входа модуль запускается вышедшим и сообщает это приложению", [svc.state().signedIn, app.last?.type, app.last?.signedIn, app.last?.devices], [false, "state", false, []]);

/* ---- вход ---- */

await svc.account.signIn(name, PASSWORD);
check("вход: ключ данных открыт, вход отдан на хранение приложению", [svc.account.signedIn, svc.account.keys.state, typeof app.saved, JSON.parse(app.saved).email], [true, "ok", "string", `${name}@tabora.app`]);
check("в хранилище страницы вход не пишется: запись лежит только у приложения", typeof globalThis.localStorage, "undefined");
const devices = await svc.api.devices(svc.account.token);
check("сервер знает телефон под именем, которое дал владелец", (devices.devices || devices).some(d => d.id === PHONE_ID && d.name === "Проверочный телефон"), true);

/* ---- вкладки телефона уходят, вкладки компьютера приходят ---- */

app.send({ type: "tabs", tabs: [
  { t: "Новости", u: "https://news.example/today" },
  { t: "Служебная", u: "about:config" },
  { t: "Файл", u: "file:///sdcard/a.html" },
  { t: "x".repeat(400), u: "http://plain.example/" },
  { t: "Длинный адрес", u: `https://long.example/${"a".repeat(2100)}` },
  null,
] });
await svc.run();
await desk.refresh();
const mine = desk.get("tabs", PHONE_ID);
check("запись телефона на сервере: имя, только адреса http и https, длины ограничены", [mine?.name, mine?.tabs.map(x => x.u), mine?.tabs[1].t.length], ["Проверочный телефон", ["https://news.example/today", "http://plain.example/"], 200]);
check("телефон видит вкладки компьютера", svc.state().devices.map(d => [d.id, d.name, d.tabs.map(x => x.u)]), [[DESK_ID, "Рабочий Mac", ["https://example.org/article", "https://example.org/pinned"]]]);
check("приложению уходит то же: устройство и его вкладки", [app.last.signedIn, app.last.email, app.last.tabsOn, app.last.status, app.last.devices.map(d => [d.name, d.tabs.length])], [true, `${name}@tabora.app`, true, "ok", [["Рабочий Mac", 2]]]);
check("своей записи среди чужих нет", svc.state().devices.some(d => d.id === PHONE_ID), false);

const before = desk.rev;
await svc.run();
await desk.refresh();
check("список не менялся — на сервер ничего не пишется", desk.rev, before);

app.send({ type: "tabs", tabs: [{ t: "Новости", u: "https://news.example/today" }] });
await svc.run();
await desk.refresh();
check("закрыли вкладку на телефоне — запись обновилась", desk.get("tabs", PHONE_ID).tabs.map(x => x.u), ["https://news.example/today"]);

await desk.put("tabs", DESK_ID, { name: "Рабочий Mac", at: Date.now(), tabs: [deskTabs[0]] });
app.send({ type: "sync" });
await new Promise(r => setTimeout(r, 50));
await svc.run();
check("по просьбе приложения сверка идёт сразу: видна перемена на компьютере", svc.state().devices[0].tabs.map(x => x.u), ["https://example.org/article"]);

/* ---- давние и пустые списки ---- */

await desk.put("tabs", "old-device-0000000001", { name: "Старый", at: Date.now() - 30 * 24 * 3600 * 1000, tabs: deskTabs });
await desk.put("tabs", "empty-device-00000001", { name: "Пустой", at: Date.now(), tabs: [] });
await desk.put("tabs", "noname-device-0000001", { name: "", at: Date.now() + 1000, tabs: [{ t: "", u: "https://noname.example/" }, { t: "плохой", u: "javascript:alert(1)" }] });
await svc.run();
check("давние и пустые списки не показываются, опасные адреса отброшены, свежие — первыми", svc.state().devices.map(d => [d.name, d.tabs.map(x => x.u)]), [["", ["https://noname.example/"]], ["Рабочий Mac", ["https://example.org/article"]]]);
check("устройству без имени приложение получает понятное название", app.last.devices[0].name, "Другое устройство");

/* ---- выключение синхронизации вкладок ---- */

await svc.setTabs(false);
await desk.refresh();
check("выключили: записи телефона на сервере нет, чужие вкладки не показываются", [desk.get("tabs", PHONE_ID), svc.state().tabsOn, svc.state().devices, app.last.tabsOn, app.last.devices], [null, false, [], false, []]);
app.send({ type: "tabs", tabs: [{ t: "Тайная", u: "https://private.example/" }] });
await svc.run();
await desk.refresh();
check("пока выключено, список вкладок на сервер не уходит", desk.get("tabs", PHONE_ID), null);
await svc.setTabs(true);
await svc.run();
await desk.refresh();
check("включили снова — запись вернулась", desk.get("tabs", PHONE_ID)?.tabs.map(x => x.u), ["https://private.example/"]);

/* ---- перезапуск приложения ---- */

svc.stop();
svc = phone(app);
await svc.ready;
check("после перезапуска вход на месте без пароля, ключ данных открыт", [svc.account.signedIn, svc.account.email, !!svc.account.keys.dataKey], [true, `${name}@tabora.app`, true]);
app.send({ type: "tabs", tabs: [{ t: "После перезапуска", u: "https://restart.example/" }] });
await svc.run();
await desk.refresh();
check("сверка после перезапуска работает", [svc.state().status, desk.get("tabs", PHONE_ID).tabs[0].u], ["ok", "https://restart.example/"]);

/* ---- сбой хранилища не стирает вход ---- */

app.failSave = true;
await svc.account._persist();
app.failSave = false;
check("приложение не сохранило запись — вход остаётся", [svc.account.signedIn, typeof app.saved], [true, "string"]);

/* ---- выход ---- */

const token = svc.account.token;
await svc.signOut();
await desk.refresh();
check("выход: запись телефона убрана, вход стёрт у приложения, сессия на сервере завершена", [desk.get("tabs", PHONE_ID), app.saved, svc.state().signedIn, app.last.signedIn, app.last.devices, await rejects(() => svc.api.devices(token))], [null, null, false, false, [], "session-expired"]);

/* ---- сессию завершили с другого устройства ---- */

await svc.account.signIn(name, PASSWORD);
app.send({ type: "tabs", tabs: [{ t: "Снова", u: "https://again.example/" }] });
await svc.run();
const hash = await computer.loginHashFor(PASSWORD);
await computer.api.deviceRevoke(computer.token, PHONE_ID, hash);
await svc.run();
check("сеанс телефона завершили с компьютера: телефон вышел, вход стёрт", [svc.account.signedIn, app.saved, app.last.signedIn], [false, null, false]);
svc.stop();

/* ---- правила списка отдельно ---- */

const fakeSync = { _items: [], list: () => fakeSync._items, get: () => null, loaded: true };
const ts = new TabSync({ account: { signedIn: true }, sync: fakeSync, store: { deviceId: () => "me", deviceName: () => "Я" }, settings: memory() });
check("одинаковый список не считается переменой", [ts.setLocal([{ t: "a", u: "https://a.example/" }]), ts.setLocal([{ t: "a", u: "https://a.example/" }]), ts.setLocal([])], [true, false, true]);
const many = Array.from({ length: 260 }, (_, i) => ({ t: `t${i}`, u: `https://m.example/${i}` }));
ts.setLocal(many);
check("в запись попадает не больше 200 вкладок", ts.record().tabs.length, 200);

await computer.signOut();
summary();
