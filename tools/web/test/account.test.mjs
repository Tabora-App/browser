// Аккаунт на локальном сервере (scratchpad srv2/local.sh): регистрация, ключи, вход, сохранённая
// сессия, второй фактор, смена пароля, сброс ключом восстановления и по письму.
//   TABORA_API=http://127.0.0.1:7711 TABORA_OUTBOX=<папка писем сервера> node test/run.mjs account
import { readdirSync, readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { hex } from "../../../web/src/core/bytes.js";
import { base32Decode, totp } from "../../../web/src/core/otp.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { check, rejects, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const OUTBOX = process.env.TABORA_OUTBOX || "";
const name = `web${Date.now().toString(36)}`;
const email = `${name}@tabora.app`;
const P1 = "Web-Check-pass-17!";
const P2 = "Web-Check-next-28!";
const P3 = "Web-Check-third-39!";
const P4 = "Web-Check-four-40!";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mailCode(to, after) {
  for (let i = 0; i < 40; i++) {
    const hits = readdirSync(OUTBOX).filter(f => f.endsWith(".json") && Number(f.split("-")[0]) >= after).sort().map(f => JSON.parse(readFileSync(`${OUTBOX}/${f}`, "utf8"))).filter(m => m.to === to);
    const m = hits.length && /(\d{3,4}) (\d{3,4})/.exec(hits[hits.length - 1].text);
    if (m) {
      return m[1] + m[2];
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return "";
}

const device = () => ({ api: new Api(API), store: new MemoryStore() });
const d1 = device();
const a = new Account(d1);

check("имя вне домена и кривое имя отклоняются до сервера", [await rejects(() => a.signIn("kot@example.org", "x")), await rejects(() => a.signIn("a..b", "x"))], ["bad-email", "bad-email"]);
check("слабый пароль не принимается", /^Пароль:/.test(await rejects(() => a.register(name, "qwerty123456"))), true);

const steps = [];
a.onStep = t => steps.push(t);
const reg = await a.register(name, P1);
check("регистрация: аккаунт создан, ключи открыты, ключ восстановления выдан", [reg.email, a.signedIn, a.keys.state, a.keys.dataKey?.length, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(reg.recoveryKey), a.keys.canPassword, a.keys.canRecovery, /PRIVATE KEY BLOCK/.test(a.keys.privateKey)], [email, true, "ok", 32, true, true, true, true]);
check("по ходу регистрации интерфейсу сообщались этапы", steps.includes("Создаём аккаунт") && steps.includes("Создаём ключ шифрования"), true);
const dataKey = hex(a.keys.dataKey);
const fp = a.keys.fingerprint;
const sec = await a.api.security(a.token);
check("сервер знает ключ восстановления и не знает второго фактора", [sec.recoveryKey, sec.twoFactor.enabled], [true, false]);
check("повторная регистрация того же имени отклоняется", await rejects(() => new Account(device()).register(name, P1)), "taken");

// сохранённая сессия: «перезагрузка страницы»
const again = new Account({ api: new Api(API), store: d1.store });
check("сохранённая сессия поднимается без пароля", [await again.restore(), again.email, (await again.refreshKeys()).state, hex(again.keys.dataKey) === dataKey, again.keys.fingerprint === fp], [true, email, "ok", true, true]);

// второе устройство
const d2 = device();
const b = new Account(d2);
check("неверный пароль", await rejects(() => b.signIn(email, "Wrong-pass-000!")), "bad-credentials");
await b.signIn(name, P1, { remember: true });
check("вход с другого устройства открывает тот же ключ данных", [b.signedIn, b.keys.state, hex(b.keys.dataKey) === dataKey, b.keys.fingerprint === fp, (await d2.store.load()).remember], [true, "ok", true, true, true]);
const devices = await b.api.devices(b.token);
check("в списке устройств два устройства, текущее отмечено", [devices.length, devices.filter(d => d.current).length, devices.every(d => /^Веб-версия/.test(d.name))], [2, 1, true]);

// второй фактор
const setup = await a.api.twoFactorSetup(a.token, await a.loginHashFor(P1));
const code = shift => totp(base32Decode(setup.secret), { now: Date.now() + shift * 30000 });
const enabled = await a.api.twoFactorEnable(a.token, await code(0));
check("второй фактор включён, выдано десять резервных кодов", [enabled.backupCodes.length, (await a.api.security(a.token)).twoFactor.enabled], [10, true]);
const d3 = device();
const c = new Account(d3);
check("вход без кода просит код, с неверным кодом — отказ", [await rejects(() => c.signIn(name, P1)), await rejects(() => c.signIn(name, "", { totp: "000000" }))], ["2fa-required", "bad-2fa"]);
await c.signIn(name, "", { totp: enabled.backupCodes[0] });
check("вход с резервным кодом, пароль повторно не вводился", [c.signedIn, c.keys.state, hex(c.keys.dataKey) === dataKey], [true, "ok", true]);
await c.signOut();
check("выход стирает сессию", [c.signedIn, await d3.store.load(), c.keys.state], [false, null, "none"]);
await sleep(31000); // код приложения принимается один раз: ждём следующий
await a.api.twoFactorDisable(a.token, await a.loginHashFor(P1), await code(0));
check("второй фактор выключен", (await a.api.security(a.token)).twoFactor.enabled, false);

// смена пароля
await a.changePassword(P1, P2);
check("смена пароля: остальные устройства вышли, это осталось", [await rejects(() => b.api.devices(b.token)), (await a.api.devices(a.token)).length >= 1], ["session-expired", true]);
check("после отзыва сессии устройство само узнаёт, что вышло", [b.signedIn, await d2.store.load()], [false, null]);
const e = new Account(device());
check("прежний пароль не подходит", await rejects(() => e.signIn(name, P1)), "bad-credentials");
await e.signIn(name, P2);
check("новый пароль открывает тот же ключ данных", [e.keys.state, hex(e.keys.dataKey) === dataKey], ["ok", true]);

// сброс ключом восстановления
const f = new Account(device());
check("чужой ключ восстановления не подходит", await rejects(() => f.resetWithRecovery(name, "ABCD-EFGH-ABCD-EFGH-ABCD-EFGH-ABCD-EFGH", P3)), "bad-proof");
const reset = await f.resetWithRecovery(name, reg.recoveryKey, P3);
check("сброс ключом восстановления принят", reset.email, email);
await f.signIn(name, P3);
check("после сброса новый пароль входит, но копия ключа привязана к прежнему паролю", [f.signedIn, f.keys.state, f.keys.reason, f.keys.canRecovery], [true, "locked", "wrong-wrap", true]);
check("чужой ключ восстановления ключи не открывает", await rejects(() => f.unlockWithRecovery("ABCD-EFGH-ABCD-EFGH-ABCD-EFGH-ABCD-EFGH", P3)), "wrong-wrap");
await f.unlockWithRecovery(reg.recoveryKey, P3);
check("ключ восстановления открывает ключ данных и привязывает его к новому паролю", [f.keys.state, hex(f.keys.dataKey) === dataKey, f.keys.canPassword], ["ok", true, true]);
const g = new Account(device());
await g.signIn(name, P3);
check("следующий вход открывает ключи одним паролем", [g.keys.state, hex(g.keys.dataKey) === dataKey], ["ok", true]);

// резервный адрес и сброс по письму
if (OUTBOX) {
  let t = Date.now();
  await g.api.backupEmailSet(g.token, { loginHash: await g.loginHashFor(P3), address: "backup@example.org" });
  const verify = mailCode("backup@example.org", t);
  await g.api.backupEmailVerify(g.token, verify);
  check("резервный адрес подтверждён кодом из письма", (await g.api.security(g.token)).backupEmail?.address, "backup@example.org");
  t = Date.now();
  await g.api.resetEmailStart(email);
  const resetCode = mailCode("backup@example.org", t);
  const h = new Account(device());
  check("неверный код из письма отклоняется", await rejects(() => h.resetWithEmailCode(name, "00000000", P4)), "bad-code");
  await h.resetWithEmailCode(name, resetCode, P4);
  check("сброс по письму: вход выполнен, ключи ждут прежнего пароля или ключа восстановления", [h.signedIn, h.keys.state, h.keys.reason], [true, "locked", "wrong-wrap"]);
  check("неверный прежний пароль ключи не открывает", await rejects(() => h.unlockWithOldPassword(P1, P4)), "wrong-wrap");
  await h.unlockWithOldPassword(P3, P4);
  check("прежний пароль открывает ключ данных и привязывает его к новому", [h.keys.state, hex(h.keys.dataKey) === dataKey], ["ok", true]);
  const i = new Account(device());
  await i.signIn(name, P4);
  check("после этого вход новым паролем открывает ключи сам", [i.keys.state, hex(i.keys.dataKey) === dataKey], ["ok", true]);
  const rk2 = await i.newRecoveryKey();
  const j = new Account(device());
  check("новый ключ восстановления: прежний больше не сбрасывает пароль, новый сбрасывает", [await rejects(() => j.resetWithRecovery(name, reg.recoveryKey, P1)), (await j.resetWithRecovery(name, rk2, P1)).email], ["bad-proof", email]);
} else {
  console.log("SKIP сброс по письму: не задана папка писем TABORA_OUTBOX");
}
summary();
