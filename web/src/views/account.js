/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Настройки аккаунта: пароль, двухфакторная защита, резервный адрес, ключ восстановления,
 * устройства. Перемены в защите требуют пароль заново (на сервер уходит только хеш входа). */

import { passwordStrength } from "../core/password.js";
import { formatFingerprint } from "../core/pgp.js";
import { clear, h, icon } from "../lib/dom.js";
import { busy, confirmDialog, copyText, errorText, field, formError, longDate, modal, shortDate, toast } from "../lib/ui.js";
import { split, unlockKeysDialog } from "./common.js";

function strength(input) {
  const label = h("span", {}, "");
  const el = h("div", { class: "strength", "data-score": "0" }, h("span", { class: "strength-bars" }, h("i"), h("i"), h("i"), h("i")), label);
  input.addEventListener("input", () => {
    const s = passwordStrength(input.value);
    el.dataset.score = input.value ? String(Math.max(1, s.score)) : "0";
    label.textContent = input.value ? s.label : "";
  });
  return el;
}

async function qrCanvas(text, size = 208) {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const scale = Math.max(2, Math.floor((size * 2) / (n + quiet * 2)));
  const canvas = h("canvas", { class: "qr", width: (n + quiet * 2) * scale, height: (n + quiet * 2) * scale, role: "img", "aria-label": "QR-код для приложения кодов" });
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#0b0c0e";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }
  return canvas;
}

function codesBlock(codes) {
  return h("div", { class: "backup-codes" }, codes.map(c => h("span", { class: "mono" }, c)));
}

