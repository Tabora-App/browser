// Вход на новом устройстве по QR-коду на местном сервере: первое устройство показывает код,
// второе входит по нему без пароля и получает ключ данных аккаунта; отказ, повторное считывание,
// чужой секрет, подменённый ответ, отказ на втором устройстве, чужой аккаунт.
//   TABORA_API=http://127.0.0.1:7711 node test/run.mjs pair
import "./setup.mjs";
import { Account } from "../../../web/src/core/account.js";
import { Api } from "../../../web/src/core/api.js";
import { b64 } from "../../../web/src/core/bytes.js";
import { pairClaim, pairKeys, pairParse, pairSeal, pairSecrets } from "../../../web/src/core/pair.js";
import { MemoryStore } from "../../../web/src/core/store.js";
import { check, rejects, summary } from "./lib.mjs";

const API = process.env.TABORA_API || "http://127.0.0.1:7711";
const name = `qr${Date.now().toString(36)}`;
const PASSWORD = "Pair-Check-pass-17!";
const device = label => new Account({ api: new Api(API), store: new MemoryStore(), deviceName: () => label });

const desk = device("Компьютер проверки");
await desk.register(name, PASSWORD);
desk.release?.();
check("первое устройство вошло, ключ данных открыт", [desk.signedIn, desk.keys.state], [true, "ok"]);

/* ---- обычный вход ---- */

const phone = device("Телефон проверки");
const offer = await desk.pairOffer();
check("QR-код — ссылка входа Tabora с номером обмена и ключом", [!!pairParse(offer.link), offer.link.length < 120, offer.expiresAt > Date.now()], [true, true, true]);
check("не код Tabora отклоняется до сервера", await rejects(() => phone.pairJoin("https://example.org/pair?i=1")), "pair-invalid");

const waitJoined = offer.joined();
const join = await phone.pairJoin(offer.link);
const seen = await waitJoined;
check("первое устройство видит имя нового и тот же код сверки", [seen.deviceName, seen.code === join.code, /^\d{6}$/.test(join.code)], ["Телефон проверки", true, true]);
check("тот же код второй раз считать нельзя", await rejects(() => device("Чужой").pairJoin(offer.link)), "pair-gone");

const waiting = join.wait();
await seen.approve();
const granted = await waiting;
check("новому устройству показан адрес аккаунта до входа", [granted.email, phone.signedIn], [`${name}@tabora.app`, false]);
await granted.enter();
check("вход без пароля: сессия есть, ключ данных тот же", [phone.signedIn, phone.email, phone.keys.state, b64(phone.keys.dataKey) === b64(desk.keys.dataKey)], [true, `${name}@tabora.app`, "ok", true]);
const devices = await desk.api.devices(desk.token);
check("новое устройство появилось в списке устройств аккаунта", (devices.devices || devices).some(d => d.name === "Телефон проверки"), true);
check("использованный обмен закрыт", await rejects(() => desk.api.pairStatus(desk.token, pairParse(offer.link).id)), "pair-gone");

// сохранённый вход переживает перезапуск: ключ данных хранится вместе с сессией
const again = new Account({ api: new Api(API), store: phone.store, deviceName: () => "Телефон проверки" });
await again.restore();
await again.refreshKeys();
check("после перезапуска устройство остаётся в аккаунте с открытыми ключами", [again.signedIn, again.keys.state], [true, "ok"]);

/* ---- отказ на первом устройстве ---- */

const offer2 = await desk.pairOffer();
const waitJoined2 = offer2.joined();
const stranger = device("Незнакомый телефон");
const join2 = await stranger.pairJoin(offer2.link);
const seen2 = await waitJoined2;
const waiting2 = join2.wait();
waiting2.catch(() => {});
await seen2.deny();
check("отклонённый вход: новое устройство получает отказ и не входит", [await rejects(() => waiting2), stranger.signedIn], ["pair-denied", false]);

/* ---- отказ на новом устройстве после разрешения ---- */

const offer3 = await desk.pairOffer();
const waitJoined3 = offer3.joined();
const wary = device("Осторожный телефон");
const join3 = await wary.pairJoin(offer3.link);
const seen3 = await waitJoined3;
const waiting3 = join3.wait();
await seen3.approve();
const granted3 = await waiting3;
const before = (await desk.api.devices(desk.token));
await granted3.decline();
check("человек отказался на новом устройстве: вход не выполнен", wary.signedIn, false);
const list3 = (before.devices || before).map(d => d.name);
check("устройство было записано сервером при выдаче сессии", list3.includes("Осторожный телефон"), true);

/* ---- сервер в роли обманщика ---- */

// чужой секрет: результат забрать нельзя
const offer4 = await desk.pairOffer();
const id4 = pairParse(offer4.link).id;
const waitJoined4 = offer4.joined();
const honest = device("Честный телефон");
const join4 = await honest.pairJoin(offer4.link);
const seen4 = await waitJoined4;
const other = await pairClaim();
check("без секрета присоединившегося устройства результат не отдаётся", await rejects(() => honest.api.pairPoll({ id: id4, secret: other.secret })), "pair-gone");
// ответ зашифрован не тем ключом (подмена в пути): новое устройство не входит и завершает сессию
const evil = await pairKeys();
const fake = await pairSecrets(evil.privateKey, pairParse(offer4.link).public, { id: id4, starter: pairParse(offer4.link).public, joiner: evil.public });
check("коды сверки при подмене ключа расходятся", fake.code === join4.code, false);
const waiting4 = join4.wait();
waiting4.catch(() => {});
await desk.api.pairApprove(desk.token, id4, await pairSeal(fake.key, id4, { dataKey: b64(new Uint8Array(32)) }));
check("подменённый ответ: входа нет", [await rejects(() => waiting4), honest.signedIn], ["pair-broken", false]);
void seen4;

/* ---- чужой аккаунт и пределы ---- */

const other2 = device("Другой аккаунт");
await other2.register(`${name}x`, PASSWORD);
other2.release?.();
const offer5 = await desk.pairOffer();
const id5 = pairParse(offer5.link).id;
check("чужой аккаунт не видит и не может разрешить чужой обмен", [await rejects(() => other2.api.pairStatus(other2.token, id5)), await rejects(() => other2.api.pairApprove(other2.token, id5, "QUJD")), await rejects(() => other2.api.pairDeny(other2.token, id5))], ["pair-gone", "pair-gone", "pair-gone"]);
check("без входа обмен не начать", await rejects(() => desk.api.pairStart("tbs_nope")), "session-expired");
check("разрешить можно только после того, как код считали", await rejects(() => desk.api.pairApprove(desk.token, id5, "QUJD")), "pair-gone");
check("кривые запросы отклоняются", [await rejects(() => desk.api.pairJoin({ id: "zz", public: "k", claim: "c", deviceId: "d", deviceName: "n" })), await rejects(() => desk.api.pairPoll({ id: id5, secret: "short" }))], ["bad-request", "pair-invalid"]);
// новые коды вытесняют старые: больше трёх ожидающих обменов у аккаунта не бывает
const many = [];
for (let i = 0; i < 4; i++) {
  many.push(pairParse((await desk.pairOffer()).link).id);
}
check("четвёртый код отменяет самый старый", [await rejects(() => desk.api.pairStatus(desk.token, id5)), (await desk.api.pairStatus(desk.token, many[3])).state], ["pair-gone", "new"]);

await again.signOut();
await desk.signOut();
await other2.signOut();
summary();
