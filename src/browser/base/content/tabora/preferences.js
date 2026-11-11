/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Собственные карточки Tabora на странице настроек: баннеры cookie в разделе
 * «Приватность и защита», спящие вкладки и быстрые кнопки во «Вкладках и просмотре».
 * Стили — preferences.css. */

(function () {
  const HTML = "http://www.w3.org/1999/xhtml";
  const PREF_MODE = "tabora.cookies.banners";
  const PREF_NOTIFY = "tabora.cookies.notify";
  const PREF_COUNT = "tabora.cookies.handledCount";
  const PREF_SLEEP = "tabora.tabs.sleepAfterMinutes";
  const PREF_DOCK = "tabora.dock.items";

  function h(tag, attrs = {}, text) {
    const el = document.createElementNS(HTML, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  }

  function cookieBannersCard() {
    const mode = Services.prefs.getStringPref(PREF_MODE, "reject");
    const count = Services.prefs.getIntPref(PREF_COUNT, 0);
    const card = h("moz-card", { id: "tabora-cookie-banners", heading: "Баннеры cookie", class: "tabora-card" });
    const body = h("div", { class: "tabora-card-body" });
    body.append(h("p", { class: "tabora-card-sub" }, "Окна «Этот сайт использует cookie» закрываем за вас: нажимаем «Отклонить» или «Только необходимые», как только баннер появился."));

    const group = h("moz-radio-group", { name: "tabora-cookie-banners-mode", "aria-label": "Что делать с баннерами cookie" });
    const options = [
      ["reject", "Отклонять необязательные", "Рекомендуется. Сайт получит только то, без чего не работает"],
      ["accept", "Принимать все", "Баннер исчезает, сайт ставит все cookie"],
      ["off", "Не трогать", "Баннеры остаются, решаете сами"],
    ];
    for (const [value, label, description] of options) {
      const radio = h("moz-radio", { value, label, description });
      if (value === mode) {
        radio.setAttribute("checked", "true");
      }
      group.append(radio);
    }
    group.value = mode;
    group.addEventListener("change", () => {
      const v = group.value;
      if (v) {
        Services.prefs.setStringPref(PREF_MODE, v);
      }
    });
    body.append(group);

    const notify = h("moz-checkbox", { label: "Показывать уведомление, когда баннер закрыт" });
    if (Services.prefs.getBoolPref(PREF_NOTIFY, true)) {
      notify.setAttribute("checked", "true");
    }
    notify.addEventListener("change", () => Services.prefs.setBoolPref(PREF_NOTIFY, !!notify.checked));
    body.append(notify);

    const stat = h("p", { class: "tabora-card-stat" });
    const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
    stat.textContent = count ? `Закрыто ${count} ${plural(count, "баннер", "баннера", "баннеров")}` : "Пока ни одного баннера не закрыто";
    body.append(stat);
    card.append(body);
    return card;
  }

  function sleepingTabsCard() {
    const current = String(Services.prefs.getIntPref(PREF_SLEEP, 0));
    const card = h("moz-card", { id: "tabora-sleeping-tabs", heading: "Спящие вкладки", class: "tabora-card" });
    const body = h("div", { class: "tabora-card-body" });
    body.append(h("p", { class: "tabora-card-sub" }, "Спящая вкладка не занимает память, но при возврате загружается заново: несохранённое на странице может пропасть. Вкладки со звуком, камерой, микрофоном или демонстрацией экрана не засыпают."));
    const group = h("moz-radio-group", { name: "tabora-sleeping-tabs", "aria-label": "Когда усыплять неактивные вкладки" });
    const options = [
      ["0", "Не усыплять", "Рекомендуется. Вкладки остаются как были; при нехватке памяти система всё равно может выгрузить самые старые"],
      ["60", "Через час простоя", ""],
      ["240", "Через 4 часа простоя", ""],
      ["720", "Через 12 часов простоя", ""],
    ];
    for (const [value, label, description] of options) {
      const radio = h("moz-radio", description ? { value, label, description } : { value, label });
      if (value === current) {
        radio.setAttribute("checked", "true");
      }
      group.append(radio);
    }
    group.value = current;
    group.addEventListener("change", () => {
      const v = parseInt(group.value, 10);
      if (Number.isInteger(v) && v >= 0) {
        Services.prefs.setIntPref(PREF_SLEEP, v);
      }
    });
    body.append(group);
    card.append(body);
    return card;
  }

  /** Быстрые кнопки оболочки: список и порядок берутся у окна браузера (Tabora.DOCK в tabora.js). */
  function dockCard() {
    const shell = window.browsingContext.topChromeWindow?.Tabora;
    if (!shell?.DOCK) {
      return null;
    }
    const card = h("moz-card", { id: "tabora-dock-card", heading: "Быстрые кнопки", class: "tabora-card" });
    const body = h("div", { class: "tabora-card-body" });
    body.append(h("p", { class: "tabora-card-sub" }, "Значки рядом с адресной строкой при вкладках сверху. Отметьте те, что нужны под рукой: остальное открывается сочетанием клавиш. При вкладках сбоку те же разделы открывает кнопка «Разделы» внизу колонки."));
    const grid = h("div", { class: "tabora-dock-grid" });
    const boxes = new Map();
    const sync = () => {
      const on = new Set(shell.dockEnabled());
      for (const [id, box] of boxes) {
        box.checked = on.has(id);
        box.toggleAttribute("checked", on.has(id));
      }
    };
    for (const it of shell.DOCK) {
      const box = h("moz-checkbox", { label: `${it.label} (${it.key})` });
      box.addEventListener("change", () => {
        const on = new Set(shell.dockEnabled());
        if (box.checked) {
          on.add(it.id);
        } else {
          on.delete(it.id);
        }
        shell.setDockEnabled([...on]);
      });
      boxes.set(it.id, box);
      grid.append(box);
    }
    sync();
    Services.prefs.addObserver(PREF_DOCK, sync);
    window.addEventListener("unload", () => Services.prefs.removeObserver(PREF_DOCK, sync), { once: true });
    body.append(grid);
    card.append(body);
    return card;
  }

  function mountDock() {
    const anchor = document.getElementById("tabora-sleeping-tabs");
    if (!anchor || document.getElementById("tabora-dock-card")) {
      return;
    }
    const card = dockCard();
    if (!card) {
      return;
    }
    // та же категория, что у «Спящих вкладок»: переключатель разделов показывает их вместе
    if (anchor.hasAttribute("data-category")) {
      card.setAttribute("data-category", anchor.getAttribute("data-category"));
      card.hidden = anchor.hidden;
    }
    anchor.after(card);
  }

  function mountSleeping(pane) {
    if (document.getElementById("tabora-sleeping-tabs")) {
      return;
    }
    // «Основные» собираются из групп прямо в панели: карточка встаёт после группы «Вкладки»
    // с той же категорией, чтобы переключатель разделов показывал её только здесь
    const tabsGroup = pane.querySelector('[groupid="tabs"][data-category="paneGeneral"]');
    const section =
      pane.querySelector('setting-pane[data-category="paneTabsBrowsing"] section') ||
      pane.querySelector('setting-pane[data-category="paneGeneral"] section');
    if (!tabsGroup && !section) {
      return;
    }
    const card = sleepingTabsCard();
    if (section) {
      section.append(card);
    } else {
      card.setAttribute("data-category", "paneGeneral");
      if (tabsGroup.hidden) {
        card.hidden = true;
      }
      tabsGroup.after(card);
    }
  }

  // Раздел «Аккаунт» (account/pane.js) встаёт на место раздела Firefox «Аккаунт и синхронизация»
  Services.scriptloader.loadSubScript("chrome://tabora/content/account/pane.js", window);

  function mountAccount(pane) {
    const section = pane.querySelector('setting-pane[data-category="paneSync"] section');
    if (section && !document.getElementById("tabora-account")) {
      window.TaboraAccountPane.mount(section);
    }
  }

  function mount() {
    const pane = document.getElementById("mainPrefPane");
    if (!pane) {
      return;
    }
    mountAccount(pane);
    mountSleeping(pane);
    mountDock();
    if (document.getElementById("tabora-cookie-banners")) {
      return;
    }
    // Панель «Приватность» создаётся из шаблона при первом открытии: ставим карточку внутрь её секции
    const section = pane.querySelector('setting-pane[data-category="panePrivacy"] section');
    if (!section) {
      return;
    }
    const card = cookieBannersCard();
    const anchor = section.querySelector('[groupid="cookiesAndSiteData"], [groupid="cookiesAndSiteData2"]');
    if (anchor) {
      anchor.before(card);
    } else {
      section.append(card);
    }
  }

  /* Ссылки поддержки ведут в обращения Tabora (Аккаунт → Поддержка), а не на сайты Mozilla.
   * Щелчок перехватывается на подъёме: адрес этим элементам задаёт сама страница настроек
   * (support-page), и при перерисовке она вернула бы его обратно. */
  const SUPPORT = "about:preferences#sync-support";
  const SUPPORT_LINKS = {
    supportGetHelp: SUPPORT,
    supportShareIdeas: SUPPORT,
    helpButton: SUPPORT,
  };

  function supportLinks() {
    const open = e => {
      if (e.type === "auxclick" && e.button !== 1) {
        return;
      }
      for (const el of e.composedPath()) {
        const url = el.id && SUPPORT_LINKS[el.id];
        if (url) {
          e.preventDefault();
          e.stopImmediatePropagation();
          // раздел открывается в этой же вкладке настроек
          window.browsingContext.topChromeWindow.Tabora?.openAccountPage("support");
          return;
        }
      }
    };
    document.addEventListener("click", open, true);
    document.addEventListener("auxclick", open, true);
  }

  // Пункты меню настроек под Tabora: «Аккаунт» вместо «Аккаунт и синхронизация» (раздел занят
  // аккаунтом Tabora), «Расширения» без тем (тем оформления Firefox у оболочки нет).
  const NAV_LABELS = { "category-sync": "Аккаунт", addonsButton: "Расширения" };

  /** Мелкие правки готовых блоков страницы; вызывается при каждом изменении дерева. */
  function tidy() {
    for (const [id, label] of Object.entries(NAV_LABELS)) {
      const el = document.getElementById(id);
      if (el && (el.hasAttribute("data-l10n-id") || el.textContent !== label)) {
        el.removeAttribute("data-l10n-id"); // иначе перевод вернёт прежнюю подпись
        el.textContent = label;
      }
    }
    for (const [id, url] of Object.entries(SUPPORT_LINKS)) {
      const el = document.getElementById(id);
      if (el && el.localName === "moz-box-link" && el.getAttribute("href") !== url) {
        el.setAttribute("href", url); // чтобы при наведении был виден настоящий адрес
      }
    }
    // Иллюстрация-щит Mozilla в карточке состояния защиты: она внутри теневого дерева, поэтому
    // скрывается своим листом стилей (CSSOM, без встроенных стилей)
    for (const card of document.querySelectorAll("security-privacy-card")) {
      const root = card.shadowRoot;
      if (root && !root.taboraStyled) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(".status-image { display: none !important; }");
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        root.taboraStyled = true;
      }
    }
  }

  function watch() {
    mount();
    tidy();
    // Панели настроек создаются лениво и асинхронно: следим за деревом
    let queued = false;
    const mo = new MutationObserver(() => {
      if (!document.getElementById("tabora-cookie-banners") || !document.getElementById("tabora-sleeping-tabs") || !document.getElementById("tabora-account") || !document.getElementById("tabora-dock-card")) {
        mount();
      }
      if (!queued) {
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          tidy();
        });
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  supportLinks();
  watch();
})();
