// Проверка HTTP-контракта tabora-server на запущенном экземпляре без почтового сервера:
//   node tests/contract.mjs http://127.0.0.1:7711 tabora.app /путь/к/каталогу-писем
// Сервер должен быть запущен с пустой базой, TABORA_SIGNUP_PER_IP=6 (тест проверяет и этот
// предел) и TABORA_MAIL_OUTBOX=<тот же каталог>: письма сервера складываются туда файлами.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:7711").replace(/\/+$/, "");
const DOMAIN = process.argv[3] || "tabora.app";
const OUTBOX = process.argv[4] || "";
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log("OK  ", name);
  } else {
    failed++;
    console.log("FAIL", name, detail);
  }
}

async function call(method, path, { body, token, ip = "198.51.100.1", raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {}
  return { status: res.status, json, text, headers: res.headers };
}

const hash = seed => crypto.createHash("sha256").update(seed).digest("hex");
const device = n => crypto.createHash("sha256").update("device" + n).digest("hex").slice(0, 24);
const tag = crypto.randomBytes(3).toString("hex");
const name = n => `t${tag}${n}`;
const mail = n => `${name(n)}@${DOMAIN}`;

function b32decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    acc = (acc << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
      acc &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** Код приложения (RFC 6238) для секрета в Base32; shift — сдвиг в шагах по 30 секунд. */
function totp(secret, shift = 0) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + shift));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(buf).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, "0");
}

const otherCode = code => String((Number(code) + 1) % 1e6).padStart(6, "0");

/** Последнее письмо сервера на адрес: { subject, text, code }. Письма уходят в фоне, поэтому ждём. */
async function lastMail(to, { wait = 2500, after = 0 } = {}) {
  const until = Date.now() + wait;
  for (;;) {
    const found = fs
      .readdirSync(OUTBOX)
      .filter(f => f.endsWith(".json") && Number(f.split("-")[0]) >= after)
      .sort()
      .map(f => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), "utf8")))
      .filter(m => m.to === to)
      .pop();
    if (found || Date.now() > until) {
      const m = found && /(\d{3,4}) (\d{3,4})/.exec(found.text);
      return found ? { ...found, code: m ? m[1] + m[2] : null } : null;
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

const mailsTo = to => fs.readdirSync(OUTBOX).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), "utf8"))).filter(m => m.to === to);

function recoveryKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { verifier: `ed25519:${pub}`, sign: msg => crypto.sign(null, Buffer.from(msg), privateKey).toString("hex") };
}

const r0 = await call("GET", "/v1/health");
check("сервер отвечает", r0.status === 200 && r0.json.ok === true, r0.text);
check("ответы не кешируются", r0.headers.get("cache-control") === "no-store");

// имена
check("свободное имя доступно", (await call("GET", `/v1/account/available?email=${encodeURIComponent(mail("a"))}`)).json.available === true);
for (const bad of ["ab", "postmaster", "hello", "tabora-team", "A..b", `x@other.example`, "", "a".repeat(40)]) {
  const r = await call("GET", `/v1/account/available?email=${encodeURIComponent(bad.includes("@") ? bad : bad + "@" + DOMAIN)}`);
  check(`имя «${bad.slice(0, 14)}» недоступно`, r.status === 200 && r.json.available === false, r.text);
}
check("версия хеша для неизвестного адреса — текущая", (await call("GET", `/v1/account/prelogin?email=${encodeURIComponent(mail("nobody"))}`)).json.kdf === 2);

