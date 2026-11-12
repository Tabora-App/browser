/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Экраны до входа: вход, код второго фактора, регистрация, ключ восстановления, сброс пароля. */

import { passwordStrength } from "../core/password.js";
import { clear, h, icon, mark } from "../lib/dom.js";
import { busy, copyText, debounce, errorText, field, formError, toast } from "../lib/ui.js";

const DOMAIN = "tabora.app";

function nameField(value = "", autofocus = true) {
  const f = field("Адрес", { name: "username", autocomplete: "username", placeholder: "имя", value, autofocus, inputmode: "email", suffix: h("span", { class: "input-suffix" }, `@${DOMAIN}`) });
  f.el.querySelector(".input-wrap").classList.add("has-text-suffix");
  // человек может вставить адрес целиком: домен убирается, чтобы не получилось имя@tabora.app@tabora.app
  f.input.addEventListener("input", () => {
    const v = f.input.value;
    if (v.includes("@")) {
      const [name, dom] = v.split("@");
      if (!dom || DOMAIN.startsWith(dom.toLowerCase())) {
        f.input.value = name;
      }
    }
  });
  return f;
}

function strengthMeter(input) {
  const label = h("span", {}, "");
  const el = h("div", { class: "strength", "data-score": "0" }, h("span", { class: "strength-bars" }, h("i"), h("i"), h("i"), h("i")), label);
  const update = () => {
    const s = passwordStrength(input.value);
    el.dataset.score = input.value ? String(Math.max(1, s.score)) : "0";
    label.textContent = input.value ? s.label : "";
  };
  input.addEventListener("input", update);
  return el;
}

function shell(content, footer = null) {
  return h("div", { class: "auth" },
    h("main", { class: "auth-card" }, content),
    h("footer", { class: "auth-foot" }, footer || [h("a", { href: "https://tabora.app/", rel: "noopener" }, "О Tabora"), h("a", { href: "https://tabora.app/#download", rel: "noopener" }, "Скачать браузер")]));
}

function head(title, text = "") {
  return h("header", { class: "auth-head" }, mark(44), h("h1", {}, title), text && h("p", {}, text));
}

/**
 * @param {HTMLElement} root
 * @param {{ account: import("../core/account.js").Account }} ctx
 */
