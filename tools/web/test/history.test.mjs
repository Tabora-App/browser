// History of visits in the phone app (web/src/phone/history.js) against the local server: the
// phone publishes its own visits by day in the form the desktop browser reads, changes and
// deletions reach the server, the history of the "computer" is shown and searched and never
// written back, turning history off removes the phone's records. The app is replaced by a
// stand-in that answers "history-list" from a list of visits; the computer is a client of the
// web core writing the same records as the desktop browser (sync/SyncSources.sys.mjs).
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs history
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";
import { byDay } from "../../../web/src/phone/history.js";
import { Service } from "../../../web/src/phone/service.js";
import { NativeStore } from "../../../web/src/phone/store.js";
import { check, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `hi${Date.now().toString(36)}`;
const PASSWORD = "History-Check-pass-17!";
const PHONE_ID = `and-${Date.now().toString(36)}hhhhhhhhhh`.slice(0, 22);
const DESK_ID = "web-computer0000000000";
const DAY = 86400000;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");

/** The app: keeps the sign-in and the module's data, answers about the phone's history. */
class FakeApp {
  constructor() {
    this.saved = null;
    this.data = {};
    this.visits = []; // { u, t, at }: the phone's history storage
    this.asked = []; // since of every "history-list"
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
    if (message.type === "history-list") {
      this.asked.push(message.since);
      if (this.broken) {
        return {};
      }
      return { visits: this.visits.filter(v => v.at >= message.since).map(v => ({ ...v })) };
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
const phone = app => new Service({ bridge: app, store: new NativeStore(app), api: new Api(API), settings: { tabs: memory(false), codes: memory(false), logins: memory(false), marks: memory(false), spaces: memory(false), history: memory() } });

/* ---- grouping of visits ---- */

const now = Date.now();
const grouped = byDay([
  { u: "https://a.example/x", t: "Первое название", at: now - 5000 },
  { u: "https://a.example/x", t: "Новое название", at: now - 1000 },
  { u: "https://b.example/", t: "", at: now - 3000 },
  { u: "javascript:alert(1)", t: "плохая", at: now },
  { u: "https://user:pw@c.example/", t: "с паролем", at: now },
  { u: "https://d.example/", t: "без времени" },
  { u: `https://e.example/${"x".repeat(2100)}`, t: "длинная", at: now },
]);
check("посещения складываются в страницы дня: последнее время и название, число посещений; не сайты, адреса с паролем и слишком длинные отброшены",
  [...grouped].map(([day, pages]) => [day === dayOf(now), pages]), [[true, [{ u: "https://a.example/x", t: "Новое название", at: now - 1000, n: 2 }, { u: "https://b.example/", t: "", at: now - 3000 }]]]);
const many = byDay(Array.from({ length: 400 }, (_, i) => ({ u: `https://big.example/page/${i}/${"x".repeat(180)}`, t: `Страница ${i} ${"я".repeat(60)}`, at: now - 4 * DAY + i * 1000 })));
const big = [...many.values()][0];
check("день с сотнями страниц укладывается в запись: остаются самые поздние", [big.length > 0 && big.length <= 250, JSON.stringify(big).length <= 48 * 1024, big[0].u.includes("/page/399/")], [true, true, true]);

/* ---- the "computer" and its history ---- */

const computer = new Account({ api: new Api(API), store: new MemoryStore(DESK_ID) });
await computer.register(name, PASSWORD);
const desk = new SyncClient(computer);
await desk.refresh();
await desk.write([
  { c: "history", id: `${DESK_ID}-${dayOf(now)}`, data: { name: "Рабочий Mac", day: dayOf(now), p: [
    { u: "https://desk.example/recipe", t: "Рецепт борща", at: now - 60000 },
    { u: "https://shared.example/", t: "Общая страница", at: now - 30000, n: 3 },
    { u: "javascript:alert(1)", t: "плохая", at: now } ] } },
  { c: "history", id: `${DESK_ID}-${dayOf(now - 2 * DAY)}`, data: { name: "Рабочий Mac", day: dayOf(now - 2 * DAY), p: [{ u: "https://desk.example/news", t: "Новости", at: now - 2 * DAY }] } },
  { c: "history", id: `${DESK_ID}-${dayOf(now - 80 * DAY)}`, data: { name: "Рабочий Mac", day: dayOf(now - 80 * DAY), p: [{ u: "https://desk.example/ancient", t: "Давнее", at: now - 80 * DAY }] } },
]);

/* ---- sign-in: the phone publishes its history ---- */

const app = new FakeApp();
app.visits = [
  { u: "https://phone.example/today", t: "Сегодня на телефоне", at: now - 20000 },
  { u: "https://phone.example/today", t: "Сегодня на телефоне", at: now - 10000 },
  { u: "https://shared.example/", t: "Общая страница", at: now - 40000 },
  { u: "https://phone.example/week", t: "Три дня назад", at: now - 3 * DAY },
  { u: "https://phone.example/old", t: "Давно", at: now - 70 * DAY },
];
let svc = phone(app);
await svc.ready;
await svc.account.signIn(name, PASSWORD);
await svc.run();
await desk.refresh();
const mine = () => desk.list("history").filter(r => r.id.startsWith(`${PHONE_ID}-`)).sort((a, b) => b.id.localeCompare(a.id));
check("телефон публикует свои посещения по дням в том виде, который читает компьютер; старше двух месяцев не уходит",
  mine().map(r => [r.id === `${PHONE_ID}-${r.data.day}`, r.data.name, r.data.p.map(p => [p.u.replace("https://", ""), p.t, p.n || 1])]),
  [[true, "Проверочный телефон", [["phone.example/today", "Сегодня на телефоне", 2], ["shared.example/", "Общая страница", 1]]], [true, "Проверочный телефон", [["phone.example/week", "Три дня назад", 1]]]]);
check("история компьютера видна на телефоне: свежие первыми, с именем устройства; старое и не сайты отброшены", svc.history.others().map(x => [x.url.replace("https://", ""), x.title, x.device]),
  [["shared.example/", "Общая страница", "Рабочий Mac"], ["desk.example/recipe", "Рецепт борща", "Рабочий Mac"], ["desk.example/news", "Новости", "Рабочий Mac"]]);
check("поиск по словам из названия и адреса; отбор по времени", [svc.history.others({ query: "рецепт БОРЩ" }).map(x => x.title), svc.history.others({ query: "desk.example news" }).map(x => x.title), svc.history.others({ since: now - DAY }).length], [["Рецепт борща"], ["Новости"], 2]);
check("история компьютера в записи телефона не попадает", mine().some(r => r.data.p.some(p => p.u.includes("desk.example"))), false);
check("приложению сообщается, что история включена", [svc.state().historyOn, app.last.historyOn, svc.state().historyError], [true, true, ""]);
const rev = desk.rev;
await svc.run();
await desk.refresh();
check("повторная сверка без перемен на сервер ничего не пишет", desk.rev, rev);

/* ---- changes on the phone ---- */

app.visits.push({ u: "https://phone.example/new", t: "Новая страница", at: now - 500 });
app.asked.length = 0;
await svc.run({ full: false });
await desk.refresh();
check("попутная сверка читает только вчера и сегодня и дописывает новую страницу", [app.asked.length, app.asked[0] >= now - 2 * DAY, mine()[0].data.p[0].u], [1, true, "https://phone.example/new"]);
app.visits = app.visits.filter(v => !v.u.includes("/week"));
await svc.run({ full: false });
await desk.refresh();
check("удаление давней страницы попутная сверка не видит…", mine().length, 2);
await svc.run();
await desk.refresh();
check("…а полная убирает опустевший день с сервера", mine().map(r => r.data.day), [dayOf(now)]);
app.visits = app.visits.filter(v => !v.u.includes("/today"));
await svc.run();
await desk.refresh();
check("страница, удалённая из истории телефона, пропадает из его записи", mine()[0].data.p.map(p => p.u.replace("https://phone.example", "")), ["/new", "https://shared.example/"]);

/* ---- the app does not answer ---- */

app.broken = true;
app.visits.push({ u: "https://phone.example/lost", t: "Не уйдёт", at: Date.now() });
await svc.run();
check("приложение не ответило об истории: остальное сверено, ошибка видна, записи не тронуты", [svc.state().status, !!svc.state().historyError, mine().length], ["ok", true, 1]);
app.broken = false;
await svc.run();
await desk.refresh();
check("ответило — запись дополнена, ошибки нет", [svc.state().historyError, mine()[0].data.p.some(p => p.u.endsWith("/lost"))], ["", true]);

/* ---- restart ---- */

await svc.saveNow(); // the copy of the data is written a moment after a change; here right away
svc.stop();
app.handlers = [];
svc = phone(app);
await svc.ready;
check("после перезапуска история других устройств видна сразу, без сети", svc.history.others().length, 3);

/* ---- turning history off and on ---- */

await svc.setHistory(false);
await desk.refresh();
check("выключили: записей телефона на сервере нет, чужая история на телефоне не показывается, на сервере осталась", [mine().length, svc.history.others().length, desk.list("history").filter(r => r.id.startsWith(DESK_ID)).length, app.last.historyOn], [0, 0, 3, false]);
app.asked.length = 0;
await svc.run();
check("пока выключено, приложение об истории не спрашивают", app.asked.length, 0);
await svc.setHistory(true);
await svc.run();
await desk.refresh();
check("включили снова: записи телефона вернулись, история компьютера видна", [mine().length, svc.history.others().length], [1, 3]);

/* ---- sign-out ---- */

await svc.signOut();
await desk.refresh();
check("выход: история телефона убрана с сервера", mine().length, 0);

svc.stop();
await computer.signOut();
summary();
