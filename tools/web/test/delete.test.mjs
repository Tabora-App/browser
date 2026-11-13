// Deleting the account from the web core (web/src/core/account.js) on a local server: the
// password is checked again, with two-step protection the code too; after it every sign-in is
// over, the name is never given out again.
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs delete
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { check, rejects, summary, totp } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const stamp = Date.now().toString(36);
const PASS = "Delete-Check-pass-17!";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const device = () => ({ api: new Api(API), store: new MemoryStore() });

// ---- an account without two-step protection ----
const name = `del${stamp}`;
const d1 = device();
const a = new Account(d1);
await a.register(name, PASS);
const d2 = device();
const b = new Account(d2);
await b.signIn(name, PASS);
const events = [];
a.subscribe(e => events.push(`a:${e}`));
b.subscribe(e => events.push(`b:${e}`));
const ticket = await a.api.supportCreate(a.token, { subject: "Будет удалено", text: "Вместе с аккаунтом" });
check("аккаунт готов: два устройства, обращение", [a.signedIn, b.signedIn, ticket.id > 0], [true, true, true]);

const wrong = await rejects(async () => a.deleteAccount({ loginHash: await a.loginHashFor("Wrong-pass-000!") }));
check("с неверным паролем аккаунт не удаляется и вход остаётся", [wrong, a.signedIn, (await a.api.devices(a.token)).length >= 2], ["bad-credentials", true, true]);

await a.deleteAccount({ loginHash: await a.loginHashFor(PASS) });
check("с верным паролем аккаунт удалён: это устройство вышло, запись сессии стёрта", [a.signedIn, await d1.store.load(), events.includes("a:signed-out")], [false, null, true]);
const other = await rejects(() => b.api.supportTickets(b.token));
await sleep(100);
check("второе устройство узнаёт об этом при первом же запросе и выходит", [other, b.signedIn, events.includes("b:expired")], ["session-expired", false, true]);
const again = new Account(device());
check("войти в удалённый аккаунт нельзя, имя занято навсегда", [await rejects(() => again.signIn(name, PASS)), await again.api.available(`${name}@tabora.app`), /Пароль|занят|taken/i.test(await rejects(() => again.register(name, PASS))) || (await rejects(() => again.register(name, PASS))) === "taken"], ["bad-credentials", false, true]);

// ---- with two-step protection ----
const name2 = `del2${stamp}`;
const c = new Account(device());
await c.register(name2, PASS);
const setup = await c.api.twoFactorSetup(c.token, await c.loginHashFor(PASS));
await c.api.twoFactorEnable(c.token, await totp(setup.secret));
const hash = await c.loginHashFor(PASS);
const noCode = await rejects(() => c.deleteAccount({ loginHash: hash }));
const badCode = await rejects(() => c.deleteAccount({ loginHash: hash, code: "000000" }));
check("со вторым шагом без кода и с неверным кодом аккаунт не удаляется", [noCode, badCode, c.signedIn], ["2fa-required", "bad-2fa", true]);
await sleep(31000 - (Date.now() % 30000)); // the code that turned the protection on cannot be used twice
await c.deleteAccount({ loginHash: hash, code: await totp(setup.secret) });
check("с паролем и кодом аккаунт удалён", [c.signedIn, await rejects(() => new Account(device()).signIn(name2, PASS))], [false, "bad-credentials"]);

summary();