// регистрация
const A = { email: mail("a"), pw1: hash("a-pass-1"), pw2: hash("a-pass-2"), pw3: hash("a-pass-3") };
let r = await call("POST", "/v1/account/register", { body: { email: A.email, loginHash: A.pw1, kdf: 2, deviceId: device(1), deviceName: "Мак Анны" } });
check("регистрация", r.status === 200 && /^u[0-9a-f]{20}$/.test(r.json.userId) && /^tbs_/.test(r.json.session.token) && /^\d{4}-\d\d-\d\dT/.test(r.json.session.expiresAt), r.text);
A.userId = r.json?.userId;
A.s1 = r.json?.session?.token;
check("без почтового сервера ящик не выдаётся", r.json.mail === null);
check("занятое имя недоступно", (await call("GET", `/v1/account/available?email=${encodeURIComponent(A.email)}`)).json.available === false);
r = await call("POST", "/v1/account/register", { body: { email: A.email, loginHash: A.pw2, kdf: 2, deviceId: device(9), deviceName: "x" } });
check("повторная регистрация отклонена", r.status === 409 && r.json.code === "taken" && r.json.message === "Такой адрес уже занят", r.text);
for (const [what, body] of [
  ["плохое имя", { email: "ab@" + DOMAIN, loginHash: A.pw1, kdf: 2, deviceId: device(1) }],
  ["чужой домен", { email: "anna@other.example", loginHash: A.pw1, kdf: 2, deviceId: device(1) }],
  ["плохой хеш", { email: mail("z"), loginHash: "123", kdf: 2, deviceId: device(1) }],
  ["старая версия хеша", { email: mail("z"), loginHash: A.pw1, kdf: 1, deviceId: device(1) }],
  ["плохое устройство", { email: mail("z"), loginHash: A.pw1, kdf: 2, deviceId: "x" }],
]) {
  r = await call("POST", "/v1/account/register", { body });
  check(`регистрация: ${what} → 400`, r.status === 400 && !!r.json?.code && !!r.json?.message, r.text);
}
r = await call("POST", "/v1/account/register", { raw: "{не json" });
check("не JSON → 400 с понятным ответом", r.status === 400 && r.json?.code === "bad-request", r.text);
r = await call("POST", "/v1/account/register", { raw: JSON.stringify({ email: A.email, pad: "x".repeat(70_000) }) });
check("слишком большой запрос отклонён", r.status === 413, String(r.status));

// вход
r = await call("POST", "/v1/account/login", { body: { email: A.email, loginHash: A.pw1, deviceId: device(2), deviceName: "Второй\u0007 компьютер" } });
check("вход со второго устройства", r.status === 200 && r.json.userId === A.userId && r.json.kdf === 2 && !!r.json.session.token, r.text);
A.s2 = r.json?.session?.token;
r = await call("POST", "/v1/account/login", { body: { email: name("a"), loginHash: A.pw1, deviceId: device(2), deviceName: "Второй компьютер" } });
check("вход по имени без домена", r.status === 200, r.text);
A.s2b = r.json?.session?.token;
const wrong = await call("POST", "/v1/account/login", { body: { email: A.email, loginHash: A.pw2, deviceId: device(2) }, ip: "198.51.100.7" });
const unknown = await call("POST", "/v1/account/login", { body: { email: mail("ghost"), loginHash: A.pw2, deviceId: device(2) }, ip: "198.51.100.7" });
check("неверный пароль → 401", wrong.status === 401 && wrong.json.code === "bad-credentials", wrong.text);
check("неизвестный адрес отвечает так же, как неверный пароль", unknown.status === 401 && unknown.text === wrong.text, unknown.text);

// устройства и сессии
r = await call("GET", "/v1/account/devices", { token: A.s1 });
check("список устройств", r.status === 200 && r.json.length === 2 && r.json.some(d => d.name === "Мак Анны" && d.current) && r.json.some(d => d.name === "Второй компьютер" && !d.current) && r.json.every(d => typeof d.at === "number"), r.text);
r = await call("GET", "/v1/account/devices", { token: "tbs_" + "x".repeat(43) });
check("чужой токен → 401 «сессия истекла»", r.status === 401 && r.json.code === "session-expired", r.text);
r = await call("GET", "/v1/account/devices");
check("без токена → 401", r.status === 401 && r.json.code === "session-expired", r.text);

// блокировка перебора (отдельный аккаунт и адрес)
const B = { email: mail("b"), pw: hash("b-pass") };
r = await call("POST", "/v1/account/register", { body: { email: B.email, loginHash: B.pw, kdf: 2, deviceId: device(3), deviceName: "B" } });
B.s = r.json?.session?.token;
let codes = [];
for (let i = 0; i < 6; i++) {
  codes.push((await call("POST", "/v1/account/login", { body: { email: B.email, loginHash: hash("guess" + i), deviceId: device(3) }, ip: "203.0.113.5" })).status);
}
check("пять неверных паролей подряд, шестая попытка заблокирована", codes.join() === "401,401,401,401,401,429", codes.join());
r = await call("POST", "/v1/account/login", { body: { email: B.email, loginHash: B.pw, deviceId: device(3) }, ip: "203.0.113.5" });
check("во время паузы не проходит и верный пароль", r.status === 429 && r.json.code === "rate-limited" && /минуту|мин/.test(r.json.message), r.text);
r = await call("POST", "/v1/account/login", { body: { email: B.email, loginHash: B.pw, deviceId: device(3) }, ip: "203.0.113.99" });
check("с другого адреса владелец входит (блокировкой его не отрезать)", r.status === 200, r.text);

