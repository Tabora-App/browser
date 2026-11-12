/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Каркас веб-версии: почта и настройки аккаунта. Пароли сайтов, коды входа, закладки и кошелёк
 * живут только в браузере Tabora: секретам хранилища не место на веб-странице, код которой каждый
 * раз приходит с сервера. Адрес экрана лежит в части адреса после # (#/mail/…, #/account):
 * серверу он не уходит, а кнопка «Назад» работает. */

import { Jmap } from "../core/jmap.js";
import { Mail } from "../core/mail.js";
import { MailPgp } from "../core/mailpgp.js";
import { clear, h } from "../lib/dom.js";
import { mountAccount } from "./account.js";
import { mountMail } from "./mail.js";
import { t } from "../core/i18n.js";

const SCREENS = { mail: mountMail, account: mountAccount };

function parse() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(p => {
    try {
      return decodeURIComponent(p);
    } catch (e) {
      return p;
    }
  });
  return { screen: parts[0] || "", rest: parts.slice(1) };
}

/**
 * @param {HTMLElement} root
 * @param {{ account: import("../core/account.js").Account, api: import("../core/api.js").Api }} deps
 */
export function mountShell(root, deps) {
  const { account } = deps;
  const view = h("main", { class: "view", id: "view" });
  let active = null; // { id, api }
  const timers = [];
  const mail = new Mail({ account, jmap: new Jmap(account), pgp: new MailPgp(account) });
  const mailListeners = new Set();

  const navigate = (path, { replace = false } = {}) => {
    const target = `#/${path.replace(/^\/+/, "")}`;
    if (location.hash === target) {
      route();
    } else if (replace) {
      history.replaceState(null, "", target);
      route();
    } else {
      location.hash = target;
    }
  };

  const ctx = {
    ...deps,
    mail,
    navigate,
    /** Сообщать экрану почты, что в ящике что-то изменилось (пришло письмо, отметки с другого устройства). */
    onMailChange(fn) {
      mailListeners.add(fn);
      return () => mailListeners.delete(fn);
    },
    /** Число непрочитанных в заголовке вкладки браузера. */
    setUnread(n) {
      document.title = n ? t`(${n > 99 ? "99+" : n}) Почта Tabora` : t`Почта Tabora`;
    },
  };

  clear(root, h("div", { class: "app" }, view));

  function route() {
    const { screen, rest } = parse();
    const mount = SCREENS[screen];
    if (!mount) {
      navigate("mail", { replace: true });
      return;
    }
    if (active?.id === screen) {
      active.api.route?.(rest);
      return;
    }
    active?.api.destroy?.();
    clear(view);
    view.dataset.screen = screen;
    active = { id: screen, api: mount(view, ctx, rest) || {} };
  }

  window.addEventListener("hashchange", route);
  route();

  // новая почта: раз в 45 секунд и при возвращении на вкладку
  const pollMail = async () => {
    if (document.visibilityState !== "visible" || !account.signedIn) {
      return;
    }
    try {
      const first = !mail.boxes;
      const changed = await mail.changed();
      ctx.setUnread(mail.box("inbox")?.unread || 0);
      if (changed && !first) {
        mailListeners.forEach(fn => fn());
      }
    } catch (e) {}
  };
  pollMail();
  timers.push(setInterval(pollMail, 45000));
  document.addEventListener("visibilitychange", pollMail);

  return {
    destroy() {
      window.removeEventListener("hashchange", route);
      document.removeEventListener("visibilitychange", pollMail);
      timers.forEach(clearInterval);
      active?.api.destroy?.();
      document.title = t`Почта Tabora`;
      clear(root);
    },
  };
}