export function mountAccount(el, ctx) {
  const { account, api, sync } = ctx;
  const s = split({ single: true });
  const body = h("div", { class: "settings" });
  clear(s.list, h("header", { class: "pane-head" }, h("h1", {}, "Аккаунт")), h("div", { class: "list settings-list" }, body));
  s.list.classList.add("narrow-pane");
  clear(el, s.el);
  let security = null;
  let devices = null;
  let loadError = "";
  let alive = true;

  async function load() {
    try {
      [security, devices] = await Promise.all([api.security(account.token), api.devices(account.token)]);
      loadError = "";
    } catch (e) {
      loadError = errorText(e);
    }
    if (alive) {
      draw();
    }
  }

  /** Окно, которое просит пароль (и код, если защита включена) и выполняет действие с хешем входа. */
  function reauth({ title, text, confirm, danger = false, extra = [], needCode = security?.twoFactor?.enabled, run, done }) {
    const pass = field("Пароль аккаунта", { type: "password", autocomplete: "current-password", autofocus: true });
    const code = needCode ? field("Код из приложения", { mono: true, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "000 000", hint: "Или резервный код." }) : null;
    const error = formError();
    const submit = h("button", { class: `btn ${danger ? "danger" : "primary"}` }, confirm);
    const m = modal({ title, content: [text && h("p", { class: "modal-text" }, text), h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, extra.map(f => f.el), pass.el, code?.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      if (!pass.value) {
        error.set("Введите пароль");
        return;
      }
      try {
        const result = await busy(submit, async step => {
          account.onStep = step;
          const loginHash = await account.loginHashFor(pass.value);
          step("Сохраняем");
          return run({ loginHash, code: code?.value.replace(/\s+/g, "") || undefined, password: pass.value });
        }, "Проверяем пароль");
        m.close();
        await done?.(result);
        load();
      } catch (e) {
        error.set(e.code === "bad-credentials" ? "Пароль введён неверно" : e.code === "bad-2fa" ? "Код не подошёл" : errorText(e));
      } finally {
        account.onStep = null;
      }
    });
  }

  /* ---- пароль ---- */

  function changePassword() {
    const old = field("Нынешний пароль", { type: "password", autocomplete: "current-password", autofocus: true });
    const next = field("Новый пароль", { type: "password", autocomplete: "new-password" });
    next.el.append(strength(next.input));
    const error = formError();
    const submit = h("button", { class: "btn primary" }, "Сменить пароль");
    const m = modal({ title: "Смена пароля", content: [h("p", { class: "modal-text" }, "Остальные устройства выйдут из аккаунта: на них нужно будет войти с новым паролем."), h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, old.el, next.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      try {
        await busy(submit, async step => {
          account.onStep = step;
          await account.changePassword(old.value, next.value);
        }, "Проверяем пароль");
        m.close();
        toast("Пароль изменён");
        load();
      } catch (e) {
        error.set(e.code === "bad-credentials" ? "Нынешний пароль введён неверно" : errorText(e));
      } finally {
        account.onStep = null;
      }
    });
  }

  /* ---- двухфакторная защита ---- */

  function enableTwoFactor() {
    reauth({
      title: "Включить двухфакторную защиту",
      text: "При входе, кроме пароля, понадобится код из приложения на телефоне. Подойдёт любое приложение для кодов — или раздел «Коды» в Tabora на другом устройстве.",
      confirm: "Продолжить",
      needCode: false,
      run: ({ loginHash }) => api.twoFactorSetup(account.token, loginHash),
      done: async setup => {
        const code = field("Код из приложения", { mono: true, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "000 000", autofocus: true });
        const error = formError();
        const submit = h("button", { class: "btn primary" }, "Включить");
        const qr = h("div", { class: "qr-box" });
        qrCanvas(setup.uri).then(c => clear(qr, c)).catch(() => {});
        const m = modal({ title: "Добавьте аккаунт в приложение кодов", content: [
          h("p", { class: "modal-text" }, "Отсканируйте QR-код приложением или введите ключ вручную, затем впишите код, который оно покажет."),
          qr,
          h("div", { class: "card" }, h("div", { class: "kv" }, h("div", { class: "kv-text" }, h("small", {}, "Ключ для ручного ввода"), h("span", { class: "mono wrap" }, setup.secret.replace(/(.{4})/g, "$1 ").trim())), h("div", { class: "kv-actions" }, h("button", { class: "icon-btn", "aria-label": "Скопировать ключ", onclick: () => copyText(setup.secret, "Ключ скопирован") }, icon("copy", 18))))),
          h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, code.el, error.el),
        ], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
        submit.addEventListener("click", async () => {
          error.set("");
          try {
            const r = await busy(submit, () => api.twoFactorEnable(account.token, code.value.replace(/\s+/g, "")), "Проверяем");
            m.close();
            showBackupCodes(r.backupCodes, "Двухфакторная защита включена");
            load();
          } catch (e) {
            error.set(e.code === "bad-2fa" ? "Код не подошёл. Проверьте время на телефоне и введите новый код" : errorText(e));
          }
        });
      },
    });
  }

  function showBackupCodes(codes, title) {
    const m = modal({ title, dismiss: false, content: [
      h("p", { class: "modal-text" }, "Это резервные коды: каждый подходит один раз вместо кода из приложения, если телефона нет под рукой. Сохраните их — больше мы их не покажем."),
      codesBlock(codes),
    ], actions: [h("button", { class: "btn", onclick: () => copyText(codes.join("\n"), "Коды скопированы") }, icon("copy", 16), "Скопировать"), h("button", { class: "btn primary", onclick: () => m.close() }, "Я сохранил коды")] });
  }

  /* ---- резервный адрес ---- */

  function setBackupEmail() {
    const address = field("Резервный адрес", { type: "email", inputmode: "email", placeholder: "вы@example.com", autocomplete: "email", autofocus: true, hint: "Другой ваш ящик, не @tabora.app. На него придёт код, если вы забудете пароль." });
    reauth({
      title: "Резервный адрес",
      confirm: "Отправить код",
      extra: [address],
      run: ({ loginHash, code }) => api.backupEmailSet(account.token, { loginHash, code, address: address.value.trim() }),
      done: () => verifyBackupEmail(address.value.trim()),
    });
  }

  function verifyBackupEmail(address) {
    const code = field("Код из письма", { mono: true, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "000 000", autofocus: true });
    const error = formError();
    const submit = h("button", { class: "btn primary" }, "Подтвердить");
    const m = modal({ title: "Подтвердите адрес", content: [h("p", { class: "modal-text" }, `Мы отправили код на ${address}. Письмо может идти пару минут; проверьте папку «Спам».`), h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, code.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Позже"), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      try {
        await busy(submit, () => api.backupEmailVerify(account.token, code.value.replace(/\s+/g, "")), "Проверяем");
        m.close();
        toast("Резервный адрес подтверждён");
        load();
      } catch (e) {
        error.set(e.code === "bad-code" || e.code === "no-code" ? "Код не подошёл или устарел" : errorText(e));
      }
    });
  }

  /* ---- ключ восстановления ---- */

  async function newRecoveryKey() {
    if (security?.recoveryKey && !(await confirmDialog({ title: "Создать новый ключ восстановления?", text: "Прежний ключ перестанет действовать. Новый нужно будет сохранить заново.", confirm: "Создать" }))) {
      return;
    }
    try {
      const key = await account.newRecoveryKey();
      const saved = h("input", { type: "checkbox" });
      const done = h("button", { class: "btn primary", disabled: true, onclick: () => m.close() }, "Готово");
      saved.addEventListener("change", () => (done.disabled = !saved.checked));
      const m = modal({ title: "Ключ восстановления", dismiss: false, content: [
        h("p", { class: "modal-text" }, "Если вы забудете пароль, только этот ключ вернёт аккаунт, пароли и письма. Мы его не храним и показываем один раз."),
        h("div", { class: "recovery-key" }, key.split("-").map(g => h("span", {}, g))),
        h("label", { class: "check" }, saved, h("span", {}, "Я сохранил ключ в надёжном месте")),
      ], actions: [h("button", { class: "btn", onclick: () => copyText(key, "Ключ скопирован") }, icon("copy", 16), "Скопировать"), done] });
      load();
    } catch (e) {
      toast(errorText(e), { tone: "bad", ms: 5000 });
    }
  }

  /* ---- рисование ---- */

  const row = (label, value, actions = [], opts = {}) => h("div", { class: `kv${opts.tall ? " tall" : ""}` }, h("div", { class: "kv-text" }, h("small", {}, label), typeof value === "string" ? h("span", { class: opts.wrap ? "wrap" : "" }, value) : value), h("div", { class: "kv-actions buttons" }, actions));
  const card = (title, ...rows) => h("section", { class: "card" }, h("h2", { class: "card-title" }, title), rows);

  function draw() {
    const k = account.keys;
    const two = security?.twoFactor;
    const keyNote = k.state === "ok" ? "Открыт на этом устройстве" : k.state === "offline" ? "Нет связи с сервером" : "Закрыт: копия привязана к прежнему паролю";
    clear(body,
      loadError ? h("div", { class: "note bad" }, icon("warning", 17), h("div", {}, h("span", {}, loadError), h("button", { class: "link-btn", onclick: load }, "Повторить"))) : null,
      card("Профиль",
        row("Адрес", account.email, [h("button", { class: "icon-btn", "aria-label": "Скопировать адрес", onclick: () => copyText(account.email, "Адрес скопирован") }, icon("copy", 18))]),
        row("Вход на этом устройстве", account.session.remember ? "Сохранён до выхода" : "До закрытия вкладки", [h("button", { class: "btn small", onclick: () => account.signOut() }, "Выйти")])),
      card("Защита входа",
        row("Пароль", "Знаете только вы; на сервере его нет", [h("button", { class: "btn small", onclick: changePassword }, "Сменить")], { wrap: true }),
        row("Двухфакторная защита", !security ? "…" : two.enabled ? `Включена${two.since ? ` с ${shortDate(two.since)}` : ""}, резервных кодов: ${two.backupCodes}` : "Выключена: для входа достаточно пароля", !security ? [] : two.enabled ? [
          h("button", { class: "btn small", onclick: () => reauth({ title: "Новые резервные коды", text: "Прежние резервные коды перестанут действовать.", confirm: "Создать", run: ({ loginHash, code }) => api.twoFactorCodes(account.token, loginHash, code), done: r => showBackupCodes(r.backupCodes, "Новые резервные коды") }) }, "Коды"),
          h("button", { class: "btn small", onclick: () => reauth({ title: "Выключить двухфакторную защиту", text: "Для входа снова будет достаточно одного пароля.", confirm: "Выключить", danger: true, run: ({ loginHash, code }) => api.twoFactorDisable(account.token, loginHash, code), done: () => toast("Двухфакторная защита выключена") }) }, "Выключить"),
        ] : [h("button", { class: "btn small primary", onclick: enableTwoFactor }, "Включить")], { wrap: true }),
        row("Резервный адрес", !security ? "…" : security.backupEmail ? security.backupEmail.address : security.backupEmailPending ? `${security.backupEmailPending.address} — ждёт подтверждения` : "Не задан: забытый пароль можно сбросить только ключом восстановления", !security ? [] : [
          security.backupEmailPending && !security.backupEmail ? h("button", { class: "btn small primary", onclick: () => verifyBackupEmail(security.backupEmailPending.address) }, "Ввести код") : null,
          h("button", { class: "btn small", onclick: setBackupEmail }, security.backupEmail ? "Сменить" : "Указать"),
          security.backupEmail ? h("button", { class: "btn small", onclick: () => reauth({ title: "Убрать резервный адрес", text: "Сбросить забытый пароль по письму будет нельзя.", confirm: "Убрать", danger: true, run: ({ loginHash, code }) => api.backupEmailRemove(account.token, { loginHash, code }), done: () => toast("Резервный адрес убран") }) }, "Убрать") : null,
        ], { wrap: true }),
        row("Ключ восстановления", !security ? "…" : security.recoveryKey ? "Создан. Возвращает аккаунт и данные, если пароль забыт" : "Не создан: без него забытый пароль не вернуть", [h("button", { class: "btn small", disabled: k.state !== "ok", onclick: newRecoveryKey }, security?.recoveryKey ? "Новый" : "Создать")], { wrap: true })),
      card("Ключ аккаунта",
        row("Состояние", keyNote, k.state === "locked" && (k.canRecovery || k.reason === "wrong-wrap") ? [h("button", { class: "btn small primary", onclick: () => unlockKeysDialog(ctx) }, "Открыть")] : [], { wrap: true }),
        k.fingerprint ? row("Отпечаток ключа почты", h("span", { class: "mono wrap small-text" }, formatFingerprint(k.fingerprint)), [h("button", { class: "icon-btn", "aria-label": "Скопировать отпечаток", onclick: () => copyText(formatFingerprint(k.fingerprint), "Отпечаток скопирован") }, icon("copy", 18))], { tall: true }) : null,
        row("Данные с других устройств", sync.loaded ? `Пароли: ${sync.list("logins").length}, коды: ${sync.list("otp").length}, закладки: ${sync.list("marks").filter(m => m.data.k === 1).length}` : k.state === "ok" ? "Загружаются…" : "Недоступны, пока ключ закрыт", [], { wrap: true })),
      card("Устройства",
        devices ? devices.filter(d => d.current || d.active !== false).sort((a, b) => Number(b.current) - Number(a.current) || (b.at || 0) - (a.at || 0)).map(d => row(d.current ? "Это устройство" : `Был в сети ${shortDate(d.at)}`, d.name || "Устройство", d.current ? [] : [h("button", { class: "btn small", onclick: () => revoke(d) }, "Завершить")], { wrap: true })) : row("", "…")),
      h("p", { class: "settings-foot" }, `Веб-версия Tabora${typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? ` ${__APP_VERSION__}` : ""} · `, h("a", { href: "https://tabora.app/", target: "_blank", rel: "noopener" }, "tabora.app"), " · ", h("a", { href: "https://github.com/Tabora-App/browser", target: "_blank", rel: "noopener noreferrer" }, "исходный код")));
  }

  function revoke(d) {
    reauth({
      title: "Завершить сеанс устройства",
      text: `«${d.name}» выйдет из аккаунта и потеряет доступ к почте. Данные, уже сохранённые на нём, останутся там.`,
      confirm: "Завершить",
      danger: true,
      needCode: false,
      run: ({ loginHash }) => api.deviceRevoke(account.token, d.id, loginHash),
      done: () => toast("Сеанс завершён"),
    });
  }

  const off1 = account.subscribe(what => what === "keys" && draw());
  const off2 = sync.subscribe(() => draw());
  draw();
  load();
  return {
    route() {},
    destroy() {
      alive = false;
      off1();
      off2();
    },
  };
}