// смена пароля
r = await call("POST", "/v1/account/password", { token: A.s1, body: { oldLoginHash: A.pw2, newLoginHash: A.pw2, kdf: 2 } });
check("смена пароля: неверный текущий → 401", r.status === 401 && r.json.code === "bad-credentials" && r.json.message === "Неверный текущий пароль", r.text);
r = await call("POST", "/v1/account/password", { token: A.s1, body: { oldLoginHash: A.pw1, newLoginHash: A.pw2, kdf: 2 } });
check("смена пароля", r.status === 200, r.text);
check("текущая сессия после смены пароля жива", (await call("GET", "/v1/account/devices", { token: A.s1 })).status === 200);
check("сессии других устройств завершены", (await call("GET", "/v1/account/devices", { token: A.s2 })).status === 401 && (await call("GET", "/v1/account/devices", { token: A.s2b })).status === 401);
check("старый пароль больше не подходит", (await call("POST", "/v1/account/login", { body: { email: A.email, loginHash: A.pw1, deviceId: device(2) }, ip: "198.51.100.8" })).status === 401);
r = await call("POST", "/v1/account/login", { body: { email: A.email, loginHash: A.pw2, deviceId: device(2), deviceName: "Второй компьютер" } });
check("новый пароль подходит", r.status === 200, r.text);
A.s2 = r.json?.session?.token;

// ключ восстановления и сброс
const key = recoveryKey();
r = await call("POST", "/v1/account/recovery", { token: A.s1, body: { recoveryVerifier: "abcdef" } });
check("ключ проверки прежней схемы не принимается", r.status === 400, r.text);
let ch = await call("POST", "/v1/account/reset/challenge", { body: { email: A.email }, ip: "198.51.100.20" });
r = await call("POST", "/v1/account/reset", { body: { email: A.email, nonce: ch.json.nonce, recoveryProof: key.sign(`tabora-reset-v2|${A.email}|${A.pw3}|${ch.json.nonce}`), newLoginHash: A.pw3, kdf: 2 }, ip: "198.51.100.20" });
check("сброс без зарегистрированного ключа → 409", r.status === 409 && r.json.code === "no-recovery", r.text);
r = await call("POST", "/v1/account/recovery", { token: A.s1, body: { recoveryVerifier: key.verifier } });
check("ключ проверки зарегистрирован", r.status === 200, r.text);
ch = await call("POST", "/v1/account/reset/challenge", { body: { email: A.email }, ip: "198.51.100.20" });
check("nonce выдан", ch.status === 200 && /^[0-9a-f]{32}$/.test(ch.json.nonce), ch.text);
const other = recoveryKey();
r = await call("POST", "/v1/account/reset", { body: { email: A.email, nonce: ch.json.nonce, recoveryProof: other.sign(`tabora-reset-v2|${A.email}|${A.pw3}|${ch.json.nonce}`), newLoginHash: A.pw3, kdf: 2 }, ip: "198.51.100.20" });
check("сброс чужим ключом → отказ", r.status === 400 && r.json.code === "bad-proof", r.text);
r = await call("POST", "/v1/account/reset", { body: { email: A.email, nonce: ch.json.nonce, recoveryProof: key.sign(`tabora-reset-v2|${A.email}|${A.pw3}|${ch.json.nonce}`), newLoginHash: A.pw3, kdf: 2 }, ip: "198.51.100.20" });
check("nonce одноразовый: после неудачи тот же не годится", r.status === 400 && r.json.code === "bad-nonce", r.text);
ch = await call("POST", "/v1/account/reset/challenge", { body: { email: A.email }, ip: "198.51.100.20" });
r = await call("POST", "/v1/account/reset", { body: { email: A.email, nonce: ch.json.nonce, recoveryProof: key.sign(`tabora-reset-v2|${A.email}|${A.pw2}|${ch.json.nonce}`), newLoginHash: A.pw3, kdf: 2 }, ip: "198.51.100.20" });
check("подпись под другим паролем не подходит", r.status === 400 && r.json.code === "bad-proof", r.text);
ch = await call("POST", "/v1/account/reset/challenge", { body: { email: A.email }, ip: "198.51.100.20" });
r = await call("POST", "/v1/account/reset", {
  body: { email: A.email, nonce: ch.json.nonce, recoveryProof: key.sign(`tabora-reset-v2|${A.email}|${A.pw3}|${ch.json.nonce}`), newLoginHash: A.pw3, kdf: 2, legacyRecoveryProof: "00", newRecoveryVerifier: other.verifier },
  ip: "198.51.100.20",
});
check("сброс верным ключом", r.status === 200, r.text);
check("после сброса все сессии завершены", (await call("GET", "/v1/account/devices", { token: A.s1 })).status === 401 && (await call("GET", "/v1/account/devices", { token: A.s2 })).status === 401);
r = await call("POST", "/v1/account/login", { body: { email: A.email, loginHash: A.pw3, deviceId: device(1), deviceName: "Мак Анны" }, ip: "198.51.100.21" });
check("вход новым паролем после сброса", r.status === 200, r.text);
A.s1 = r.json?.session?.token;
// с другого адреса: у сброса свой предел (десять обращений в час с адреса), первый уже почти выбран
ch = await call("POST", "/v1/account/reset/challenge", { body: { email: A.email }, ip: "198.51.100.23" });
r = await call("POST", "/v1/account/reset", { body: { email: A.email, nonce: ch.json.nonce, recoveryProof: other.sign(`tabora-reset-v2|${A.email}|${A.pw1}|${ch.json.nonce}`), newLoginHash: A.pw1, kdf: 2 }, ip: "198.51.100.23" });
check("присланный при сбросе новый ключ проверки не подменил прежний", r.status === 400 && r.json.code === "bad-proof", r.text);
codes = [];
for (let i = 0; i < 3; i++) {
  codes.push((await call("POST", "/v1/account/reset/challenge", { body: { email: A.email }, ip: "198.51.100.20" })).status);
}
check("сброс: не больше десяти обращений в час с одного адреса", codes.includes(429), codes.join());
const ghost = await call("POST", "/v1/account/reset/challenge", { body: { email: mail("ghost") }, ip: "198.51.100.22" });
check("nonce выдаётся и для неизвестного адреса", ghost.status === 200 && /^[0-9a-f]{32}$/.test(ghost.json.nonce), ghost.text);

