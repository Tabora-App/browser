// Второе устройство аккаунта для сквозной проверки вкладок с приложением на телефоне: создаёт
// аккаунт, показывает списки вкладок всех устройств и пишет свой — в том же виде, что браузер
// на компьютере.
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> register
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> show
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> put <имя устройства> <адрес>…
import { readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
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
  out.tabs = sync.list("tabs").map(r => ({ id: r.id === DEVICE ? "(это устройство)" : r.id.slice(0, 8), name: r.data.name, at: new Date(r.data.at).toISOString(), tabs: r.data.tabs.map(x => `${x.t} — ${x.u}`) }));
  out.devices = (await account.api.devices(account.token)).map(d => `${d.name}${d.current ? " (это)" : ""}${d.active === false ? " [вышло]" : ""}`);
} finally {
  await account.signOut();
}
console.log(JSON.stringify(out, null, 1));
