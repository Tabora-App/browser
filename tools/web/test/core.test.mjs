// Основа без сервера: кодировки, ключ восстановления, ключи из пароля (обе реализации Argon2id
// дают одно и то же), обёртки ключей.
import { ed25519 } from "@noble/curves/ed25519";
import { argon2id as noble } from "@noble/hashes/argon2";
import { b64, fromB64, fromHex, hex, hkdf, open, random, seal, utf8 } from "../../../web/src/core/bytes.js";
import { argon2id } from "../../../web/src/core/kdf-core.js";
import { passwordKeys } from "../../../web/src/core/kdf.js";
import { rkFormat, rkNew, rkParse, rkSignReset, rkVerifier, rkWrapKey } from "../../../web/src/core/recovery.js";
import { check, rejects, summary } from "./lib.mjs";

const bytes = random(1000);
check("Base64 туда и обратно, в том числе в виде для адресов", [hex(fromB64(b64(bytes))) === hex(bytes), hex(fromB64(b64(bytes).replace(/\+/g, "-").replace(/\//g, "_"))) === hex(bytes)], [true, true]);
check("hex туда и обратно", hex(fromHex("00ff10ab")), "00ff10ab");

const rk = rkNew();
check("ключ восстановления: 8 групп по 4 знака, разбирается обратно", [/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(rk), rkFormat(rkParse(rk)) === rk, rkParse(rk).length], [true, true, 20]);
check("опечатки 0/O, 1/L, 8/B и регистр прощаются", rkFormat(rkParse(rk.toLowerCase().replace(/o/g, "0").replace(/l/g, "1").replace(/b/g, "8").replace(/-/g, " "))), rk);
check("неполный ключ отклоняется", await rejects(() => rkParse("ABCD-EFGH")), "Ключ восстановления: 32 символа в 8 группах по 4");
const verifier = rkVerifier(rk);
const proof = rkSignReset(rk, "a@tabora.app", "ab".repeat(32), "0f".repeat(16));
check("подпись сброса сходится с открытым ключом, который получает сервер", [/^ed25519:[0-9a-f]{64}$/.test(verifier), ed25519.verify(fromHex(proof), utf8(`tabora-reset-v2|a@tabora.app|${"ab".repeat(32)}|${"0f".repeat(16)}`), fromHex(verifier.slice(8)))], [true, true]);
check("ключ обёртки из ключа восстановления — 32 байта и не совпадает с ключом подписи", [rkWrapKey(rk).length, hex(rkWrapKey(rk)) !== verifier.slice(8)], [32, true]);

const fast = await argon2id(utf8("пароль"), new Uint8Array(16).fill(3), { t: 2, m: 1024, p: 1, dkLen: 32 });
check("Argon2id: быстрая реализация включилась и совпала с эталонной", [fast.engine, hex(fast.out)], ["wasm", hex(noble(utf8("пароль"), new Uint8Array(16).fill(3), { t: 2, m: 1024, p: 1, dkLen: 32 }))]);

const t0 = Date.now();
const k1 = await passwordKeys("kot.test@tabora.app", "Correct-Horse-7!", 2);
const ms = Date.now() - t0;
const k2 = await passwordKeys("kot.test@tabora.app", "Correct-Horse-7!", 2);
const k3 = await passwordKeys("other@tabora.app", "Correct-Horse-7!", 2);
check("ключи из пароля: хеш входа 64 знака, повтор даёт то же, другой адрес — другое", [/^[0-9a-f]{64}$/.test(k1.loginHash), k1.loginHash === k2.loginHash, hex(k1.wrapKey) === hex(k2.wrapKey), k1.loginHash !== k3.loginHash, hex(k1.wrapKey) !== k1.loginHash], [true, true, true, true, true]);
console.log(`     (расчёт 64 МБ × 3 прохода: ${ms} мс)`);
check("составные знаки в пароле приводятся к одному виду (NFKC)", (await passwordKeys("a@tabora.app", "é-пароль-1", 1)).loginHash, (await passwordKeys("a@tabora.app", "é-пароль-1", 1)).loginHash);

const key = random(32);
const blob = await seal(key, "метка", utf8("секрет"));
check("обёртка: открывается своим ключом и меткой, не открывается чужими", [new TextDecoder().decode(await open(key, "метка", blob)), await open(key, "другая", blob), await open(random(32), "метка", blob)], ["секрет", null, null]);
check("HKDF даёт 32 байта и зависит от метки", [(await hkdf(key, "tabora-sync/v1", "a")).length, hex(await hkdf(key, "tabora-sync/v1", "a")) !== hex(await hkdf(key, "tabora-sync/v1", "b"))], [32, true]);
summary();