// замена хеша входа и выход
r = await call("POST", "/v1/account/upgrade", { token: A.s1, body: { oldLoginHash: A.pw3, newLoginHash: A.pw1, kdf: 2 } });
check("замена хеша входа", r.status === 200 && (await call("GET", "/v1/account/devices", { token: A.s1 })).status === 200, r.text);
r = await call("GET", "/v1/mail/aliases", { token: A.s1 });
check("список алиасов пуст", r.status === 200 && Array.isArray(r.json) && r.json.length === 0, r.text);
r = await call("POST", "/v1/mail/aliases", { token: A.s1, body: { site: "booking.com" } });
check("без почтового сервера алиас не создаётся", r.status === 503 && r.json.code === "mail-unavailable", r.text);
r = await call("POST", "/v1/account/logout", { token: A.s1 });
check("выход", r.status === 200 && (await call("GET", "/v1/account/devices", { token: A.s1 })).status === 401, r.text);

// ---- двухфакторная защита входа ----
const C = { email: mail("c"), pw: hash("c-pass"), pw2: hash("c-pass-2"), pw3: hash("c-pass-3"), ip: "198.51.100.50" };
r = await call("POST", "/v1/account/register", { body: { email: C.email, loginHash: C.pw, kdf: 2, deviceId: device(40), deviceName: "C" }, ip: C.ip });
C.s = r.json?.session?.token;
r = await call("GET", "/v1/account/security", { token: C.s });
check("настройки входа нового аккаунта: всё выключено", r.status === 200 && r.json.twoFactor.enabled === false && r.json.twoFactor.backupCodes === 0 && r.json.backupEmail === null && r.json.backupEmailPending === null && r.json.recoveryKey === false && r.json.mail === true, r.text);
check("настройки входа без сессии → 401", (await call("GET", "/v1/account/security")).status === 401);
r = await call("POST", "/v1/account/2fa/setup", { token: C.s, body: { loginHash: C.pw2 }, ip: C.ip });
check("настройка 2FA требует верный пароль", r.status === 401 && r.json.code === "bad-credentials", r.text);
r = await call("POST", "/v1/account/2fa/enable", { token: C.s, body: { code: "123456" }, ip: C.ip });
check("включить 2FA без начатой настройки нельзя", r.status === 400 && r.json.code === "2fa-setup-expired", r.text);
r = await call("POST", "/v1/account/2fa/setup", { token: C.s, body: { loginHash: C.pw }, ip: C.ip });
check("настройка 2FA выдаёт секрет и ссылку для приложения", r.status === 200 && /^[A-Z2-7]{32}$/.test(r.json.secret) && r.json.uri === `otpauth://totp/Tabora:${C.email.replace("@", "%40")}?secret=${r.json.secret}&issuer=Tabora&algorithm=SHA1&digits=6&period=30`, r.text);
C.secret = r.json?.secret;
check("до подтверждения кодом защита выключена", (await call("GET", "/v1/account/security", { token: C.s })).json.twoFactor.enabled === false && (await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(40) }, ip: C.ip })).status === 200);
r = await call("POST", "/v1/account/2fa/enable", { token: C.s, body: { code: otherCode(totp(C.secret)) }, ip: C.ip });
check("неверный первый код не включает защиту", r.status === 401 && r.json.code === "bad-2fa", r.text);
const firstCode = totp(C.secret);
r = await call("POST", "/v1/account/2fa/enable", { token: C.s, body: { code: ` ${firstCode.slice(0, 3)} ${firstCode.slice(3)} ` }, ip: C.ip });
check("верный код включает защиту и выдаёт десять резервных кодов", r.status === 200 && r.json.backupCodes.length === 10 && new Set(r.json.backupCodes).size === 10 && r.json.backupCodes.every(c => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c)), r.text);
C.codes = r.json?.backupCodes || [];
r = await call("GET", "/v1/account/security", { token: C.s });
check("защита включена, резервных кодов десять", r.json.twoFactor.enabled === true && r.json.twoFactor.backupCodes === 10 && /^\d{4}-/.test(r.json.twoFactor.since), r.text);
r = await call("POST", "/v1/account/2fa/setup", { token: C.s, body: { loginHash: C.pw }, ip: C.ip });
check("повторная настройка при включённой защите → 409", r.status === 409 && r.json.code === "2fa-on", r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(41), deviceName: "C2" }, ip: C.ip });
check("вход без кода → 401 «нужен код»", r.status === 401 && r.json.code === "2fa-required", r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw2, deviceId: device(41), totp: totp(C.secret, 1) }, ip: C.ip });
check("неверный пароль с верным кодом → обычный отказ, код не тратится", r.status === 401 && r.json.code === "bad-credentials", r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(41), totp: firstCode }, ip: C.ip });
check("код, которым включали защиту, второй раз не принимается", r.status === 401 && r.json.code === "bad-2fa" && /уже использован/.test(r.json.message), r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(41), totp: otherCode(totp(C.secret, 1)) }, ip: C.ip });
check("неверный код → 401", r.status === 401 && r.json.code === "bad-2fa", r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(41), deviceName: "C2", totp: totp(C.secret, 1) }, ip: C.ip });
check("вход с паролем и свежим кодом", r.status === 200 && !!r.json.session.token, r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(41), totp: C.codes[0].toUpperCase().replace("-", " ") }, ip: C.ip });
check("вход с резервным кодом (в любом написании)", r.status === 200, r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(41), totp: C.codes[0] }, ip: C.ip });
check("резервный код одноразовый", r.status === 401 && r.json.code === "bad-2fa", r.text);
check("резервных кодов осталось девять", (await call("GET", "/v1/account/security", { token: C.s })).json.twoFactor.backupCodes === 9);
r = await call("POST", "/v1/account/2fa/codes", { token: C.s, body: { loginHash: C.pw }, ip: C.ip });
check("новые резервные коды без второго фактора не выдаются", r.status === 401 && r.json.code === "2fa-required", r.text);
r = await call("POST", "/v1/account/2fa/codes", { token: C.s, body: { loginHash: C.pw, code: C.codes[1] }, ip: C.ip });
check("новые резервные коды", r.status === 200 && r.json.backupCodes.length === 10 && !r.json.backupCodes.includes(C.codes[2]), r.text);
const oldCode = C.codes[2];
C.codes = r.json?.backupCodes || [];
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw, deviceId: device(41), totp: oldCode }, ip: C.ip });
check("прежние резервные коды перестали действовать", r.status === 401 && r.json.code === "bad-2fa", r.text);

