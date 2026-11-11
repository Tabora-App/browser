/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Каркас приложения: разделы слева (на телефоне — внизу) и область раздела. Адрес раздела лежит
 * в части адреса после # (#/mail, #/passwords/…): серверу он не уходит, а кнопка «Назад» работает. */

import { clear, h, icon, mark } from "../lib/dom.js";
import { menu } from "../lib/ui.js";
import { mountAccount } from "./account.js";
import { mountBookmarks } from "./bookmarks.js";
import { mountCodes } from "./codes.js";
import { mountDevices } from "./devices.js";
import { mountMail } from "./mail.js";
import { mountPasswords } from "./passwords.js";
import { mountSupport } from "./support.js";

const SECTIONS = [
  { id: "mail", label: "Почта", icon: "mail", mount: mountMail },
  { id: "passwords", label: "Пароли", icon: "key", mount: mountPasswords },
  { id: "codes", label: "Коды", icon: "code", mount: mountCodes },
  { id: "bookmarks", label: "Закладки", icon: "bookmark", mount: mountBookmarks },
  { id: "devices", label: "Вкладки", icon: "devices", mount: mountDevices, more: true },
  { id: "support", label: "Поддержка", icon: "support", mount: mountSupport, more: true },
  { id: "account", label: "Аккаунт", icon: "user", mount: mountAccount, more: true, hidden: true },
];

function parse() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(p => {
    try {
      return decodeURIComponent(p);
    } catch (e) {
      return p;
    }
  });
  return { section: parts[0] || "", rest: parts.slice(1) };
}

/**
 * @param {HTMLElement} root
 * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient, api: import("../core/api.js").Api }} deps
 */
export function mountShell(root, deps) {
  const { account, sync } = deps;
  const view = h("main", { class: "view", id: "view" });
  const badges = new Map();
  const navItems = new Map();
  let active = null; // { id, api }
  const timers = [];

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
    navigate,
    setBadge(section, n) {
      badges.set(section, n);
      for (const el of navItems.get(section) || []) {
        const b = el.querySelector(".nav-badge");
        b.textContent = n > 99 ? "99+" : String(n || "");
        b.hidden = !n;
      }
      const total = [...badges.values()].reduce((a, v) => a + (v || 0), 0);
      document.title = total ? `(${total}) Tabora` : "Tabora";
    },
  };

  function navButton(s, kind) {
    const el = h("a", { class: `nav-item ${kind}`, href: `#/${s.id}`, "data-section": s.id, "aria-label": s.label },
      h("span", { class: "nav-icon" }, icon(s.icon, 22, 1.7), h("span", { class: "nav-badge", hidden: true })),
      h("span", { class: "nav-label" }, s.label));
    navItems.set(s.id, [...(navItems.get(s.id) || []), el]);
    return el;
  }

  const initial = (account.email[0] || "?").toUpperCase();
  const accountButton = h("button", { class: "nav-account", "aria-label": `Аккаунт ${account.email}`, title: account.email }, h("span", { class: "nav-avatar" }, initial));
  accountButton.addEventListener("click", () => {
    menu(accountButton, [
      { label: account.email, icon: "user", run: () => navigate("account") },
      { label: "Настройки аккаунта", icon: "settings", run: () => navigate("account") },
      null,
      { label: "Выйти", icon: "logout", danger: true, run: () => account.signOut() },
    ]);
  });

  const rail = h("nav", { class: "rail", "aria-label": "Разделы" },
    h("a", { class: "rail-brand", href: "#/mail", "aria-label": "Tabora" }, mark(34)),
    h("div", { class: "rail-items" }, SECTIONS.filter(s => !s.hidden).map(s => navButton(s, "rail-item"))),
    accountButton);

  const moreButton = h("button", { class: "nav-item tab-item", "aria-label": "Ещё", "data-section": "more" }, h("span", { class: "nav-icon" }, icon("more", 22, 2.4), h("span", { class: "nav-badge", hidden: true })), h("span", { class: "nav-label" }, "Ещё"));
  moreButton.addEventListener("click", () => {
    menu(moreButton, [
      ...SECTIONS.filter(s => s.more).map(s => ({ label: s.label, icon: s.icon, run: () => navigate(s.id) })),
      null,
      { label: "Выйти", icon: "logout", danger: true, run: () => account.signOut() },
    ]);
  });
  const tabbar = h("nav", { class: "tabbar", "aria-label": "Разделы" }, SECTIONS.filter(s => !s.more).map(s => navButton(s, "tab-item")), moreButton);

  const app = h("div", { class: "app" }, rail, view, tabbar);
  clear(root, app);

  function route() {
    const { section, rest } = parse();
    const s = SECTIONS.find(x => x.id === section);
    if (!s) {
      navigate("mail", { replace: true });
      return;
    }
    for (const [id, els] of navItems) {
      for (const el of els) {
        el.classList.toggle("active", id === s.id);
        if (id === s.id) {
          el.setAttribute("aria-current", "page");
        } else {
          el.removeAttribute("aria-current");
        }
      }
    }
    moreButton.classList.toggle("active", !!s.more);
    if (active?.id === s.id) {
      active.api.route?.(rest);
      return;
    }
    active?.api.destroy?.();
    clear(view);
    view.dataset.section = s.id;
    active = { id: s.id, api: s.mount(view, ctx, rest) || {} };
  }

  window.addEventListener("hashchange", route);
  route();

  // данные с других устройств: при возвращении на вкладку и раз в минуту
  const refresh = () => {
    if (document.visibilityState === "visible" && account.signedIn && account.keys.state === "ok") {
      sync.refresh().catch(() => {});
    }
  };
  document.addEventListener("visibilitychange", refresh);
  timers.push(setInterval(refresh, 60000));
  refresh();
  const offKeys = account.subscribe(what => {
    if (what === "keys") {
      refresh();
    }
  });

  // непрочитанные ответы поддержки
  const pollSupport = async () => {
    try {
      const r = await deps.api.supportUnread(account.token);
      ctx.setBadge("support", (r.count || 0) + (r.queue || 0));
    } catch (e) {}
  };
  pollSupport();
  timers.push(setInterval(() => document.visibilityState === "visible" && pollSupport(), 120000));
  ctx.pollSupport = pollSupport;

  return {
    destroy() {
      window.removeEventListener("hashchange", route);
      document.removeEventListener("visibilitychange", refresh);
      timers.forEach(clearInterval);
      offKeys();
      active?.api.destroy?.();
      document.title = "Tabora";
      clear(root);
    },
  };
}