export function mountAuth(root, { account }) {
  let name = "";

  function show(view) {
    clear(root, view);
    root.querySelector("[autofocus]")?.focus();
  }

  /* ---- вход ---- */

  function login() {
    const user = nameField(name);
    const pass = field("Пароль", { type: "password", name: "password", autocomplete: "current-password" });
    const error = formError();
    const submit = h("button", { class: "btn primary large block", type: "submit" }, "Войти");
    const form = h("form", { class: "auth-form", novalidate: true }, user.el, pass.el, error.el, submit);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      name = user.value.trim();
      if (!name || !pass.value) {
        error.set(!name ? "Введите адрес" : "Введите пароль");
        (!name ? user : pass).input.focus();
        return;
      }
      try {
        await busy(submit, async step => {
          account.onStep = step;
          await account.signIn(name, pass.value);
        }, "Входим");
      } catch (err) {
        if (err.code === "2fa-required") {
          twoFactor();
          return;
        }
        error.set(err.code === "bad-credentials" ? "Неверный адрес или пароль" : errorText(err));
        pass.input.select();
      } finally {
        account.onStep = null;
      }
    });
    show(shell([
      head("Почта Tabora", "Войдите, чтобы открыть свой ящик."),
      form,
      h("div", { class: "auth-links" },
        h("button", { class: "link-btn", type: "button", onclick: () => { name = user.value.trim(); forgot(); } }, "Забыли пароль?"),
        h("button", { class: "link-btn", type: "button", onclick: () => { name = user.value.trim(); register(); } }, "Создать аккаунт")),
    ]));
  }

  /* ---- код второго фактора ---- */

  function twoFactor({ after = null } = {}) {
    const code = field("Код из приложения", { name: "totp", autocomplete: "one-time-code", inputmode: "numeric", placeholder: "000 000", mono: true, autofocus: true, hint: "Шесть цифр из приложения для кодов. Нет доступа к приложению — введите резервный код." });
    const error = formError();
    const submit = h("button", { class: "btn primary large block", type: "submit" }, "Подтвердить");
    const form = h("form", { class: "auth-form", novalidate: true }, code.el, error.el, submit);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      if (!code.value.trim()) {
        error.set("Введите код");
        return;
      }
      try {
        await busy(submit, async step => {
          account.onStep = step;
          if (after) {
            await after(code.value.trim());
          } else {
            await account.signIn(name, "", { totp: code.value.trim() });
          }
        }, "Проверяем");
      } catch (err) {
        if (err.code === "bad-credentials") {
          toast("Время на ввод кода вышло: войдите заново");
          login();
          return;
        }
        error.set(err.code === "bad-2fa" ? "Код не подошёл. Проверьте время на телефоне и введите новый код" : errorText(err));
        code.input.select();
      } finally {
        account.onStep = null;
      }
    });
    show(shell([head("Подтвердите вход", `Аккаунт ${name.includes("@") ? name : `${name}@${DOMAIN}`} защищён вторым шагом.`), form, h("div", { class: "auth-links" }, h("button", { class: "link-btn", type: "button", onclick: login }, "Назад"))]));
  }

  /* ---- регистрация ---- */

  function register() {
    const user = nameField(name);
    const status = h("div", { class: "field-hint name-status" }, "Латинские буквы, цифры, точка, дефис. От 3 знаков.");
    user.el.append(status);
    const pass = field("Пароль", { type: "password", name: "new-password", autocomplete: "new-password", hint: "" });
    pass.el.append(strengthMeter(pass.input));
    const error = formError();
    const submit = h("button", { class: "btn primary large block", type: "submit" }, "Создать аккаунт");
    let checked = "";
    const check = debounce(async () => {
      const v = user.value.trim().toLowerCase();
      if (!v) {
        status.textContent = "Латинские буквы, цифры, точка, дефис. От 3 знаков.";
        status.dataset.tone = "";
        return;
      }
      let email;
      try {
        email = account.normalizeEmail(v);
      } catch (e) {
        status.textContent = e.message;
        status.dataset.tone = "bad";
        return;
      }
      checked = v;
      try {
        const free = await account.api.available(email);
        if (checked !== v) {
          return;
        }
        status.textContent = free ? `${email} свободен` : "Это имя уже занято";
        status.dataset.tone = free ? "ok" : "bad";
      } catch (e) {
        status.textContent = "";
      }
    }, 350);
    user.input.addEventListener("input", check);
    const form = h("form", { class: "auth-form", novalidate: true }, user.el, pass.el,
      error.el, submit,
      h("p", { class: "auth-fine" }, "Пароль знаете только вы: на сервер он не уходит и восстановить его нельзя. После регистрации мы покажем ключ восстановления — сохраните его."));
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      name = user.value.trim();
      try {
        const r = await busy(submit, async step => {
          account.onStep = step;
          return account.register(name, pass.value, { hold: true });
        }, "Создаём аккаунт");
        recoveryKey(r.recoveryKey, r.email);
      } catch (err) {
        error.set(errorText(err));
      } finally {
        account.onStep = null;
      }
    });
    show(shell([head("Новый аккаунт", "Бесплатно. Вместе с аккаунтом вы получаете почтовый ящик."), form, h("div", { class: "auth-links" }, h("button", { class: "link-btn", type: "button", onclick: login }, "У меня уже есть аккаунт"))]));
    if (name) {
      check();
    }
  }

  /* ---- ключ восстановления после регистрации ---- */

  function recoveryKey(key, email) {
    const saved = h("input", { type: "checkbox" });
    const go = h("button", { class: "btn primary large block", disabled: true, onclick: () => account.release() }, "Открыть почту");
    saved.addEventListener("change", () => (go.disabled = !saved.checked));
    const file = () => {
      const blob = new Blob([`Ключ восстановления Tabora\nАккаунт: ${email}\n\n${key}\n\nКлюч нужен, если вы забудете пароль. Храните его отдельно от пароля и никому не показывайте.\n`], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: `tabora-recovery-${email.split("@")[0]}.txt` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };
    show(shell([
      head("Сохраните ключ восстановления", "Если вы забудете пароль, только этот ключ вернёт доступ к аккаунту и зашифрованным письмам. Мы его не храним и показываем один раз."),
      h("div", { class: "recovery-key", "aria-label": "Ключ восстановления" }, key.split("-").map(g => h("span", {}, g))),
      h("div", { class: "auth-row" },
        h("button", { class: "btn", onclick: () => copyText(key, "Ключ скопирован") }, icon("copy", 16), "Скопировать"),
        h("button", { class: "btn", onclick: file }, icon("download", 16), "Сохранить файлом")),
      h("label", { class: "check" }, saved, h("span", {}, "Я сохранил ключ в надёжном месте")),
      go,
    ], []));
  }

  /* ---- сброс пароля ---- */

  function forgot() {
    show(shell([
      head("Восстановление доступа", "Выберите, что у вас есть."),
      h("div", { class: "auth-choices" },
        h("button", { class: "choice", onclick: byRecovery }, h("span", { class: "choice-icon" }, icon("key", 20)), h("span", {}, h("b", {}, "Ключ восстановления"), h("small", {}, "32 знака, которые вы сохранили при регистрации. Возвращает аккаунт и все данные.")), icon("forwardChevron", 18)),
        h("button", { class: "choice", onclick: byEmail }, h("span", { class: "choice-icon" }, icon("mail", 20)), h("span", {}, h("b", {}, "Письмо на резервный адрес"), h("small", {}, "Если вы указывали его в настройках аккаунта. Возвращает вход и почту.")), icon("forwardChevron", 18))),
      h("div", { class: "auth-links" }, h("button", { class: "link-btn", type: "button", onclick: login }, "Назад ко входу")),
    ]));
  }

  function byRecovery() {
    const user = nameField(name);
    const key = field("Ключ восстановления", { mono: true, placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", autocomplete: "off" });
    const pass = field("Новый пароль", { type: "password", autocomplete: "new-password" });
    pass.el.append(strengthMeter(pass.input));
    const error = formError();
    const submit = h("button", { class: "btn primary large block", type: "submit" }, "Сменить пароль и войти");
    const form = h("form", { class: "auth-form", novalidate: true }, user.el, key.el, pass.el, error.el, submit);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      name = user.value.trim();
      try {
        let off = false;
        await busy(submit, async step => {
          account.onStep = step;
          const r = await account.resetWithRecovery(name, key.value, pass.value);
          off = r.twoFactorDisabled;
          step("Входим");
          await account.signIn(name, pass.value, { hold: true });
          step("Возвращаем данные");
          await account.unlockWithRecovery(key.value, pass.value).catch(() => {});
        }, "Проверяем ключ");
        if (off) {
          toast("Двухфакторная защита снята: включите её заново в настройках аккаунта", { ms: 7000 });
        }
        account.release();
      } catch (err) {
        error.set(err.code === "bad-proof" || err.code === "no-recovery" ? "Ключ восстановления не подходит к этому аккаунту" : errorText(err));
      } finally {
        account.onStep = null;
      }
    });
    show(shell([head("Сброс ключом восстановления"), form, h("div", { class: "auth-links" }, h("button", { class: "link-btn", type: "button", onclick: forgot }, "Назад"))]));
  }

  function byEmail() {
    const user = nameField(name);
    const error = formError();
    const submit = h("button", { class: "btn primary large block", type: "submit" }, "Отправить код");
    const form = h("form", { class: "auth-form", novalidate: true }, user.el, error.el, submit);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      name = user.value.trim();
      try {
        const email = account.normalizeEmail(name);
        await busy(submit, () => account.api.resetEmailStart(email), "Отправляем");
        emailCode(email);
      } catch (err) {
        error.set(errorText(err));
      }
    });
    show(shell([head("Сброс по письму", "Мы отправим код на резервный адрес аккаунта."), form, h("div", { class: "auth-links" }, h("button", { class: "link-btn", type: "button", onclick: forgot }, "Назад"))]));
  }

  function emailCode(email) {
    const code = field("Код из письма", { mono: true, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "0000 0000", autofocus: true });
    const pass = field("Новый пароль", { type: "password", autocomplete: "new-password" });
    pass.el.append(strengthMeter(pass.input));
    const error = formError();
    const submit = h("button", { class: "btn primary large block", type: "submit" }, "Сменить пароль и войти");
    const form = h("form", { class: "auth-form", novalidate: true }, code.el, pass.el, error.el, submit);
    const run = totp => account.resetWithEmailCode(email, code.value, pass.value, { totp });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      error.set("");
      try {
        await busy(submit, async step => {
          account.onStep = step;
          await run("");
        }, "Меняем пароль");
      } catch (err) {
        if (err.code === "2fa-required") {
          name = email;
          twoFactor({ after: run });
          return;
        }
        error.set(err.code === "bad-code" || err.code === "no-code" ? "Код не подошёл или устарел. Запросите новый" : errorText(err));
      } finally {
        account.onStep = null;
      }
    });
    show(shell([
      head("Введите код из письма", "Если у аккаунта есть резервный адрес, письмо уже там. Код действует 30 минут."),
      form,
      h("div", { class: "auth-links" }, h("button", { class: "link-btn", type: "button", onclick: byEmail }, "Отправить ещё раз"), h("button", { class: "link-btn", type: "button", onclick: login }, "Ко входу")),
    ]));
  }

  login();
  return { destroy() { clear(root); } };
}