// ---- резервный адрес ----
const BOX = "anna.backup@example.org";
r = await call("POST", "/v1/account/backup-email", { token: C.s, body: { loginHash: C.pw, address: BOX }, ip: C.ip });
check("резервный адрес при включённой защите требует код", r.status === 401 && r.json.code === "2fa-required", r.text);
for (const [what, address] of [["не адрес", "anna"], ["свой адрес", C.email], ["перевод строки", "a@example.org\r\nBcc: x@example.org"], ["кириллица", "анна@example.org"]]) {
  r = await call("POST", "/v1/account/backup-email", { token: C.s, body: { loginHash: C.pw, code: C.codes[0], address }, ip: C.ip });
  check(`резервный адрес: ${what} → 400`, r.status === 400 && r.json.code === "bad-address", r.text);
}
check("отказы по адресу второй фактор не тратят: резервных кодов по-прежнему десять", (await call("GET", "/v1/account/security", { token: C.s })).json.twoFactor.backupCodes === 10);
let t0 = Date.now();
r = await call("POST", "/v1/account/backup-email", { token: C.s, body: { loginHash: C.pw, code: C.codes[0], address: " Anna.Backup@Example.ORG " }, ip: C.ip });
check("резервный адрес принят и ждёт подтверждения", r.status === 200 && r.json.pending.address === BOX && /^\d{4}-/.test(r.json.pending.expiresAt), r.text);
let letter = await lastMail(BOX, { after: t0 - 5 });
check("на адрес ушло письмо с кодом из шести цифр", !!letter && /^\d{6}$/.test(letter.code || "") && letter.subject === "Tabora: подтверждение резервного адреса" && letter.text.includes(C.email), JSON.stringify(letter));
r = await call("GET", "/v1/account/security", { token: C.s });
check("до подтверждения адрес не резервный", r.json.backupEmail === null && r.json.backupEmailPending.address === BOX, r.text);
r = await call("POST", "/v1/account/backup-email/verify", { token: C.s, body: { code: otherCode(letter.code) }, ip: C.ip });
check("неверный код подтверждения → 400", r.status === 400 && r.json.code === "bad-code", r.text);
r = await call("POST", "/v1/account/backup-email/verify", { token: C.s, body: { code: `${letter.code.slice(0, 3)} ${letter.code.slice(3)}` }, ip: C.ip });
check("код из письма подтверждает адрес", r.status === 200 && r.json.address === BOX, r.text);
r = await call("POST", "/v1/account/backup-email/verify", { token: C.s, body: { code: letter.code }, ip: C.ip });
check("код подтверждения одноразовый", r.status === 400 && r.json.code === "no-code", r.text);
r = await call("GET", "/v1/account/security", { token: C.s });
check("адрес записан как резервный", r.json.backupEmail.address === BOX && r.json.backupEmailPending === null, r.text);
r = await call("POST", "/v1/account/backup-email", { token: C.s, body: { loginHash: C.pw, code: C.codes[1], address: BOX }, ip: C.ip });
check("тот же адрес повторно → 409", r.status === 409 && r.json.code === "same-address", r.text);

