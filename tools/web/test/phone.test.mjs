// Модуль аккаунта для телефона (web/src/phone) на местном сервере: вход, сохранение входа у
// приложения, вкладки телефона на другом устройстве и наоборот, коды входа (общие с другим
// устройством, расчёт, привязка к сайтам, работа без сети), выключение, выход, отзыв сессии.
// Приложение заменено имитацией канала связи; второе устройство — клиент веб-ядра, который пишет
// запись вкладок в том же виде, что браузер на компьютере.
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs phone
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";
import { Service } from "../../../web/src/phone/service.js";
import { loginValid } from "../../../web/src/core/logins.js";
import { NativeStore } from "../../../web/src/phone/store.js";
import { TabSync } from "../../../web/src/phone/tabs.js";
import { check, rejects, summary, totp } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `ph${Date.now().toString(36)}`;
const PASSWORD = "Phone-Check-pass-17!";
const PHONE_ID = `and-${Date.now().toString(36)}xxxxxxxxxx`.slice(0, 22);

/** Приложение: хранит вход и принимает состояние. */
class FakeApp {
  constructor() {
    this.saved = null;
    this.data = {};
    this.asked = [];
    this.states = [];
    this.handlers = [];
    this.failSave = false;
    this.logins = new Map(); // хранилище паролей приложения: номер → запись
    this.seq = 0;
  }
  /** Сохранить пароль на телефоне, как это делает само приложение. */
  saveLogin(origin, username, password, { changed = Date.now(), httpRealm = null } = {}) {
    const guid = `g${++this.seq}phone`;
    this.logins.set(guid, { guid, origin, formActionOrigin: httpRealm === null ? origin : null, httpRealm, username, password, usernameField: "", passwordField: "", created: changed, changed });
    return guid;
  }
  login(origin, username) {
    return [...this.logins.values()].find(l => l.origin === origin && l.username === username) || null;
  }
  connect() {}
  onMessage(fn) {
    this.handlers.push(fn);
  }
  post(message) {
    if (message.type === "state") {
      this.states.push(JSON.parse(JSON.stringify(message)));
    } else {
      this.asked.push(JSON.parse(JSON.stringify(message)));
    }
  }
  async call(message) {
    if (this.silent) {
      return {}; // the app did not answer in time: this is what the channel gives then
    }
    if (message.type === "logins-list") {
      return { logins: [...this.logins.values()].map(l => ({ ...l })) };
    }
    if (message.type === "logins-add" || message.type === "logins-update") {
      const e = message.entry;
      // как хранилище приложения: второй пароль для того же сайта и имени не принимается
      const dupe = [...this.logins.values()].find(l => l.guid !== message.guid && l.origin === e.origin && l.username === e.username && (l.httpRealm === null) === (e.httpRealm === null));
      if (dupe || !e.password || !/^https?:\/\//.test(e.origin)) {
        return { error: dupe ? "duplicate" : "invalid" };
      }
      const guid = message.type === "logins-add" ? `g${++this.seq}synced` : message.guid;
      const old = this.logins.get(guid);
      if (message.type === "logins-update" && !old) {
        return { error: "no such login" };
      }
      const now = Date.now();
      this.logins.set(guid, { guid, origin: e.origin, formActionOrigin: e.formActionOrigin, httpRealm: e.httpRealm, username: e.username, password: e.password, usernameField: e.usernameField, passwordField: e.passwordField, created: old?.created || now, changed: old && old.password === e.password ? old.changed : now });
      return { ok: true, guid };
    }
    if (message.type === "logins-delete") {
      return { ok: this.logins.delete(message.guid) };
    }
    this.asked.push(JSON.parse(JSON.stringify(message)));
    return { ok: this.allow !== false };
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
  send(message) {
    this.handlers.forEach(fn => fn(message));
  }
  get last() {
    return this.states[this.states.length - 1];
  }
}

const memory = (on = true) => ({ get: () => on, set: v => (on = v) });
// пароли в начале выключены: первые проверки — про вкладки и коды
const switches = { tabs: memory(), codes: memory(), logins: memory(false), history: memory(false), addresses: memory(false), cards: memory(false) };
const phone = (app, api = API) => new Service({ bridge: app, store: new NativeStore(app), api: new Api(api), settings: switches });

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

/* ---- коды входа ---- */

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
await desk.put("otp", "o1desktop0001", { i: "GitHub", a: "anna", s: SECRET, al: "SHA1", d: 6, p: 30, w: [{ host: "github.com", sub: false }, { host: "example.net", sub: true }], c: new Date().toISOString() });
await desk.put("otp", "o2broken00001", { i: "Сломанная", a: "", s: "short", al: "SHA1", d: 6, p: 30, w: [], c: "" });
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deskLogin = (n, o, u, pw, { t = Date.now(), r = null } = {}) => desk.put("logins", uid(n), { g: `{${uid(n)}}`, o, f: r === null ? o : null, r, u, p: pw, uf: "", pf: "", c: t, t });
await deskLogin(1, "https://bank.example", "anna", "desktop-password-1");
await svc.run();
const want = await totp(SECRET);
const got = await svc.codes.code("o1desktop0001");
check("код, добавленный на компьютере, виден на телефоне и считается так же", [svc.codes.list().map(c => [c.id, c.issuer, c.account, c.sites.map(x => x.host)]), got.code, got.left > 0 && got.left <= 30], [[["o1desktop0001", "GitHub", "anna", ["github.com", "example.net"]]], want, true]);
check("запись с негодным секретом в список не попадает", svc.codes.list().some(c => c.id === "o2broken00001"), false);
check("код предлагается только на привязанном сайте: точный хост, поддомены — где разрешены", [svc.codes.forHost("github.com").map(c => c.match), svc.codes.forHost("gist.github.com"), svc.codes.forHost("login.example.net").map(c => c.match), svc.codes.forHost("github.com.evil.example"), svc.codes.forHost("evil-github.com")], [["exact"], [], ["sub"], [], []]);
check("пока синхронизация паролей выключена, телефон их не расшифровывает и в хранилище не кладёт", [svc.sync.list("logins"), JSON.stringify(svc.sync.snapshot()).includes("desktop-password-1"), app.logins.size], [[], false, 0]);
check("секретов в сообщениях приложению нет", app.states.some(m => JSON.stringify(m).includes(SECRET)), false);
check("приложению сообщается только число кодов", [app.last.codesOn, app.last.codes], [true, 1]);

const added = await svc.codes.add([{ issuer: "gitlab.com", account: "anna@example.org", secret: "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ" }]);
const again = await svc.codes.add([{ issuer: "gitlab.com", account: "anna@example.org", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }]);
await desk.refresh();
const mineOtp = desk.list("otp").find(o => o.data.i === "gitlab.com");
check("код, добавленный на телефоне, уходит на сервер в том же виде, что с компьютера; повтор не добавляется", [added, again, mineOtp?.data.s, mineOtp?.data.al, mineOtp?.data.d, mineOtp?.data.p, mineOtp?.data.w], [1, 0, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "SHA1", 6, 30, [{ host: "gitlab.com", sub: false }]]);
check("название сервиса, похожее на домен, сразу привязывает код к сайту", svc.codes.forHost("gitlab.com").map(c => c.account), ["anna@example.org"]);
check("неверный секрет и пустое название отклоняются", [await rejects(() => svc.codes.add([{ issuer: "X", account: "", secret: "не секрет" }])), await rejects(() => svc.codes.add([{ issuer: "", account: "", secret: SECRET }]))], ["bad-code", "bad-code"]);

await svc.codes.edit(mineOtp.id, { issuer: "GitLab", account: "anna@example.org", sites: "gitlab.com, https://About.GitLab.com/x" });
await desk.refresh();
check("правка названия и сайтов доходит до компьютера, секрет не меняется", [desk.get("otp", mineOtp.id).i, desk.get("otp", mineOtp.id).w.map(w => w.host), desk.get("otp", mineOtp.id).s], ["GitLab", ["gitlab.com", "about.gitlab.com"], "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"]);
await svc.codes.remove(mineOtp.id);
await desk.refresh();
check("удаление на телефоне убирает код и на компьютере", [desk.get("otp", mineOtp.id), svc.codes.list().length, await rejects(() => svc.codes.code(mineOtp.id))], [null, 1, "no-code"]);

/* ---- автоввод на странице сайта ---- */

const page = (url, extra = {}) => ({ url, frameId: 0, ...extra });
const field = await svc.fromPage({ type: "otp-field" }, page("https://github.com/sessions/two-factor"));
check("поле кода на привязанном сайте: модуль называет код, но не выдаёт ни его, ни секрет", [field.entries, JSON.stringify(field).includes(SECRET), /\d{6}/.test(JSON.stringify(field.entries))], [[{ id: "o1desktop0001", label: "GitHub, anna" }], false, false]);
check("чужой сайт, http и рамка другого сайта подсказку не получают", [
  (await svc.fromPage({ type: "otp-field" }, page("https://github.com.evil.example/"))).entries,
  (await svc.fromPage({ type: "otp-field" }, page("http://github.com/login"))).entries,
  (await svc.fromPage({ type: "otp-field" }, page("https://github.com/frame", { frameId: 7, tab: { url: "https://evil.example/" } }))).entries,
  (await svc.fromPage({ type: "otp-field" }, page("https://github.com/frame", { frameId: 7, tab: { url: "https://github.com/login" } }))).entries.length,
  await svc.fromPage({ type: "otp-field" }, page("not a url")),
], [[], undefined, undefined, 1, {}]);
app.asked.length = 0;
const filled = await svc.fromPage({ type: "otp-fill", id: "o1desktop0001" }, page("https://github.com/sessions/two-factor"));
check("нажатие «Вставить код»: приложение спрашивает подтверждение, затем модуль отдаёт код", [filled.code, app.asked.map(m => m.type)], [await totp(SECRET), ["auth"]]);
check("код чужого сайта по номеру записи не выдаётся", [(await svc.fromPage({ type: "otp-fill", id: "o1desktop0001" }, page("https://evil.example/"))).code, (await svc.fromPage({ type: "otp-fill", id: "нет такого" }, page("https://github.com/"))).code], [undefined, undefined]);
app.allow = false;
const refused = await svc.fromPage({ type: "otp-fill", id: "o1desktop0001" }, page("https://github.com/sessions/two-factor"));
check("без подтверждения владельца код не выдаётся", [refused.code, refused.error], [undefined, "Не подтверждено"]);
app.allow = true;

check("подтверждение владельца спрашивается у приложения", [await svc.unlock(), app.asked.pop().type], [true, "auth"]);
app.allow = false;
check("отказ подтверждения — отказ", await svc.unlock(), false);
app.allow = true;
svc.open("codes");
check("экран кодов открывает приложение", app.asked.pop(), { type: "open", page: "codes" });

/* ---- без сети: копия данных у приложения ---- */

await svc.saveNow();
check("копия данных отдана приложению", [typeof app.data.sync, JSON.parse(app.data.sync).items.map(x => x[0]).sort()], ["string", ["otp", "tabs"]]);
svc.stop();
svc = phone(app, "http://127.0.0.1:9");
await svc.ready;
await svc.run();
const offline = await svc.codes.code("o1desktop0001");
check("сервер недоступен: вход на месте, коды считаются, вкладки других устройств видны", [svc.account.signedIn, svc.state().status, offline.code, svc.state().devices.length > 0], [true, "offline", await totp(SECRET), true]);
svc.stop();
svc = phone(app);
await svc.ready;
await svc.run();

await svc.setCodes(false);
await svc.saveNow();
check("коды выключили: на телефоне их нет ни в списке, ни в копии данных; на сервере остались", [svc.codes.list(), svc.state().codesOn, JSON.parse(app.data.sync).items.map(x => x[0]), (await desk.refresh(), desk.get("otp", "o1desktop0001")?.i)], [[], false, ["tabs"], "GitHub"]);
await svc.setCodes(true);
await svc.run();
check("включили снова — коды вернулись с сервера", svc.codes.list().map(c => c.issuer), ["GitHub"]);

/* ---- пароли сайтов: слияние хранилища телефона с аккаунтом ---- */

const OLD = Date.now() - 86400000;
app.saveLogin("https://shop.example", "anna", "phone-old", { changed: OLD }); // на компьютере пароль свежее
app.saveLogin("https://mail.example", "kot", "phone-newer"); // здесь пароль свежее
app.saveLogin("https://phone-only.example", "bob", "only-here");
await deskLogin(2, "https://heleket.com", "faradei", "desk-pass-1");
await deskLogin(3, "https://shop.example", "anna", "desk-newer");
await deskLogin(4, "https://mail.example", "kot", "desk-older", { t: OLD });
await deskLogin(5, "https://router.example", "admin", "http-auth", { r: "Admin" });
await svc.setLogins(true);
await svc.run();
await desk.refresh();
const onPhone = () => [...app.logins.values()].map(l => [l.origin, l.username, l.password]).sort();
const onDesk = () => desk.list("logins").map(l => [l.data.o, l.data.u, l.data.p]).sort();
check("первое слияние: пароли компьютера появились на телефоне; у одинаковых остался более свежий", onPhone(), [
  ["https://bank.example", "anna", "desktop-password-1"], ["https://heleket.com", "faradei", "desk-pass-1"], ["https://mail.example", "kot", "phone-newer"],
  ["https://phone-only.example", "bob", "only-here"], ["https://router.example", "admin", "http-auth"], ["https://shop.example", "anna", "desk-newer"],
]);
check("и на компьютере то же самое: пароль телефона дошёл, одинаковые не раздвоились", onDesk(), onPhone());
const mineLogin = desk.list("logins").find(l => l.data.o === "https://phone-only.example");
check("запись с телефона компьютер примет: вид тот же, номер в виде uuid", [loginValid(mineLogin.id, mineLogin.data), /^[0-9a-f-]{36}$/.test(mineLogin.id), mineLogin.data.g], [true, true, `{${mineLogin.id}}`]);
check("вход по HTTP остаётся входом по HTTP", [app.login("https://router.example", "admin").httpRealm, app.login("https://router.example", "admin").formActionOrigin], ["Admin", null]);
check("экрану сообщается число паролей, приложению — только что они включены", [svc.state().loginsOn, svc.state().logins, app.last.loginsOn, JSON.stringify(app.states).includes("desk-pass-1")], [true, 6, true, false]);

let revBefore = desk.rev;
await svc.run();
await desk.refresh();
check("повторная сверка ничего не пишет", desk.rev, revBefore);

const hel = app.login("https://heleket.com", "faradei");
app.logins.set(hel.guid, { ...hel, password: "changed-on-phone", changed: Date.now() });
await deskLogin(1, "https://bank.example", "anna", "changed-on-desk");
await svc.run();
await desk.refresh();
check("правки расходятся в обе стороны: с телефона — на компьютер, с компьютера — на телефон", [desk.get("logins", uid(2)).p, app.login("https://bank.example", "anna").password], ["changed-on-phone", "changed-on-desk"]);

// один и тот же пароль поменяли и там и здесь: остаётся более поздний
const shop = app.login("https://shop.example", "anna");
app.logins.set(shop.guid, { ...shop, password: "phone-later", changed: Date.now() + 5000 });
await deskLogin(3, "https://shop.example", "anna", "desk-earlier", { t: Date.now() });
const mail = app.login("https://mail.example", "kot");
app.logins.set(mail.guid, { ...mail, password: "phone-earlier", changed: Date.now() - 5000 });
await deskLogin(4, "https://mail.example", "kot", "desk-later", { t: Date.now() });
await svc.run();
await desk.refresh();
check("одновременная правка: на обоих устройствах остаётся более поздний пароль", [desk.get("logins", uid(3)).p, app.login("https://shop.example", "anna").password, desk.get("logins", uid(4)).p, app.login("https://mail.example", "kot").password], ["phone-later", "phone-later", "desk-later", "desk-later"]);

await desk.remove("logins", uid(5));
app.logins.delete(app.login("https://phone-only.example", "bob").guid);
await svc.run();
await desk.refresh();
check("удаление доходит в обе стороны", [app.login("https://router.example", "admin"), desk.get("logins", mineLogin.id)], [null, null]);

// на компьютере пароль удалили, а на телефоне его успели изменить: он остаётся и возвращается на сервер
const bank = app.login("https://bank.example", "anna");
app.logins.set(bank.guid, { ...bank, password: "kept-on-phone", changed: Date.now() });
await desk.remove("logins", uid(1));
await svc.run();
await desk.refresh();
check("удалённый там, но изменённый здесь пароль не теряется", [app.login("https://bank.example", "anna")?.password, desk.get("logins", uid(1))?.p], ["kept-on-phone", "kept-on-phone"]);

/* ---- разом пропало много паролей ---- */

for (let i = 0; i < 24; i++) {
  app.saveLogin(`https://site${i}.example`, "u", `pw${i}`);
}
await svc.run();
await desk.refresh();
const total = desk.list("logins").length;
const kept = new Map(app.logins);
app.logins.clear(); // хранилище телефона очистили (сброс данных приложения, сбой)
await svc.run();
await desk.refresh();
check("пропажа почти всех паролей разом на сервер не уходит: ждёт решения", [desk.list("logins").length, svc.state().loginsHold?.missing, svc.state().loginsHold?.of], [total, total, total]);
await svc.resolveLoginsHold("restore");
await svc.run();
check("«вернуть»: пароли снова на телефоне, на сервере ничего не удалено", [app.logins.size, (await desk.refresh(), desk.list("logins").length), svc.state().loginsHold], [total, total, null]);
for (const l of [...app.logins.values()].filter(x => /site\d+\.example/.test(x.origin))) {
  app.logins.delete(l.guid);
}
await svc.run();
check("снова пропало много — снова ждёт", svc.state().loginsHold?.missing, 24);
await svc.resolveLoginsHold("delete");
await svc.run();
await desk.refresh();
check("«удалить везде»: пропавшие удалены и на сервере, остальные на месте", [desk.list("logins").length, app.logins.size], [total - 24, total - 24]);

/* ---- выключение и перезапуск ---- */

revBefore = desk.rev;
await svc.saveNow();
svc.stop();
svc = phone(app);
await svc.ready;
await svc.run();
await desk.refresh();
check("после перезапуска слияние помнит, что уже сверено: ничего не дублируется", [desk.rev, app.logins.size], [revBefore, total - 24]);
await svc.setLogins(false);
await svc.run();
check("выключили пароли: в хранилище телефона и на сервере они остаются", [app.logins.size, (await desk.refresh(), desk.list("logins").length), svc.state().loginsOn, svc.sync.list("logins")], [total - 24, total - 24, false, []]);
await svc.setLogins(true);
await svc.run();
await desk.refresh();
check("включили снова: одинаковые пароли узнаются, дублей нет ни там ни здесь", [app.logins.size, desk.list("logins").length], [total - 24, total - 24]);

// the app does not answer about passwords: silence must not be taken for an empty storage
app.silent = true;
await svc.run();
app.silent = false;
await desk.refresh();
check("приложение не ответило о паролях: молчание не принимается за пустое хранилище, на сервере ничего не удалено", [desk.list("logins").length, !!svc.state().loginsError, svc.state().loginsHold], [total - 24, true, null]);
await svc.run();
check("ответило — сверка снова чистая", [svc.state().loginsError, app.logins.size], ["", total - 24]);

/* ---- данные стёрли с сервера с другого устройства ---- */

await computer.api.call("DELETE", "/v1/sync", null, computer.token);
await svc.run();
const afterErase = await computer.api.syncPull(computer.token, 0, 10);
check("стирание с сервера выключает синхронизацию на телефоне: свои данные он обратно не заливает", [svc.state().erased, svc.state().tabsOn, svc.state().codesOn, svc.state().loginsOn, afterErase.items.filter(i => !i.deleted).length, afterErase.keyId || null], [true, false, false, false, 0, null]);
check("пароли в хранилище телефона при этом остаются", app.logins.size, total - 24);
desk.reset();
await svc.setTabs(true);
await svc.setCodes(true);
await svc.setLogins(true);
app.send({ type: "tabs", tabs: [{ t: "После стирания", u: "https://after-erase.example/" }] });
await svc.run();
await desk.refresh();
check("человек включил синхронизацию снова: телефон заливает свои вкладки и пароли заново", [svc.state().erased, desk.get("tabs", PHONE_ID)?.tabs[0].u, desk.list("logins").length], [false, "https://after-erase.example/", total - 24]);

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
check("после выхода кодов и копии данных на телефоне нет", [svc.codes.list(), app.data.sync, app.last.codes], [[], undefined, 0]);
check("пароли после выхода остаются в хранилище телефона, сведения о слиянии стёрты", [app.logins.size > 0, app.data.logins], [true, undefined]);

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
