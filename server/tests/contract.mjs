// Проверка HTTP-контракта tabora-server на запущенном экземпляре без почты:
//   node tests/contract.mjs http://127.0.0.1:7711
// Сервер должен быть запущен с пустой базой и TABORA_SIGNUP_PER_IP=6 (тест проверяет и этот предел).
import crypto from "node:crypto";

const BASE = (process.argv[2] || "http://127.0.0.1:7711").replace(/\/+$/, "");
const DOMAIN = process.argv[3] || "tabora.app";
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