// ---- сброс пароля по коду из письма ----
t0 = Date.now();
r = await call("POST", "/v1/account/reset/email", { body: { email: mail("ghost") }, ip: "198.51.100.60" });
const ghostReset = r.text;
r = await call("POST", "/v1/account/reset/email", { body: { email: B.email }, ip: "198.51.100.60" });
check("запрос сброса для неизвестного адреса и для аккаунта без резервной почты отвечает одинаково", r.status === 200 && r.text === ghostReset && r.text === "{}", r.text);
r = await call("POST", "/v1/account/reset/email", { body: { email: C.email }, ip: "198.51.100.60" });
check("запрос сброса для аккаунта с резервной почтой отвечает так же", r.status === 200 && r.text === ghostReset, r.text);
letter = await lastMail(BOX, { after: t0 - 5 });
check("на резервный адрес ушёл код сброса из восьми цифр", !!letter && /^\d{8}$/.test(letter.code || "") && letter.subject === "Tabora: сброс пароля", JSON.stringify(letter));
check("другим адресам писем о сбросе нет", mailsTo(B.email).length === 0 && mailsTo(mail("ghost")).length === 0);
r = await call("POST", "/v1/account/reset/email/confirm", { body: { email: C.email, code: letter.code.replace(/.$/, d => (Number(d) + 1) % 10), newLoginHash: C.pw2, kdf: 2 }, ip: "198.51.100.60" });
check("неверный код сброса → 400", r.status === 400 && r.json.code === "bad-code", r.text);
r = await call("POST", "/v1/account/reset/email/confirm", { body: { email: C.email, code: letter.code, newLoginHash: C.pw2, kdf: 2 }, ip: "198.51.100.60" });
check("сброс по письму не обходит двухфакторную защиту", r.status === 401 && r.json.code === "2fa-required", r.text);
check("пароль без второго фактора не сменился", (await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw2, deviceId: device(41), totp: C.codes[2] }, ip: C.ip })).status === 401);
r = await call("POST", "/v1/account/reset/email/confirm", { body: { email: C.email, code: letter.code, newLoginHash: C.pw2, kdf: 2, totp: C.codes[3], deviceId: "x" }, ip: "198.51.100.60" });
check("сброс: плохое устройство → 400, код из письма не тратится", r.status === 400 && r.json.code === "bad-request", r.text);
r = await call("POST", "/v1/account/reset/email/confirm", { body: { email: C.email, code: letter.code, newLoginHash: C.pw2, kdf: 2, totp: C.codes[3], deviceId: device(42), deviceName: "После сброса" }, ip: "198.51.100.60" });
check("сброс по коду из письма и второму фактору сразу выдаёт сессию устройству", r.status === 200 && /^tbs_/.test(r.json.session?.token || "") && r.json.userId && r.json.kdf === 2 && r.json.mail === null, r.text);
check("выданная при сбросе сессия действует, прежние завершены", (await call("GET", "/v1/account/security", { token: r.json.session.token })).status === 200 && (await call("GET", "/v1/account/security", { token: C.s })).status === 401);
r = await call("POST", "/v1/account/reset/email/confirm", { body: { email: C.email, code: letter.code, newLoginHash: C.pw3, kdf: 2, totp: C.codes[4] }, ip: "198.51.100.60" });
check("код сброса одноразовый", r.status === 400 && r.json.code === "bad-code", r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw2, deviceId: device(40), deviceName: "C", totp: C.codes[4] }, ip: C.ip });
check("вход новым паролем (код по-прежнему нужен)", r.status === 200, r.text);
C.s = r.json?.session?.token;
const notice = mailsTo(BOX).filter(m => m.subject === "Tabora: пароль аккаунта сброшен").pop();
check("о сбросе пришло уведомление", !!notice && notice.text.includes(C.email), JSON.stringify(notice));
// пять неверных кодов гасят код сброса
t0 = Date.now();
await call("POST", "/v1/account/reset/email", { body: { email: C.email }, ip: "198.51.100.61" });
letter = await lastMail(BOX, { after: t0 - 5 });
codes = [];
for (let i = 0; i < 5; i++) {
  codes.push((await call("POST", "/v1/account/reset/email/confirm", { body: { email: C.email, code: "0000000" + i, newLoginHash: C.pw3, kdf: 2, totp: C.codes[5] }, ip: "198.51.100.61" })).json.code);
}
r = await call("POST", "/v1/account/reset/email/confirm", { body: { email: C.email, code: letter.code, newLoginHash: C.pw3, kdf: 2, totp: C.codes[5] }, ip: "198.51.100.61" });
check("после пяти неверных попыток верный код сброса уже не действует", codes.every(c => c === "bad-code") && r.status === 400 && r.json.code === "bad-code", r.text);
t0 = Date.now();
await call("POST", "/v1/account/reset/email", { body: { email: C.email }, ip: "198.51.100.62" });
const third = await lastMail(BOX, { after: t0 - 5 });
const resetMails = () => mailsTo(BOX).filter(m => m.subject === "Tabora: сброс пароля").length;
const before = resetMails();
r = await call("POST", "/v1/account/reset/email", { body: { email: C.email }, ip: "198.51.100.63" });
await new Promise(done => setTimeout(done, 700));
check("на аккаунт не больше трёх писем сброса в сутки (четвёртый запрос отвечает так же, письма нет)", !!third && before === 3 && resetMails() === 3 && r.status === 200 && r.text === "{}", `${before} → ${resetMails()}`);

