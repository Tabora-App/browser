// Сеансы устройств аккаунта: показать и завершить проверочные (веб-версия, пробы).
//   node <сборка> <сервер аккаунтов> <имя> <файл с паролем> list|clean
import { readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { MemoryStore } from "../../../web/src/core/store.js";

const [api, name, passwordFile, mode] = process.argv.slice(2);
const password = readFileSync(passwordFile, "utf8").trim();
const account = new Account({ api: new Api(api), store: new MemoryStore() });
await account.signIn(name, password);
const out = { mail: account.session.mail && Object.keys(account.session.mail) };
try {
  let devices = await account.api.devices(account.token);
  out.before = devices.map(d => `${d.name}${d.current ? " (это)" : ""}${d.active === false ? " [вышло]" : ""}`);
  if (mode === "clean") {
    const loginHash = await account.loginHashFor(password);
    out.revoked = [];
    for (const d of devices.filter(d => !d.current && /^(Веб-версия|Проба веб-версии)/.test(d.name))) {
      await account.api.deviceRevoke(account.token, d.id, loginHash);
      out.revoked.push(d.name);
    }
    devices = await account.api.devices(account.token);
    out.after = devices.map(d => `${d.name}${d.current ? " (это)" : ""}`);
  }
} finally {
  await account.signOut();
}
console.log(JSON.stringify(out, null, 1));
