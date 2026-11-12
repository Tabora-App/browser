// "Send to device" in the phone app (web/src/phone/sent.js) against the local server: a page sent
// from the "computer" opens on the phone once, pages lying there before the sign-in are not
// opened, a page waits while the app cannot open it, the phone's own pages reach the computer in
// the form the desktop browser reads, and everything stops with tab sync. The app is replaced by
// a stand-in of the channel; the computer is a client of the web core writing the same records
// as the desktop browser (sync/SyncSources.sys.mjs, collections "tabs" and "sent").
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs sent
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";
import { Service } from "../../../web/src/phone/service.js";
import { NativeStore } from "../../../web/src/phone/store.js";
import { check, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `st${Date.now().toString(36)}`;
const PASSWORD = "Sent-Check-pass-17!";
const PHONE_ID = `and-${Date.now().toString(36)}tttttttttt`.slice(0, 22);
const DESK_ID = "web-computer0000000000";

/** The app: keeps the sign-in and the module's data, opens sent pages. */
class FakeApp {
  constructor() {
    this.saved = null;
    this.data = {};
    this.opened = []; // [url, title, from]
    this.canOpen = true;
    this.results = [];
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
    } else if (message.type === "sent-result") {
      this.results.push(message);
    }
  }
  async call(message) {
    if (message.type === "sent-open") {
      if (!this.canOpen) {
        return {};
      }
      this.opened.push([message.url, message.title, message.from]);
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
const phone = app => new Service({ bridge: app, store: new NativeStore(app), api: new Api(API), settings: { history: memory(false), tabs: memory(), codes: memory(false), logins: memory(false), marks: memory(false), spaces: memory(false) } });
const until = async (test, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (test()) {
      return true;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
};

/* ---- the "computer": its list of tabs and a page sent before the phone signed in ---- */

const computer = new Account({ api: new Api(API), store: new MemoryStore(DESK_ID) });
await computer.register(name, PASSWORD);
const desk = new SyncClient(computer);
const item = (id, to, u, at = Date.now(), t = "Заголовок") => ({ id, to, u, t, at });
const deskSend = async list => {
  await desk.refresh();
  await desk.put("sent", DESK_ID, { name: "Рабочий Mac", items: list });
};
await desk.refresh();
await desk.put("tabs", DESK_ID, { name: "Рабочий Mac", at: Date.now(), tabs: [] });
await deskSend([item("old1", PHONE_ID, "https://old.example/before")]);

/* ---- sign-in ---- */

const app = new FakeApp();
let svc = phone(app);
await svc.ready;
await svc.account.signIn(name, PASSWORD);
await svc.run();
check("после входа: компьютер есть среди устройств для отправки, отправленное до входа не открывается", [svc.state().targets, app.last.targets, app.opened], [[{ id: DESK_ID, name: "Рабочий Mac" }], [{ id: DESK_ID, name: "Рабочий Mac" }], []]);
check("устройство с пустым списком вкладок предлагается для отправки, хотя среди «вкладок других устройств» его нет", svc.state().devices.length, 0);

/* ---- a page from the computer ---- */

await deskSend([
  item("old1", PHONE_ID, "https://old.example/before"),
  item("n1", PHONE_ID, "https://new.example/page?x=1", Date.now(), "Новая страница"),
  item("n2", "someone-else", "https://other.example/"),
  item("n3", PHONE_ID, "javascript:alert(1)"),
  item("n4", PHONE_ID, "https://stale.example/", Date.now() - 8 * 24 * 3600 * 1000),
  item("bad id!", PHONE_ID, "https://badid.example/"),
]);
await svc.run();
check("присланная страница открывается приложением: адрес, заголовок, имя устройства; чужие, устаревшие и не сайты — нет", app.opened, [["https://new.example/page?x=1", "Новая страница", "Рабочий Mac"]]);
await svc.run();
check("второй раз та же страница не открывается", app.opened.length, 1);

/* ---- restart ---- */

svc.stop();
app.handlers = []; // the stopped module no longer listens to the app
svc = phone(app);
await svc.ready;
await svc.run();
check("после перезапуска приложения открытая страница не открывается снова", [svc.account.signedIn, app.opened.length], [true, 1]);

/* ---- the app cannot open pages now ---- */

app.canOpen = false;
await deskSend([item("w1", PHONE_ID, "https://wait.example/1"), item("w2", PHONE_ID, "https://wait.example/2", Date.now() + 1)]);
await svc.run();
check("пока приложение не может открыть страницу, она ждёт", app.opened.length, 1);
app.canOpen = true;
await svc.run();
check("потом страницы открываются по порядку отправки, каждая один раз", app.opened.slice(1).map(x => x[0]), ["https://wait.example/1", "https://wait.example/2"]);
await svc.run();
check("и больше не открываются", app.opened.length, 3);

/* ---- sending from the phone ---- */

app.say({ type: "send-tab", rid: 7, to: [DESK_ID], pages: [{ url: "https://phone.example/article", title: "Статья с телефона" }, { url: "about:blank", title: "не сайт" }] });
await until(() => app.results.length === 1);
await desk.refresh();
const mine = desk.get("sent", PHONE_ID);
check("отправка с телефона: ответ приложению и запись на сервере в том виде, который читает компьютер", [app.results[0], mine?.name, mine?.items.map(i => [i.to, i.u, i.t, /^s[a-z0-9]+$/.test(i.id), Math.abs(Date.now() - i.at) < 60000])], [
  { type: "sent-result", rid: 7, ok: true, count: 1 },
  "Проверочный телефон",
  [[DESK_ID, "https://phone.example/article", "Статья с телефона", true, true]],
]);
app.say({ type: "send-tab", rid: 8, to: [DESK_ID], pages: [{ url: "https://phone.example/second", title: "" }] });
await until(() => app.results.length === 2);
await desk.refresh();
check("вторая отправка дописывается к первой", desk.get("sent", PHONE_ID)?.items.map(i => i.u), ["https://phone.example/article", "https://phone.example/second"]);
app.say({ type: "send-tab", rid: 9, to: [PHONE_ID], pages: [{ url: "https://phone.example/self" }] });
app.say({ type: "send-tab", rid: 10, to: [DESK_ID], pages: [{ url: "file:///etc/hosts" }] });
await until(() => app.results.length === 4);
check("себе и не сайт отправить нельзя", app.results.slice(2).map(r => [r.rid, r.ok, r.count]), [[9, false, 0], [10, false, 0]]);
// two requests at once (two taps): both pages get there, answers come in the order of the requests
app.say({ type: "send-tab", rid: 21, to: [DESK_ID], pages: [{ url: "https://phone.example/twice-1" }] });
app.say({ type: "send-tab", rid: 22, to: [DESK_ID], pages: [{ url: "https://phone.example/twice-2" }] });
await until(() => app.results.length === 6);
await desk.refresh();
check("две отправки подряд не мешают друг другу", [app.results.slice(4).map(r => [r.rid, r.ok]), desk.get("sent", PHONE_ID)?.items.map(i => i.u.split("/").pop())], [[[21, true], [22, true]], ["article", "second", "twice-1", "twice-2"]]);
app.results.splice(4);
check("свои отправленные страницы телефон сам не открывает", app.opened.length, 3);

/* ---- no connection ---- */

const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new TypeError("fetch failed");
};
app.say({ type: "send-tab", rid: 11, to: [DESK_ID], pages: [{ url: "https://phone.example/offline" }] });
await until(() => app.results.length === 5);
globalThis.fetch = realFetch;
await svc.run();
await desk.refresh();
check("без связи отправка честно не удаётся и позже сама не уходит", [app.results[4].ok, desk.get("sent", PHONE_ID)?.items.some(i => i.u.endsWith("/offline"))], [false, false]);

/* ---- tab sync turned off ---- */

await svc.setTabs(false);
await desk.refresh();
check("вкладки выключили: исходящих телефона на сервере нет, отправлять некуда", [desk.get("sent", PHONE_ID), svc.state().targets, app.last.targets], [null, [], []]);
await deskSend([item("off1", PHONE_ID, "https://off.example/")]);
await svc.run();
app.say({ type: "send-tab", rid: 12, to: [DESK_ID], pages: [{ url: "https://phone.example/off" }] });
await until(() => app.results.length === 6);
check("пока выключено, ничего не открывается и не отправляется", [app.opened.length, app.results[5].ok], [3, false]);
await svc.setTabs(true);
await svc.run();
check("включили снова: присланное за это время открывается", app.opened.slice(3).map(x => x[0]), ["https://off.example/"]);

/* ---- sign-out and a new sign-in ---- */

await svc.signOut();
check("выход: список открытых страниц у приложения стёрт", app.data.sent, undefined);
await deskSend([item("late1", PHONE_ID, "https://late.example/")]);
await svc.account.signIn(name, PASSWORD);
await svc.run();
check("новый вход: лежавшее до него не открывается", app.opened.length, 4);
await deskSend([item("late1", PHONE_ID, "https://late.example/"), item("late2", PHONE_ID, "https://late.example/2")]);
await svc.run();
check("а присланное после входа — открывается", app.opened.slice(4).map(x => x[0]), ["https://late.example/2"]);

svc.stop();
await computer.signOut();
summary();