// ---- ключ восстановления снимает двухфакторную защиту; выключение и удаление адреса ----
const ckey = recoveryKey();
await call("POST", "/v1/account/recovery", { token: C.s, body: { recoveryVerifier: ckey.verifier } });
ch = await call("POST", "/v1/account/reset/challenge", { body: { email: C.email }, ip: "198.51.100.70" });
r = await call("POST", "/v1/account/reset", { body: { email: C.email, nonce: ch.json.nonce, recoveryProof: ckey.sign(`tabora-reset-v2|${C.email}|${C.pw3}|${ch.json.nonce}`), newLoginHash: C.pw3, kdf: 2 }, ip: "198.51.100.70" });
check("сброс ключом восстановления выключает двухфакторную защиту", r.status === 200 && r.json.twoFactorDisabled === true, r.text);
r = await call("POST", "/v1/account/login", { body: { email: C.email, loginHash: C.pw3, deviceId: device(40), deviceName: "C" }, ip: C.ip });
check("после него вход только по паролю", r.status === 200, r.text);
C.s = r.json?.session?.token;
r = await call("GET", "/v1/account/security", { token: C.s });
check("защита выключена, резервный адрес остался, ключ восстановления отмечен", r.json.twoFactor.enabled === false && r.json.twoFactor.backupCodes === 0 && r.json.backupEmail.address === BOX && r.json.recoveryKey === true, r.text);
r = await call("POST", "/v1/account/backup-email/remove", { token: C.s, body: { loginHash: C.pw }, ip: C.ip });
check("удаление резервного адреса требует верный пароль", r.status === 401 && r.json.code === "bad-credentials", r.text);
r = await call("POST", "/v1/account/backup-email/remove", { token: C.s, body: { loginHash: C.pw3 }, ip: C.ip });
check("резервный адрес удалён", r.status === 200 && (await call("GET", "/v1/account/security", { token: C.s })).json.backupEmail === null, r.text);
check("об удалении пришло уведомление на прежний адрес", mailsTo(BOX).some(m => m.subject === "Tabora: резервный адрес удалён"));

