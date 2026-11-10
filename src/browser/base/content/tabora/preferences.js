/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Собственные карточки Tabora на странице настроек: баннеры cookie в разделе
 * «Приватность и защита», спящие вкладки во «Вкладках и просмотре». Стили — preferences.css. */

(function () {
  const HTML = "http://www.w3.org/1999/xhtml";
  const PREF_MODE = "tabora.cookies.banners";
  const PREF_NOTIFY = "tabora.cookies.notify";
  const PREF_COUNT = "tabora.cookies.handledCount";
  const PREF_SLEEP = "tabora.tabs.sleepAfterMinutes";

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

  function mount() {
    const pane = document.getElementById("mainPrefPane");
    if (!pane) {
      return;
    }
    mountSleeping(pane);
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

  function watch() {
    mount();
    // Панели настроек создаются лениво и асинхронно: следим за деревом, пока карточка не встанет
    const mo = new MutationObserver(() => {
      if (document.getElementById("tabora-cookie-banners") && document.getElementById("tabora-sleeping-tabs")) {
        return;
      }
      mount();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  watch();
})();
