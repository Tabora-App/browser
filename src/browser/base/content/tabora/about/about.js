/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Окно «О Tabora»: версия, сборка, состояние обновлений, ссылки на наш сайт. */

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
// языки: надписи в коде (tt`…`) и в разметке about.xhtml (переводятся здесь же, до показа)
const { tt, tr: ttr, form: ttForm, locale: ttLocale, translateDocument } = ChromeUtils.importESModule("chrome://tabora/content/i18n/I18n.sys.mjs");
translateDocument(document);

// The website has its pages in these languages; any other interface language gets the English page.
const SITE_LANGUAGES = ["ru", "en", "uk", "es"];

/** The address behind a link of the window, or "" when the build has no such page (the link is then hidden). */
function url(key) {
  if (key.startsWith("about:")) {
    return key;
  }
  const lang = String(ttLocale()).toLowerCase().split("-")[0];
  return Services.prefs.getStringPref(`tabora.url.${key}`, "").replace("%LANG%", SITE_LANGUAGES.includes(lang) ? lang : "en");
}

function open(target) {
  const win = Services.wm.getMostRecentBrowserWindow();
  if (!win) {
    return;
  }
  if (target.startsWith("about:")) {
    win.openTrustedLinkIn(target, "tab");
  } else {
    win.openWebLinkIn(target, "tab");
  }
  win.focus();
}

function fill() {
  const version = Services.prefs.getStringPref("tabora.version", "") || AppConstants.MOZ_APP_VERSION_DISPLAY;
  document.getElementById("version").textContent = tt`Версия ${version}`;
  let arch = "";
  try {
    arch = Services.sysinfo.get("arch");
    if (["x86", "x86-64"].includes(arch)) {
      arch = Services.appinfo.is64Bit ? tt`64-бит` : tt`32-бит`;
    }
  } catch (e) {}
  document.getElementById("arch").textContent = arch;
  const id = Services.appinfo.appBuildID || "";
  if (id.length >= 8) {
    const d = new Date(Number(id.slice(0, 4)), Number(id.slice(4, 6)) - 1, Number(id.slice(6, 8)));
    document.getElementById("build").textContent = tt`Сборка ${d.toLocaleDateString(ttLocale(), { day: "numeric", month: "long", year: "numeric" })}`;
  }
  const { TaboraUpdate } = ChromeUtils.importESModule("chrome://tabora/content/update/TaboraUpdate.sys.mjs");
  const upd = document.getElementById("updates");
  const restart = document.getElementById("restart-update");
  const renderUpdates = () => {
    upd.textContent = TaboraUpdate.statusText();
    restart.hidden = !TaboraUpdate.readyForRestart;
  };
  renderUpdates();
  const obs = () => renderUpdates();
  Services.obs.addObserver(obs, TaboraUpdate.TOPIC);
  window.addEventListener("unload", () => Services.obs.removeObserver(obs, TaboraUpdate.TOPIC));
  document.getElementById("check-updates").addEventListener("click", () => {
    upd.textContent = tt`Проверяем обновления…`;
    TaboraUpdate.check({ force: true }).catch(e => { upd.textContent = tt`Не удалось проверить: ${e.message}`; });
  });
  restart.addEventListener("click", () => TaboraUpdate.restart());
  for (const b of document.querySelectorAll(".link[data-url]")) {
    const target = url(b.dataset.url);
    b.hidden = !target;
    b.addEventListener("click", () => open(target));
  }
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" || (e.key === "w" && (e.metaKey || e.ctrlKey))) {
      window.close();
    }
  });
}

fill();
