// Второе устройство аккаунта для сквозной проверки с приложением на телефоне: создаёт аккаунт,
// показывает списки вкладок всех устройств и коды входа, пишет свой список вкладок и код — в том
// же виде, что браузер на компьютере.
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> register
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> show
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> put <имя устройства> <адрес>…
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> otp <сервис> <аккаунт> <секрет Base32> [сайт…]
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> send <адрес> [заголовок]   — "send to device": to the first phone of the account
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> visit <адрес> [заголовок]  — history sync: this device "visited" a page just now
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> address <имя> <улица> <страна> [телефон]  — an autofill address saved on this device
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> card <номер> <имя> <месяц> <год>         — a bank card saved on this device
import { readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { newOtp } from "../../../web/src/core/codes.js";
import { base32Decode, totp } from "../../../web/src/core/otp.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";

const [api, name, passwordFile, mode, ...rest] = process.argv.slice(2);
const password = readFileSync(passwordFile, "utf8").trim();
const DEVICE = "web-tabspeer0000000000";
const account = new Account({ api: new Api(api), store: new MemoryStore(DEVICE), deviceName: () => "Проверочный компьютер" });
const out = {};
if (mode === "register") {
  await account.register(name, password);
  out.registered = account.email;
} else {
  await account.signIn(name, password);
}
try {
  const sync = new SyncClient(account);
  await sync.refresh();
  if (mode === "put") {
    const [device, ...urls] = rest;
    await sync.put("tabs", DEVICE, { name: device, at: Date.now(), tabs: urls.map((u, i) => ({ t: `Страница ${i + 1}`, u })) });
  }
  if (mode === "send") {
    const [url, title = ""] = rest;
    const phone = sync.list("tabs").find(r => r.id.startsWith("and-"));
    if (!phone) {
      throw new Error("в аккаунте нет телефона со списком вкладок");
    }
    if (!sync.get("tabs", DEVICE)) {
      await sync.put("tabs", DEVICE, { name: "Проверочный компьютер", at: Date.now(), tabs: [] });
    }
    const mine = sync.get("sent", DEVICE);
    const item = { id: `s${Date.now().toString(36)}cli`, to: phone.id, u: url, t: title, at: Date.now() };
    await sync.put("sent", DEVICE, { name: "Проверочный компьютер", items: [...(mine?.items || []), item].slice(-50) });
    out.sentTo = phone.data.name;
  }
  if (mode === "visit") {
    const [url, title = ""] = rest;
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const id = `${DEVICE}-${day}`;
    const had = sync.get("history", id);
    const pages = [{ u: url, t: title, at: Date.now() }, ...(had?.p || []).filter(p => p.u !== url)];
    await sync.put("history", id, { name: "Проверочный компьютер", day, p: pages });
  }
  const recordId = () => Math.random().toString(16).slice(2, 14).padEnd(12, "0");
  if (mode === "address") {
    const [who, street, country, tel = ""] = rest;
    await sync.put("addresses", recordId(), { f: { name: who, "street-address": street, country, ...(tel ? { tel } : {}) }, c: Date.now(), m: Date.now() });
  }
  if (mode === "card") {
    const [number, who, month, year] = rest;
    await sync.put("cards", recordId(), { f: { "cc-number": number, "cc-name": who, "cc-exp-month": Number(month), "cc-exp-year": Number(year) }, c: Date.now(), m: Date.now() });
  }
  if (mode === "otp") {
    const [issuer, name2, secret, ...sites] = rest;
    const made = await newOtp({ issuer, account: name2, secret, sites: sites.length ? sites : null });
    await sync.put("otp", made.id, made.data);
  }
  out.codes = await Promise.all(sync.list("otp").map(async o => `${o.data.i} (${o.data.a}): ${await totp(base32Decode(o.data.s), { algorithm: o.data.al, digits: o.data.d, period: o.data.p })} — ${(o.data.w || []).map(w => w.host).join(", ")}`));
  out.tabs = sync.list("tabs").map(r => ({ id: r.id === DEVICE ? "(это устройство)" : r.id.slice(0, 8), name: r.data.name, at: new Date(r.data.at).toISOString(), tabs: r.data.tabs.map(x => `${x.t} — ${x.u}`) }));
  out.history = sync.list("history").map(r => ({ from: r.id.startsWith(DEVICE) ? "(это устройство)" : r.data.name, day: r.data.day, pages: (r.data.p || []).map(p => `${p.t || "—"} — ${p.u}${p.n > 1 ? ` ×${p.n}` : ""}`).slice(0, 8) }));
  out.addresses = sync.list("addresses").map(r => `${r.data.f.name || "—"}, ${r.data.f["street-address"] || "—"}, ${r.data.f.country || "—"}${r.data.f.tel ? `, ${r.data.f.tel}` : ""}`);
  // card numbers are shown by their last four digits only
  out.cards = sync.list("cards").map(r => `…${String(r.data.f["cc-number"]).slice(-4)} ${r.data.f["cc-name"] || "—"} ${r.data.f["cc-exp-month"] || "—"}/${r.data.f["cc-exp-year"] || "—"}`);
  out.sent = sync.list("sent").map(r => ({ from: r.id === DEVICE ? "(это устройство)" : r.data.name, items: (r.data.items || []).map(i => `${i.u} → ${i.to === DEVICE ? "(это устройство)" : i.to.slice(0, 8)}`) }));
  out.devices = (await account.api.devices(account.token)).map(d => `${d.name}${d.current ? " (это)" : ""}${d.active === false ? " [вышло]" : ""}`);
} finally {
  await account.signOut();
}
console.log(JSON.stringify(out, null, 1));
