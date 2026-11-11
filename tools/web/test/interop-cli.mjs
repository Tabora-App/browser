// Веб-версия как второе устройство аккаунта: читает и меняет данные синхронизации. Запускается
// сквозной проверкой вместе с настоящим браузером (см. scratchpad web/interop_sync.py).
//   node <сборка> <адрес сервера> <адрес аккаунта> <файл с паролем> read|write
import { readFileSync } from "node:fs";
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { base32Decode, totp } from "../../../web/src/core/otp.js";
import { editLogin, marksAdd, marksTree, newLogin, newOtp } from "../../../web/src/core/records.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { SyncClient } from "../../../web/src/core/sync.js";

const [api, email, passwordFile, mode] = process.argv.slice(2);
const account = new Account({ api: new Api(api), store: new MemoryStore() });
await account.signIn(email, readFileSync(passwordFile, "utf8").trim());
const sync = new SyncClient(account);
const out = { keys: account.keys.state };
try {
  await sync.refresh();
  const snapshot = async () => ({
    status: sync.status, keyId: sync.keyId, unreadable: sync.unreadable,
    logins: sync.list("logins").map(l => [l.data.o, l.data.u, l.data.p]).sort(),
    otp: await Promise.all(sync.list("otp").map(async o => [o.data.i, o.data.a, await totp(base32Decode(o.data.s), { algorithm: o.data.al, digits: o.data.d, period: o.data.p }), o.data.w.map(w => w.host).join(",")])),
    marks: marksTree(sync.list("marks")).map(r => [r.n, r.children.map(c => (c.k === 2 ? `${c.n}/[${c.children.map(x => x.n).join(", ")}]` : c.n))]),
    tabs: sync.list("tabs").map(t => [t.data.name, t.data.tabs.map(x => x.u)]),
  });
  if (mode === "read") {
    out.read = await snapshot();
  } else if (mode === "write") {
    const added = newLogin({ site: "shop2.example/login", username: "boris", password: "web-secret-3" });
    await sync.put("logins", added.id, added.data);
    const bank = sync.list("logins").find(l => l.data.o === "https://bank.example");
    await sync.put("logins", bank.id, editLogin(bank.id, bank.data, { site: bank.data.o, username: bank.data.u, password: "changed-on-web" }));
    const shop = sync.list("logins").find(l => l.data.o === "https://shop.example");
    await sync.remove("logins", shop.id);
    const otp = await newOtp({ issuer: "gitlab.com", account: "boris", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
    await sync.put("otp", otp.id, otp.data);
    const folder = sync.list("marks").find(m => m.data.k === 2 && m.data.n === "Работа");
    const mark = marksAdd(sync.list("marks"), folder.id, { title: "Из веб-версии", url: "web.example/page" });
    await sync.write(mark.changes);
    const root = marksAdd(sync.list("marks"), "unfiled_____", { title: "", url: "https://unfiled.example/" });
    await sync.write(root.changes);
    out.wrote = { login: added.id, otp: otp.id, otpCode: await totp(base32Decode(otp.data.s)), mark: mark.id };
    out.after = await snapshot();
  }
} finally {
  await account.signOut();
}
console.log(JSON.stringify(out));
