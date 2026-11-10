// Совместимость закреплённой версии OpenPGP.js с GnuPG: шифрование с подписью и отсоединённые подписи
// в обе стороны. Нужен установленный gpg; ключи создаются во временном каталоге и удаляются.
//   npm ci --ignore-scripts && node interop.mjs
import * as openpgp from "openpgp";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "gpgt-"));
fs.chmodSync(home, 0o700);
const base = ["--homedir", home, "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase", "", "--trust-model", "always"];
const gpg = (args, input) => execFileSync("gpg", [...base, "--quiet", ...args], { input, stdio: ["pipe", "pipe", "pipe"] });
const verdict = enc => {
  const outFile = path.join(home, "out.bin");
  const r = spawnSync("gpg", [...base, "--status-fd", "1", "--decrypt", "--output", outFile], { input: enc, encoding: "utf8" });
  return { status: r.stdout.split("\n").filter(l => /GOODSIG|BADSIG|ERRSIG|DECRYPTION_OKAY|DECRYPTION_FAILED/.test(l)).map(l => l.split(" ")[1]).join(","), plain: fs.existsSync(outFile) ? fs.readFileSync(outFile) : null };
};
let ok = 0, bad = 0;
const check = (name, cond, detail = "") => { cond ? ok++ : bad++; console.log(cond ? "OK  " : "FAIL", name, cond ? "" : detail); };
try {
  const k = await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name: "Anna", email: "anna@tabora.app" }], format: "armored" });
  const pub = await openpgp.readKey({ armoredKey: k.publicKey });
  const priv = await openpgp.readPrivateKey({ armoredKey: k.privateKey });
  gpg(["--import"], k.publicKey);
  gpg(["--quick-generate-key", "Boris <boris@example.org>", "future-default", "default", "never"]);
  const boris = await openpgp.readKey({ armoredKey: gpg(["--armor", "--export", "boris@example.org"]).toString() });
  const data = new TextEncoder().encode("Content-Type: text/plain; charset=utf-8\r\n\r\nПривет от Tabora\r\nвторая строка \r\n");
  for (const [name, message, extra] of [
    ["двоичное сообщение", await openpgp.createMessage({ binary: data }), {}],
    ["текстовое сообщение", await openpgp.createMessage({ text: new TextDecoder().decode(data) }), {}],
    ["двоичное, без брони", await openpgp.createMessage({ binary: data }), { format: "binary" }],
  ]) {
    const enc = await openpgp.encrypt({ message, encryptionKeys: [boris, pub], signingKeys: priv, ...extra });
    const v = verdict(enc);
    // текстовый режим OpenPGP меняет концы строк: подпись сходится, но байты уже не те — поэтому письма шифруются как двоичные данные
    check(`мы → GnuPG, ${name}: расшифровано и подпись верна`, v.status === "GOODSIG,DECRYPTION_OKAY" && !!v.plain && (name.startsWith("текст") || Buffer.compare(v.plain, Buffer.from(data)) === 0), `${v.status} ${v.plain?.length}`);
  }
  const fromGpg = gpg(["--armor", "--sign", "--encrypt", "-u", "boris@example.org", "-r", "anna@tabora.app"], Buffer.from(data)).toString();
  const dec = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: fromGpg }), decryptionKeys: priv, verificationKeys: boris, format: "binary" });
  check("GnuPG → мы: расшифровано и подпись верна", Buffer.compare(Buffer.from(dec.data), Buffer.from(data)) === 0 && (await dec.signatures[0].verified.then(() => true, () => false)));
  const tampered = fromGpg.replace(/\n([A-Za-z0-9+/]{20})/, (m, g) => "\n" + g.split("").reverse().join(""));
  check("испорченное письмо не расшифровывается", await openpgp.readMessage({ armoredMessage: tampered }).then(m => openpgp.decrypt({ message: m, decryptionKeys: priv })).then(() => false, () => true));
  // отсоединённая подпись (multipart/signed)
  const sig = await openpgp.sign({ message: await openpgp.createMessage({ binary: data }), signingKeys: priv, detached: true });
  fs.writeFileSync(path.join(home, "m.bin"), data); fs.writeFileSync(path.join(home, "m.asc"), sig);
  check("GnuPG принимает нашу отсоединённую подпись", spawnSync("gpg", [...base, "--verify", path.join(home, "m.asc"), path.join(home, "m.bin")]).status === 0);
  fs.writeFileSync(path.join(home, "m2.bin"), Buffer.concat([Buffer.from(data), Buffer.from("x")]));
  check("и отвергает её для изменённого текста", spawnSync("gpg", [...base, "--verify", path.join(home, "m.asc"), path.join(home, "m2.bin")]).status !== 0);
  const gsig = gpg(["--armor", "--detach-sign", "-u", "boris@example.org", "--output", "-", path.join(home, "m.bin")]).toString();
  const v2 = await openpgp.verify({ message: await openpgp.createMessage({ binary: data }), signature: await openpgp.readSignature({ armoredSignature: gsig }), verificationKeys: boris });
  check("мы принимаем отсоединённую подпись GnuPG", await v2.signatures[0].verified.then(() => true, () => false));
  const v3 = await openpgp.verify({ message: await openpgp.createMessage({ binary: new Uint8Array([...data, 120]) }), signature: await openpgp.readSignature({ armoredSignature: gsig }), verificationKeys: boris });
  check("и отвергаем её для изменённого текста", await v3.signatures[0].verified.then(() => false, () => true));
  // ключ RSA старого образца (их много у давних пользователей PGP)
  gpg(["--default-new-key-algo", "rsa3072/cert,sign+rsa3072/encr", "--quick-generate-key", "Clara <clara@example.net>", "default", "default", "never"]);
  const clara = await openpgp.readKey({ armoredKey: gpg(["--armor", "--export", "clara@example.net"]).toString() });
  const encRsa = await openpgp.encrypt({ message: await openpgp.createMessage({ binary: data }), encryptionKeys: [clara, pub], signingKeys: priv });
  const vr = verdict(encRsa);
  check("мы → GnuPG с ключом RSA", vr.status === "GOODSIG,DECRYPTION_OKAY", vr.status);
  const fromRsa = gpg(["--armor", "--sign", "--encrypt", "-u", "clara@example.net", "-r", "anna@tabora.app"], Buffer.from(data)).toString();
  const dr = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: fromRsa }), decryptionKeys: priv, verificationKeys: clara, format: "binary" });
  check("GnuPG с ключом RSA → мы", Buffer.compare(Buffer.from(dr.data), Buffer.from(data)) === 0 && (await dr.signatures[0].verified.then(() => true, () => false)));
} catch (e) {
  bad++;
  console.log("ошибка:", String(e), String(e.stderr || "").slice(0, 300));
} finally {
  try { execFileSync("gpgconf", ["--homedir", home, "--kill", "all"]); } catch (e) {}
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`ИТОГ: ${ok} из ${ok + bad}`);
process.exit(bad ? 1 : 0);
