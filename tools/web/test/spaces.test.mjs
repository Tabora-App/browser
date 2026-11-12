// Список пространств в приложении для телефона (web/src/phone/spaces.js) на местном сервере:
// пространства «компьютера» появляются на телефоне в том же порядке, правка и удаление доходят,
// пространство с открытыми вкладками не удаляется и возвращается в аккаунт, одноимённое
// пространство, заведённое на телефоне до сверки, остаётся одно. Приложение заменено имитацией,
// которая хранит пространства так же, как TaboraSpaces.kt.
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs spaces
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";
import { Service } from "../../../web/src/phone/service.js";
import { spaceData } from "../../../web/src/phone/spaces.js";
import { NativeStore } from "../../../web/src/phone/store.js";
import { check, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `sp${Date.now().toString(36)}`;
const PASSWORD = "Space-Check-pass-17!";
const PHONE_ID = `and-${Date.now().toString(36)}ssssssssss`.slice(0, 22);

/** Приложение: вход, данные и пространства (кроме «Личного») с контекстами. */
class FakeApp {
  constructor() {
    this.saved = null;
    this.data = {};
    this.spaces = []; // { id, ctx, n, i, col }
    this.busy = new Set(); // контексты, в которых открыты вкладки
    this.seq = 0;
    this.applied = 0;
  }
  add(id, n, col = "blue") {
    this.spaces.push({ id, ctx: `ctx-${++this.seq}`, n, i: "circle", col });
    return this.spaces[this.spaces.length - 1];
  }
  names() {
    return this.spaces.map(s => s.n);
  }
  connect() {}
  onMessage() {}
  post() {}
  list() {
    return this.spaces.map((s, i) => ({ id: s.id, n: s.n, i: s.i, col: s.col, o: i + 1 }));
  }
  async call(message) {
    if (message.type === "spaces-list") {
      return { spaces: this.list() };
    }
    if (message.type === "spaces-apply") {
      this.applied++;
      const orders = new Map();
      for (const { id, data, from } of message.changes) {
        if (!data) {
          const at = this.spaces.findIndex(s => s.id === id);
          if (at >= 0 && !this.busy.has(this.spaces[at].ctx)) {
            this.spaces.splice(at, 1);
          }
          continue;
        }
        let at = this.spaces.findIndex(s => s.id === id);
        if (at < 0 && from) {
          at = this.spaces.findIndex(s => s.id === from);
        }
        const next = { id, ctx: at >= 0 ? this.spaces[at].ctx : `ctx-${++this.seq}`, n: data.n, i: data.i, col: data.col };
        if (at >= 0) {
          this.spaces[at] = next;
        } else {
          this.spaces.push(next);
        }
        if (Number.isFinite(data.o)) {
          orders.set(id, data.o);
        }
      }
      this.spaces = this.spaces.map((s, i) => [s, orders.has(s.id) ? orders.get(s.id) : i + 0.5]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
      return { ok: true, spaces: this.list() };
    }
    if (message.type === "marks-tree") {
      return { nodes: [] };
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
const phone = app => new Service({ bridge: app, store: new NativeStore(app), api: new Api(API), settings: { history: memory(false), addresses: memory(false), cards: memory(false), tabs: memory(false), codes: memory(false), logins: memory(false), marks: memory(false), spaces: memory() } });

/* ---- «компьютер»: два пространства в аккаунте ---- */

const computer = new Account({ api: new Api(API), store: new MemoryStore("web-computer0000000000") });
await computer.register(name, PASSWORD);
const desk = new SyncClient(computer);
const put = async records => {
  await desk.refresh();
  await desk.write(Object.entries(records).map(([id, data]) => ({ c: "spaces", id, data })));
};
await put({ "space-work": { n: "Работа", i: "briefcase", col: "orange", o: 1 }, "space-proj": { n: "Проекты", i: "tree", col: "green", o: 2 } });

/* ---- первый вход ---- */

const app = new FakeApp();
const own = app.add("space-phone1", "Проекты", "red"); // заведено на телефоне до входа, название то же
app.busy.add(own.ctx);
let svc = phone(app);
await svc.ready;
await svc.account.signIn(name, PASSWORD);
await svc.run();
check("пространства компьютера пришли на телефон в том же порядке", app.names(), ["Работа", "Проекты"]);
check("одноимённое пространство телефона осталось одно: с номером сервера и прежним контекстом", [app.spaces.find(s => s.n === "Проекты").id, app.spaces.find(s => s.n === "Проекты").ctx, app.spaces.find(s => s.n === "Проекты").col], ["space-proj", own.ctx, "green"]);
check("экрану аккаунта сообщается число пространств", [svc.state().spacesOn, svc.state().spaces, svc.state().spacesError], [true, 2, ""]);
await desk.refresh();
check("в аккаунте ничего лишнего не появилось", desk.list("spaces").map(r => r.id).sort(), ["space-proj", "space-work"]);
const applied = app.applied;
await svc.run();
check("повторная сверка без перемен пространства не трогает", app.applied - applied, 0);

/* ---- перемены на компьютере ---- */

await put({ "space-work": { n: "Работа и учёба", i: "briefcase", col: "purple", o: 2 }, "space-proj": { n: "Проекты", i: "tree", col: "green", o: 1 }, "space-home": { n: "Дом", i: "pet", col: "pink", o: 3 } });
await svc.run();
check("новое название, цвет, порядок и новое пространство применяются", [app.names(), app.spaces.find(s => s.id === "space-work").col], [["Проекты", "Работа и учёба", "Дом"], "purple"]);

await desk.refresh();
await desk.write([{ c: "spaces", id: "space-home", data: null }, { c: "spaces", id: "space-proj", data: null }]);
await svc.run();
await desk.refresh();
check("удалённое на компьютере пространство без вкладок удаляется; с открытыми вкладками остаётся и возвращается в аккаунт", [app.names(), desk.get("spaces", "space-proj")?.n, desk.get("spaces", "space-home") ?? null], [["Проекты", "Работа и учёба"], "Проекты", null]);

/* ---- негодные записи ---- */

await put({ "space-bad1": { n: "   ", i: "circle", col: "blue", o: 5 }, "space-odd": { n: "Чужие значения", i: "rocket", col: "ultraviolet", o: 9 } });
await svc.run();
check("запись без названия не применяется; неизвестные значок и цвет заменяются обычными", [app.names().includes("   "), app.spaces.find(s => s.id === "space-odd")?.i, app.spaces.find(s => s.id === "space-odd")?.col], [false, "circle", "blue"]);
check("проверка записи", [spaceData("personal", { n: "Личное" }), spaceData("a b", { n: "x" }), spaceData("ok", { n: " Имя ", i: "pet", col: "red", o: 2 })], [null, null, { n: "Имя", i: "pet", col: "red", o: 2 }]);

/* ---- выключатель и выход ---- */

await svc.setSpaces(false);
await put({ "space-late": { n: "После выключения", i: "circle", col: "blue", o: 7 } });
await svc.run();
check("выключили: новые пространства с компьютера не приходят, свои остаются", [app.names().includes("После выключения"), app.names().length >= 2, app.data.spaces], [false, true, undefined]);
await svc.setSpaces(true);
await svc.run();
check("включили снова: список сверяется заново без дублей", [app.names().includes("После выключения"), app.names().filter(n => n === "Проекты").length], [true, 1]);
const before = app.names();
await svc.signOut();
check("выход: пространства остаются на телефоне", app.names(), before);

svc.stop();
await computer.signOut();
summary();