// пауза после неверных кодов (отдельный аккаунт: она длится четверть часа)
const D = { email: mail("d"), pw: hash("d-pass"), ip: "198.51.100.51" };
r = await call("POST", "/v1/account/register", { body: { email: D.email, loginHash: D.pw, kdf: 2, deviceId: device(50), deviceName: "D" }, ip: D.ip });
D.s = r.json?.session?.token;
r = await call("POST", "/v1/account/2fa/setup", { token: D.s, body: { loginHash: D.pw }, ip: D.ip });
D.secret = r.json?.secret;
r = await call("POST", "/v1/account/2fa/enable", { token: D.s, body: { code: totp(D.secret) }, ip: D.ip });
D.codes = r.json?.backupCodes || [];
codes = [];
for (let i = 0; i < 6; i++) {
  codes.push((await call("POST", "/v1/account/login", { body: { email: D.email, loginHash: D.pw, deviceId: device(50), totp: "aaaa-aaa" + "23456789"[i] }, ip: `203.0.113.${40 + i}` })).status);
}
check("пять неверных кодов подряд (с разных адресов), шестая попытка заблокирована", codes.join() === "401,401,401,401,401,429", codes.join());
r = await call("POST", "/v1/account/login", { body: { email: D.email, loginHash: D.pw, deviceId: device(50), totp: D.codes[0] }, ip: "203.0.113.90" });
check("во время паузы не проходит и верный резервный код", r.status === 429 && r.json.code === "rate-limited" && /неверных кодов/.test(r.json.message), r.text);
r = await call("POST", "/v1/account/2fa/disable", { token: D.s, body: { loginHash: D.pw, code: D.codes[0] }, ip: D.ip });
check("выключить защиту во время паузы тоже нельзя", r.status === 429, r.text);

// пределы регистрации с одного адреса и прочее
codes = [];
for (let i = 0; i < 7; i++) {
  codes.push((await call("POST", "/v1/account/register", { body: { email: mail("s" + i), loginHash: hash("s" + i), kdf: 2, deviceId: device(20 + i), deviceName: "s" }, ip: "192.0.2.77" })).status);
}
check("с одного адреса не больше шести аккаунтов в сутки", codes.join() === "200,200,200,200,200,200,429", codes.join());
r = await call("GET", "/v1/nope");
check("неизвестный адрес → 404 в общем формате", r.status === 404 && r.json?.code === "not-found", r.text);

console.log(`ИТОГ: ${passed} из ${passed + failed}`);
process.exit(failed ? 1 : 0);
