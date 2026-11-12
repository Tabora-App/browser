// Закладки в приложении для телефона (web/src/phone/marks.js) на местном сервере: закладки
// «компьютера» ложатся в хранилище закладок телефона, сделанные на телефоне уходят в аккаунт;
// правка, перенос, порядок, удаление в обе стороны; близнецы; повторный вход; много пропавших
// разом; негодные записи. Хранилище телефона заменено имитацией, которая, как настоящее, сама
// даёт номера новым закладкам; «компьютер» — клиент веб-ядра, пишущий записи в том же виде, что
// браузер (sync/SyncSources.sys.mjs, marks).
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs marks
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";
import { markValid } from "../../../web/src/phone/marks.js";
import { Service } from "../../../web/src/phone/service.js";
import { NativeStore } from "../../../web/src/phone/store.js";
import { check, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `mk${Date.now().toString(36)}`;
const PASSWORD = "Marks-Check-pass-17!";
const PHONE_ID = `and-${Date.now().toString(36)}mmmmmmmmmm`.slice(0, 22);
const MENU = "menu________", BAR = "toolbar_____", OTHER = "unfiled_____", MOBILE = "mobile______";
const ROOTS = [MENU, BAR, OTHER, MOBILE];

/** Приложение: вход, данные и хранилище закладок с четырьмя корнями. */
class FakeApp {
  constructor() {
    this.saved = null;
    this.data = {};
    this.seq = 0;
    this.calls = [];
    this.nodes = new Map(); // номер → { g, p, k, n, u, c, t, ch }
    for (const g of ROOTS) {
      this.nodes.set(g, { g, p: null, k: 2, n: "", c: 1, t: 1, ch: [] });
    }
  }
  /* ---- то, что делает человек на телефоне ---- */
  add(parent, kind, title = "", url = "") {
    const g = `ph${String(++this.seq).padStart(4, "0")}______`.slice(0, 12);
    this.nodes.set(g, { g, p: parent, k: kind, n: title, ...(kind === 1 ? { u: url } : {}), c: Date.now(), t: Date.now(), ...(kind === 2 ? { ch: [] } : {}) });
    this.nodes.get(parent).ch.push(g);
    return g;
  }
  remove(g) {
    const n = this.nodes.get(g);
    if (!n) {
      return false;
    }
    (n.ch || []).slice().forEach(c => this.remove(c)); // папка удаляется со всем содержимым
    const siblings = this.nodes.get(n.p).ch;
    siblings.splice(siblings.indexOf(g), 1);
    this.nodes.delete(g);
    return true;
  }
  find(title) {
    return [...this.nodes.values()].find(n => n.n === title) || null;
  }
  titles(parent) {
    return this.nodes.get(parent).ch.map(g => this.nodes.get(g).n || (this.nodes.get(g).k === 3 ? "—" : ""));
  }
  /* ---- связь с модулем ---- */
  connect() {}
  onMessage() {}
  post() {}
  async call(message) {
    this.calls.push(message.type);
    if (message.type === "marks-tree") {
      const out = [];
      const walk = g => {
        const n = this.nodes.get(g);
        out.push(JSON.parse(JSON.stringify(n)));
        (n.ch || []).forEach(walk);
      };
      ROOTS.forEach(walk);
      return { nodes: out };
    }
    if (message.type === "marks-add") {
      if (!this.nodes.get(message.parent)?.ch || (message.kind === 1 && !/^[a-z][a-z0-9+.-]*:/i.test(message.url))) {
        return { error: "invalid" };
      }
      return { ok: true, guid: this.add(message.parent, message.kind, message.title, message.url) };
    }
    if (message.type === "marks-update") {
      const n = this.nodes.get(message.guid);
      if (!n || n.p === null) {
        return { error: "no such bookmark" };
      }
      if (typeof message.title === "string") {
        n.n = message.title;
      }
      if (typeof message.url === "string") {
        n.u = message.url;
      }
      if (typeof message.parent === "string") {
        const to = this.nodes.get(message.parent);
        if (!to?.ch) {
          return { error: "no such folder" };
        }
        const from = this.nodes.get(n.p).ch;
        from.splice(from.indexOf(n.g), 1);
        to.ch.push(n.g);
        n.p = message.parent;
      }
      n.t = Date.now();
      return { ok: true };
    }
    if (message.type === "marks-order") {
      // как приложение: каждая запись по очереди ставится на своё место среди соседей
      message.order.forEach((g, i) => {
        const n = this.nodes.get(g);
        const ch = n && this.nodes.get(n.p).ch;
        if (ch) {
          ch.splice(ch.indexOf(g), 1);
          ch.splice(i, 0, g);
        }
      });
      return { ok: true };
    }
    if (message.type === "marks-delete") {
      this.remove(message.guid);
      return { ok: true };
    }
    if (message.type === "logins-list") {
      return { logins: [] };
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
const phone = app => new Service({ bridge: app, store: new NativeStore(app), api: new Api(API), settings: { tabs: memory(false), codes: memory(false), logins: memory(false), marks: memory() } });

/* ---- «компьютер»: дерево закладок записями набора marks ---- */

const computer = new Account({ api: new Api(API), store: new MemoryStore("web-computer0000000000") });
await computer.register(name, PASSWORD);
const desk = new SyncClient(computer);
await desk.refresh();
const now = Date.now();
const mark = (p, title, url) => ({ p, k: 1, n: title, u: url, c: now, t: now });
const folder = (p, title, ch) => ({ p, k: 2, n: title, c: now, t: now, ch });
const put = async records => {
  await desk.refresh();
  await desk.write(Object.entries(records).map(([id, data]) => ({ c: "marks", id, data })));
};
const root = ch => ({ k: 2, root: true, ch });
await put({
  [BAR]: root(["dkA_________"]), [MENU]: root(["dkF_________"]), [OTHER]: root([]), [MOBILE]: root([]),
  dkA_________: mark(BAR, "Почта", "https://mail.example/"),
  dkF_________: folder(MENU, "Работа", ["dkC_________", "dkS_________", "dkB_________"]),
  dkB_________: mark("dkF_________", "Задачи", "https://tasks.example/"),
  dkC_________: mark("dkF_________", "Календарь", "https://cal.example/"),
  dkS_________: { p: "dkF_________", k: 3, n: "", c: now, t: now },
});

/* ---- первый вход: всё сливается ---- */

const app = new FakeApp();
const mine = app.add(MOBILE, 1, "Рецепты", "https://food.example/");
let svc = phone(app);
await svc.ready;
await svc.account.signIn(name, PASSWORD);
await svc.run();
const F = app.find("Работа");
check("закладки компьютера легли в хранилище телефона в те же корни", [app.titles(BAR), app.titles(MENU), app.find("Почта")?.u], [["Почта"], ["Работа"], "https://mail.example/"]);
check("папка пришла с содержимым в том же порядке, с разделителем", app.titles(F.g), ["Календарь", "—", "Задачи"]);
check("экрану аккаунта сообщается число закладок", [svc.state().marksOn, svc.state().marks, svc.state().marksError], [true, 4, ""]);
await desk.refresh();
check("закладка телефона ушла в аккаунт под корнем телефона", [desk.get("marks", mine)?.n, desk.get("marks", mine)?.p, desk.get("marks", MOBILE)?.ch], ["Рецепты", MOBILE, [mine]]);
check("записи компьютера на сервере не тронуты", [desk.get("marks", "dkF_________").ch, desk.list("marks").length], [["dkC_________", "dkS_________", "dkB_________"], 10]);
const calls = app.calls.length;
await svc.run();
await desk.refresh();
check("повторная сверка без перемен ничего не пишет ни в хранилище, ни на сервер", [app.calls.slice(calls).filter(c => c !== "marks-tree" && c !== "logins-list" && c !== "spaces-list"), desk.list("marks").length], [[], 10]);

/* ---- перемены на компьютере ---- */

await put({ dkA_________: { ...mark(BAR, "Почта Tabora", "https://mail.example/inbox"), t: Date.now() } });
await svc.run();
check("название и адрес, изменённые на компьютере, меняются на телефоне", [app.find("Почта Tabora")?.u, app.find("Почта")], ["https://mail.example/inbox", null]);

await put({ dkB_________: mark(BAR, "Задачи", "https://tasks.example/"), [BAR]: root(["dkB_________", "dkA_________"]), dkF_________: folder(MENU, "Работа", ["dkS_________", "dkC_________"]) });
await svc.run();
check("перенос в другую папку и новый порядок применяются", [app.titles(BAR), app.titles(F.g)], [["Задачи", "Почта Tabora"], ["—", "Календарь"]]);

await desk.refresh();
await desk.write([{ c: "marks", id: "dkC_________", data: null }]);
await put({ dkF_________: folder(MENU, "Работа", ["dkS_________"]) });
await svc.run();
check("удалённое на компьютере удаляется на телефоне", [app.find("Календарь"), app.titles(F.g)], [null, ["—"]]);

/* ---- перемены на телефоне ---- */

const fresh = app.add(F.g, 1, "Отчёты", "https://reports.example/");
app.nodes.get(app.find("Задачи").g).n = "Задачи команды";
app.nodes.get(app.find("Задачи команды").g).t = Date.now() + 1000;
app.remove(app.find("Почта Tabora").g);
await svc.run();
await desk.refresh();
check("новая закладка телефона в папке компьютера: запись и порядок папки на сервере", [desk.get("marks", fresh)?.p, desk.get("marks", "dkF_________").ch], ["dkF_________", ["dkS_________", fresh]]);
check("правка и удаление на телефоне доходят до сервера", [desk.get("marks", "dkB_________").n, desk.get("marks", "dkA_________") ?? null, desk.get("marks", BAR).ch], ["Задачи команды", null, ["dkB_________"]]);

/* ---- папку удалили на компьютере, а на телефоне в неё успели положить закладку ---- */

const late = app.add(F.g, 1, "Свежая", "https://late.example/");
await desk.refresh();
await desk.write([{ c: "marks", id: "dkF_________", data: null }, { c: "marks", id: "dkS_________", data: null }, { c: "marks", id: fresh, data: null }]);
await put({ [MENU]: root([]) });
await svc.run();
await desk.refresh();
check("папка, изменённая на телефоне после сверки, чужим удалением не стирается: остаётся с новой закладкой и возвращается на сервер", [app.titles(MENU), app.titles(F.g), app.find("Отчёты"), desk.get("marks", "dkF_________")?.ch, desk.get("marks", late)?.p, desk.get("marks", MENU).ch], [["Работа"], ["Свежая"], null, [late], "dkF_________", ["dkF_________"]]);

/* ---- с сервера пришло удаление папки, но не её содержимого ---- */

await put({ dkG_________: folder(OTHER, "Архив", ["dkH_________"]), dkH_________: mark("dkG_________", "Старое", "https://old.example/"), [OTHER]: root(["dkG_________"]) });
await svc.run();
check("папка с закладкой пришла", app.titles(app.find("Архив").g), ["Старое"]);
await desk.refresh();
await desk.write([{ c: "marks", id: "dkG_________", data: null }]);
await svc.run();
await desk.refresh();
check("удаление папки не уносит закладку, которую никто не удалял: она поднимается выше", [app.find("Архив"), app.find("Старое")?.p, desk.get("marks", "dkH_________")?.p], [null, OTHER, OTHER]);
await desk.write([{ c: "marks", id: "dkH_________", data: null }]);
await svc.run();

/* ---- близнецы: одна и та же закладка заведена и там и здесь до сверки ---- */

app.add(OTHER, 1, "Справочник", "https://docs.example/");
await put({ dkT_________: mark(OTHER, "Справочник", "https://docs.example/"), [OTHER]: root(["dkT_________"]) });
await svc.run();
await desk.refresh();
check("одинаковая закладка остаётся одна: здешняя под номером сервера", [app.titles(OTHER), desk.list("marks").filter(r => r.data.n === "Справочник").map(r => r.id)], [["Справочник"], ["dkT_________"]]);

/* ---- выход и повторный вход: закладки остаются, дублей нет ---- */

const before = [...app.nodes.keys()].sort();
await svc.signOut();
check("выход: закладки остаются на телефоне, сведения о слиянии стёрты", [[...app.nodes.keys()].sort(), app.data.marks], [before, undefined]);
await svc.account.signIn(name, PASSWORD);
await svc.run();
await desk.refresh();
const live = desk.list("marks").filter(r => !r.data.root).map(r => r.data.n).sort();
check("повторный вход: ни на телефоне, ни на сервере закладки не задвоились", [[...app.nodes.keys()].sort(), live], [before, ["Задачи команды", "Работа", "Рецепты", "Свежая", "Справочник"]]);

/* ---- попутная сверка (после перемены во вкладках) дерево зря не читает ---- */

let reads = app.calls.filter(c => c === "marks-tree").length;
await svc.run({ full: false });
check("попутная сверка без новостей с сервера хранилище закладок не читает", app.calls.filter(c => c === "marks-tree").length - reads, 0);
await put({ dkN_________: mark(BAR, "Новая", "https://new.example/"), [BAR]: root(["dkB_________", "dkN_________"]) });
await svc.run({ full: false });
check("а с новостями — читает и применяет", app.titles(BAR), ["Задачи команды", "Новая"]);

/* ---- негодные записи ---- */

await put({
  dkX1________: mark(BAR, "Скрипт", "не адрес"),
  dkX2________: { p: "dkX2________", k: 2, n: "Сама в себе", c: now, t: now, ch: [] },
  dkX3________: { p: BAR, k: 7, n: "Неизвестный вид", c: now, t: now },
  dkX4________: mark("нет такой папки!", "Без родителя", "https://x.example/"),
  dkX5________: mark("dkGone______", "Сирота", "https://orphan.example/"),
});
await svc.run();
check("негодные записи не применяются; запись с пропавшим родителем ложится в «Другие»", [app.find("Скрипт"), app.find("Сама в себе"), app.find("Неизвестный вид"), app.find("Без родителя"), app.find("Сирота")?.p], [null, null, null, null, OTHER]);
check("проверка записи: вид, родитель, адрес", [markValid("a", mark(BAR, "x", "https://a.example/")), markValid("a", mark("a", "x", "https://a.example/")), markValid("a", mark(BAR, "x", "")), markValid("a", { p: BAR, k: 2, n: "x" })], [true, false, false, false]);

/* ---- много закладок пропало разом ---- */

const many = {};
const ids = [];
for (let i = 0; i < 30; i++) {
  const id = `dkM${String(i).padStart(2, "0")}_______`;
  ids.push(id);
  many[id] = mark(OTHER, `Статья ${i}`, `https://read.example/${i}`);
}
await put({ ...many, [OTHER]: root(["dkT_________", ...ids]) });
await svc.run();
check("тридцать закладок пришли", app.nodes.get(OTHER).ch.length >= 31, true);
[...app.nodes.values()].filter(n => /^Статья /.test(n.n)).forEach(n => app.remove(n.g));
await svc.run();
await desk.refresh();
check("пропало разом много: удаления не отправлены, человеку показан выбор", [svc.state().marksHold?.missing, desk.get("marks", ids[0])?.n], [30, "Статья 0"]);
await svc.resolveMarksHold("restore");
await svc.run();
check("«вернуть на телефон»: закладки снова в хранилище", [[...app.nodes.values()].filter(n => /^Статья /.test(n.n)).length, svc.state().marksHold], [30, null]);
[...app.nodes.values()].filter(n => /^Статья /.test(n.n)).forEach(n => app.remove(n.g));
await svc.run();
await svc.resolveMarksHold("delete");
await svc.run();
await desk.refresh();
check("«удалить везде»: записи удалены и на сервере", [desk.list("marks").filter(r => /^Статья /.test(r.data.n || "")).length, svc.state().marksHold], [0, null]);

/* ---- выключатель ---- */

await svc.setMarks(false);
app.add(MOBILE, 1, "После выключения", "https://off.example/");
await svc.run();
await desk.refresh();
check("выключили закладки: телефон их больше не отправляет, сведения о слиянии стёрты", [desk.list("marks").some(r => r.data.n === "После выключения"), app.data.marks, svc.state().marksOn], [false, undefined, false]);

await svc.signOut();
svc.stop();
await computer.signOut();
summary();
