/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Настройки аккаунта: пароль, двухфакторная защита, резервный адрес, ключ восстановления, ключ
 * шифрования почты, устройства. Перемены в защите требуют пароль заново (на сервер уходит только
 * хеш входа). */

import { passwordStrength } from "../core/password.js";
import { formatFingerprint } from "../core/pgp.js";
import { clear, h, icon } from "../lib/dom.js";
import { busy, confirmDialog, copyText, errorText, field, formError, languagePicker, modal, shortDate, toast } from "../lib/ui.js";
import { t, tr } from "../core/i18n.js";

function strength(input) {
  const label = h("span", {}, "");
  const el = h("div", { class: "strength", "data-score": "0" }, h("span", { class: "strength-bars" }, h("i"), h("i"), h("i"), h("i")), label);
  input.addEventListener("input", () => {
    const s = passwordStrength(input.value);
    el.dataset.score = input.value ? String(Math.max(1, s.score)) : "0";
    label.textContent = input.value ? tr(s.label) : "";
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
  const canvas = h("canvas", { class: "qr", width: (n + quiet * 2) * scale, height: (n + quiet * 2) * scale, role: "img", "aria-label": t`QR-код для приложения кодов` });
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

/** Окно: вернуть доступ к ключам аккаунта ключом восстановления или прежним паролем. */
export function unlockKeysDialog(ctx) {
  const { account } = ctx;
  const canRecovery = account.keys.canRecovery;
  const canOld = account.keys.reason === "wrong-wrap";
  let mode = canRecovery ? "recovery" : "old";
  const recovery = field(t`Ключ восстановления`, { mono: true, placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", autofocus: true });
  const old = field(t`Прежний пароль`, { type: "password", autocomplete: "off", hint: t`Тот, что был до сброса по письму.` });
  const pass = field(t`Нынешний пароль`, { type: "password", autocomplete: "current-password", hint: t`Чтобы в следующий раз всё открылось одним паролем.` });
  const error = formError();
  const tabs = h("div", { class: "chips" });
  const body = h("div", { class: "modal-form" });
  const draw = () => {
    clear(tabs, canRecovery && canOld ? [
      h("button", { class: "chip", "aria-pressed": String(mode === "recovery"), onclick: () => { mode = "recovery"; draw(); } }, t`Ключ восстановления`),
      h("button", { class: "chip", "aria-pressed": String(mode === "old"), onclick: () => { mode = "old"; draw(); } }, t`Прежний пароль`),
    ] : []);
    clear(body, mode === "recovery" ? recovery.el : old.el, pass.el, error.el);
  };
  draw();
  const submit = h("button", { class: "btn primary" }, t`Открыть@@ключи`);
  const m = modal({ title: t`Открыть ключ шифрования`, content: [h("p", { class: "modal-text" }, t`Зашифрованные письма открываются ключом аккаунта. Его копия на сервере привязана к прежнему паролю.`), tabs, body], actions: [h("button", { class: "btn", onclick: () => m.close() }, t`Отмена`), submit] });
  submit.addEventListener("click", async () => {
    error.set("");
    if (!pass.value) {
      error.set(t`Введите нынешний пароль`);
      return;
    }
    try {
      await busy(submit, async step => {
        account.onStep = step;
        if (mode === "recovery") {
          await account.unlockWithRecovery(recovery.value, pass.value);
        } else {
          await account.unlockWithOldPassword(old.value, pass.value);
        }
      }, t`Открываем`);
      m.close();
      toast(t`Ключ шифрования открыт`);
    } catch (e) {
      error.set(e.code === "wrong-wrap" ? (mode === "recovery" ? t`Этот ключ восстановления не подходит` : t`Прежний пароль не подходит`) : e.code === "bad-credentials" ? t`Нынешний пароль введён неверно` : errorText(e));
    } finally {
      account.onStep = null;
    }
  });
}

function codesBlock(codes) {
  return h("div", { class: "backup-codes" }, codes.map(c => h("span", { class: "mono" }, c)));
}

export function mountAccount(el, ctx) {
  const { account, api } = ctx;
  const body = h("div", { class: "settings" });
  clear(el, h("div", { class: "account-page" },
    h("header", { class: "pane-head" }, h("a", { class: "icon-btn", href: "#/mail", "aria-label": t`К почте`, title: t`К почте` }, icon("back", 20)), h("h1", {}, t`Аккаунт`)),
    h("div", { class: "list settings-list" }, body)));
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
  function reauth({ title, text, confirm, danger = false, extra = [], after = [], needCode = security?.twoFactor?.enabled, run, done }) {
    const pass = field(t`Пароль аккаунта`, { type: "password", autocomplete: "current-password", autofocus: true });
    const code = needCode ? field(t`Код из приложения`, { mono: true, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "000 000", hint: t`Или резервный код.` }) : null;
    const error = formError();
    const submit = h("button", { class: `btn ${danger ? "danger" : "primary"}` }, confirm);
    const m = modal({ title, content: [text && h("p", { class: "modal-text" }, text), h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, extra.map(f => f.el), pass.el, code?.el, after.map(f => f.el), error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, t`Отмена`), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      if (!pass.value) {
        error.set(t`Введите пароль`);
        return;
      }
      try {
        const result = await busy(submit, async step => {
          account.onStep = step;
          const loginHash = await account.loginHashFor(pass.value);
          step(t`Сохраняем`);
          return run({ loginHash, code: code?.value.replace(/\s+/g, "") || undefined, password: pass.value });
        }, t`Проверяем пароль`);
        m.close();
        await done?.(result);
        load();
      } catch (e) {
        error.set(e.code === "bad-credentials" ? t`Пароль введён неверно` : e.code === "bad-2fa" ? t`Код не подошёл` : errorText(e));
      } finally {
        account.onStep = null;
      }
    });
  }

  /* ---- пароль ---- */

  function changePassword() {
    const old = field(t`Нынешний пароль`, { type: "password", autocomplete: "current-password", autofocus: true });
    const next = field(t`Новый пароль`, { type: "password", autocomplete: "new-password" });
    next.el.append(strength(next.input));
    const error = formError();
    const submit = h("button", { class: "btn primary" }, t`Сменить пароль`);
    const m = modal({ title: t`Смена пароля`, content: [h("p", { class: "modal-text" }, t`Остальные устройства выйдут из аккаунта: на них нужно будет войти с новым паролем.`), h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, old.el, next.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, t`Отмена`), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      try {
        await busy(submit, async step => {
          account.onStep = step;
          await account.changePassword(old.value, next.value);
        }, t`Проверяем пароль`);
        m.close();
        toast(t`Пароль изменён`);
        load();
      } catch (e) {
        error.set(e.code === "bad-credentials" ? t`Нынешний пароль введён неверно` : errorText(e));
      } finally {
        account.onStep = null;
      }
    });
  }

  /* ---- двухфакторная защита ---- */

  function enableTwoFactor() {
    reauth({
      title: t`Включить двухфакторную защиту`,
      text: t`При входе, кроме пароля, понадобится код из приложения на телефоне. Подойдёт любое приложение для кодов — или раздел «Коды» в Tabora на другом устройстве.`,
      confirm: t`Продолжить`,
      needCode: false,
      run: ({ loginHash }) => api.twoFactorSetup(account.token, loginHash),
      done: async setup => {
        const code = field(t`Код из приложения`, { mono: true, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "000 000", autofocus: true });
        const error = formError();
        const submit = h("button", { class: "btn primary" }, t`Включить`);
        const qr = h("div", { class: "qr-box" });
        qrCanvas(setup.uri).then(c => clear(qr, c)).catch(() => {});
        const m = modal({ title: t`Добавьте аккаунт в приложение кодов`, content: [
          h("p", { class: "modal-text" }, t`Отсканируйте QR-код приложением или введите ключ вручную, затем впишите код, который оно покажет.`),
          qr,
          h("div", { class: "card" }, h("div", { class: "kv" }, h("div", { class: "kv-text" }, h("small", {}, t`Ключ для ручного ввода`), h("span", { class: "mono wrap" }, setup.secret.replace(/(.{4})/g, "$1 ").trim())), h("div", { class: "kv-actions" }, h("button", { class: "icon-btn", "aria-label": t`Скопировать ключ`, onclick: () => copyText(setup.secret, t`Ключ скопирован`) }, icon("copy", 18))))),
          h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, code.el, error.el),
        ], actions: [h("button", { class: "btn", onclick: () => m.close() }, t`Отмена`), submit] });
        submit.addEventListener("click", async () => {
          error.set("");
          try {
            const r = await busy(submit, () => api.twoFactorEnable(account.token, code.value.replace(/\s+/g, "")), t`Проверяем`);
            m.close();
            showBackupCodes(r.backupCodes, t`Двухфакторная защита включена`);
            load();
          } catch (e) {
            error.set(e.code === "bad-2fa" ? t`Код не подошёл. Проверьте время на телефоне и введите новый код` : errorText(e));
          }
        });
      },
    });
  }

  function showBackupCodes(codes, title) {
    const m = modal({ title, dismiss: false, content: [
      h("p", { class: "modal-text" }, t`Это резервные коды: каждый подходит один раз вместо кода из приложения, если телефона нет под рукой. Сохраните их — больше мы их не покажем.`),
      codesBlock(codes),
    ], actions: [h("button", { class: "btn", onclick: () => copyText(codes.join("\n"), t`Коды скопированы`) }, icon("copy", 16), t`Скопировать`), h("button", { class: "btn primary", onclick: () => m.close() }, t`Я сохранил коды`)] });
  }

  /* ---- резервный адрес ---- */

  function setBackupEmail() {
    const address = field(t`Резервный адрес`, { type: "email", inputmode: "email", placeholder: t`вы@example.com`, autocomplete: "email", autofocus: true, hint: t`Другой ваш ящик, не @tabora.app. На него придёт код, если вы забудете пароль.` });
    reauth({
      title: t`Резервный адрес`,
      confirm: t`Отправить код`,
      extra: [address],
      run: ({ loginHash, code }) => api.backupEmailSet(account.token, { loginHash, code, address: address.value.trim() }),
      done: () => verifyBackupEmail(address.value.trim()),
    });
  }

  function verifyBackupEmail(address) {
    const code = field(t`Код из письма`, { mono: true, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "000 000", autofocus: true });
    const error = formError();
    const submit = h("button", { class: "btn primary" }, t`Подтвердить`);
    const m = modal({ title: t`Подтвердите адрес`, content: [h("p", { class: "modal-text" }, t`Мы отправили код на ${address}. Письмо может идти пару минут; проверьте папку «Спам».`), h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, code.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, t`Позже`), submit] });
    submit.addEventListener("click", async () => {
      error.set("");
      try {
        await busy(submit, () => api.backupEmailVerify(account.token, code.value.replace(/\s+/g, "")), t`Проверяем`);
        m.close();
        toast(t`Резервный адрес подтверждён`);
        load();
      } catch (e) {
        error.set(e.code === "bad-code" || e.code === "no-code" ? t`Код не подошёл или устарел` : errorText(e));
      }
    });
  }

  /* ---- ключ восстановления ---- */

  async function newRecoveryKey() {
    if (security?.recoveryKey && !(await confirmDialog({ title: t`Создать новый ключ восстановления?`, text: t`Прежний ключ перестанет действовать. Новый нужно будет сохранить заново.`, confirm: t`Создать` }))) {
      return;
    }
    try {
      const key = await account.newRecoveryKey();
      const saved = h("input", { type: "checkbox" });
      const done = h("button", { class: "btn primary", disabled: true, onclick: () => m.close() }, t`Готово`);
      saved.addEventListener("change", () => (done.disabled = !saved.checked));
      const m = modal({ title: t`Ключ восстановления`, dismiss: false, content: [
        h("p", { class: "modal-text" }, t`Если вы забудете пароль, только этот ключ вернёт аккаунт и зашифрованные письма. Мы его не храним и показываем один раз.`),
        h("div", { class: "recovery-key" }, key.split("-").map(g => h("span", {}, g))),
        h("label", { class: "check" }, saved, h("span", {}, t`Я сохранил ключ в надёжном месте`)),
      ], actions: [h("button", { class: "btn", onclick: () => copyText(key, t`Ключ скопирован`) }, icon("copy", 16), t`Скопировать`), done] });
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
    const keyNote = k.state === "ok" ? t`Открыт: зашифрованные письма читаются и отправляются` : k.state === "offline" ? t`Нет связи с сервером` : k.reason === "wrong-wrap" || k.canRecovery ? t`Закрыт: копия привязана к прежнему паролю. Зашифрованные письма не откроются` : t`Ещё не готов: ключ есть только в браузере Tabora на вашем компьютере (там: «Почта» → «Шифрование» → «Сохранить копию»)`;
    clear(body,
      loadError ? h("div", { class: "note bad" }, icon("warning", 17), h("div", {}, h("span", {}, loadError), h("button", { class: "link-btn", onclick: load }, t`Повторить`))) : null,
      card(t`Профиль`,
        row(t`Адрес`, account.email, [h("button", { class: "icon-btn", "aria-label": t`Скопировать адрес`, onclick: () => copyText(account.email, t`Адрес скопирован`) }, icon("copy", 18))]),
        row(t`Вход на этом устройстве`, t`Сохранён, пока вы сами не выйдете`, [h("button", { class: "btn small", onclick: () => account.signOut() }, t`Выйти`)])),
      card(t`Язык`,
        row(t`Язык интерфейса`, t`Письма от Tabora приходят на этом же языке`, [languagePicker()])),
      card(t`Защита входа`,
        row(t`Пароль`, t`Знаете только вы; на сервере его нет`, [h("button", { class: "btn small", onclick: changePassword }, t`Сменить`)], { wrap: true }),
        row(t`Двухфакторная защита`, !security ? "…" : two.enabled ? t`Включена${two.since ? t` с ${shortDate(two.since)}` : ""}, резервных кодов: ${two.backupCodes}` : t`Выключена: для входа достаточно пароля`, !security ? [] : two.enabled ? [
          h("button", { class: "btn small", onclick: () => reauth({ title: t`Новые резервные коды`, text: t`Прежние резервные коды перестанут действовать.`, confirm: t`Создать`, run: ({ loginHash, code }) => api.twoFactorCodes(account.token, loginHash, code), done: r => showBackupCodes(r.backupCodes, t`Новые резервные коды`) }) }, t`Коды`),
          h("button", { class: "btn small", onclick: () => reauth({ title: t`Выключить двухфакторную защиту`, text: t`Для входа снова будет достаточно одного пароля.`, confirm: t`Выключить`, danger: true, run: ({ loginHash, code }) => api.twoFactorDisable(account.token, loginHash, code), done: () => toast(t`Двухфакторная защита выключена`) }) }, t`Выключить`),
        ] : [h("button", { class: "btn small primary", onclick: enableTwoFactor }, t`Включить`)], { wrap: true }),
        row(t`Резервный адрес`, !security ? "…" : security.backupEmail ? security.backupEmail.address : security.backupEmailPending ? t`${security.backupEmailPending.address} — ждёт подтверждения` : t`Не задан: забытый пароль можно сбросить только ключом восстановления`, !security ? [] : [
          security.backupEmailPending && !security.backupEmail ? h("button", { class: "btn small primary", onclick: () => verifyBackupEmail(security.backupEmailPending.address) }, t`Ввести код`) : null,
          h("button", { class: "btn small", onclick: setBackupEmail }, security.backupEmail ? t`Сменить` : t`Указать`),
          security.backupEmail ? h("button", { class: "btn small", onclick: () => reauth({ title: t`Убрать резервный адрес`, text: t`Сбросить забытый пароль по письму будет нельзя.`, confirm: t`Убрать`, danger: true, run: ({ loginHash, code }) => api.backupEmailRemove(account.token, { loginHash, code }), done: () => toast(t`Резервный адрес убран`) }) }, t`Убрать`) : null,
        ], { wrap: true }),
        row(t`Ключ восстановления`, !security ? "…" : security.recoveryKey ? t`Создан. Возвращает аккаунт и зашифрованные письма, если пароль забыт` : t`Не создан: без него забытый пароль не вернуть`, [h("button", { class: "btn small", disabled: k.state !== "ok", onclick: newRecoveryKey }, security?.recoveryKey ? t`Новый` : t`Создать`)], { wrap: true })),
      card(t`Шифрование почты`,
        row(t`Ключ`, keyNote, k.state === "locked" && (k.canRecovery || k.reason === "wrong-wrap") ? [h("button", { class: "btn small primary", onclick: () => unlockKeysDialog(ctx) }, t`Открыть`)] : [], { wrap: true }),
        k.fingerprint ? row(t`Отпечаток ключа почты`, h("span", { class: "mono wrap small-text" }, formatFingerprint(k.fingerprint)), [h("button", { class: "icon-btn", "aria-label": t`Скопировать отпечаток`, onclick: () => copyText(formatFingerprint(k.fingerprint), t`Отпечаток скопирован`) }, icon("copy", 18))], { tall: true }) : null),
      card(t`Устройства`,
        devices ? devices.filter(d => d.current || d.active !== false).sort((a, b) => Number(b.current) - Number(a.current) || (b.at || 0) - (a.at || 0)).map(d => row(d.current ? t`Это устройство` : t`Был в сети ${shortDate(d.at)}`, d.name || t`Устройство`, d.current ? [] : [h("button", { class: "btn small", onclick: () => revoke(d) }, t`Завершить`)], { wrap: true })) : row("", "…")),
      card(t`Удаление аккаунта`,
        row(t`Удалить аккаунт`, t`Вместе с почтовым ящиком и данными на сервере. Отменить нельзя`, [h("button", { class: "btn small danger", onclick: deleteAccount }, t`Удалить`)], { wrap: true })),
      h("p", { class: "settings-foot" }, t`Почта Tabora · `, h("a", { href: "https://tabora.app/", target: "_blank", rel: "noopener" }, "tabora.app"), " · ", h("a", { href: "https://github.com/Tabora-App/browser", target: "_blank", rel: "noopener noreferrer" }, t`исходный код`)));
  }

  /* ---- удаление аккаунта: сразу и навсегда, после пароля и кода второго шага ---- */

  function deleteAccount() {
    const sure = h("input", { type: "checkbox" });
    const email = account.email;
    reauth({
      title: t`Удалить аккаунт`,
      text: t`Аккаунт ${email} будет удалён сразу и навсегда: почтовый ящик со всеми письмами, адреса для сайтов, данные синхронизации на сервере и обращения в поддержку. Адрес больше никому не выдаётся, вернуть ничего нельзя.`,
      confirm: t`Удалить навсегда`,
      danger: true,
      after: [{ el: h("label", { class: "check" }, sure, h("span", {}, t`Я понимаю, что отменить это нельзя`)) }],
      run: async ({ loginHash, code }) => {
        if (!sure.checked) {
          throw new Error(t`Отметьте, что понимаете последствия`);
        }
        await account.deleteAccount({ loginHash, code });
      },
      done: () => toast(t`Аккаунт ${email} удалён`, { ms: 6000 }),
    });
  }

  function revoke(d) {
    reauth({
      title: t`Завершить сеанс устройства`,
      text: t`«${d.name}» выйдет из аккаунта и потеряет доступ к почте. Данные, уже сохранённые на нём, останутся там.`,
      confirm: t`Завершить`,
      danger: true,
      needCode: false,
      run: ({ loginHash }) => api.deviceRevoke(account.token, d.id, loginHash),
      done: () => toast(t`Сеанс завершён`),
    });
  }

  const off1 = account.subscribe(what => what === "keys" && draw());
  draw();
  load();
  return {
    route() {},
    destroy() {
      alive = false;
      off1();
    },
  };
}
