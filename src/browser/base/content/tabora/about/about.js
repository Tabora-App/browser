/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Окно «О Tabora»: версия, сборка, состояние обновлений, ссылки на наш сайт. */

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

function url(key) {
  if (key.startsWith("about:")) {
    return key;
  }
  const home = Services.prefs.getStringPref("tabora.url.homepage", "https://tabora.app");
  return Services.prefs.getStringPref(`tabora.url.${key}`, "") || home;
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
  document.getElementById("version").textContent = `Версия ${version}`;
  let arch = "";
  try {
    arch = Services.sysinfo.get("arch");
    if (["x86", "x86-64"].includes(arch)) {
      arch = Services.appinfo.is64Bit ? "64-бит" : "32-бит";
    }
  } catch (e) {}
  document.getElementById("arch").textContent = arch;
  const id = Services.appinfo.appBuildID || "";
  if (id.length >= 8) {
    const d = new Date(Number(id.slice(0, 4)), Number(id.slice(4, 6)) - 1, Number(id.slice(6, 8)));
    document.getElementById("build").textContent = `Сборка ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}`;
  }
  const { TaboraUpdate } = ChromeUtils.importESModule("chrome://browser/content/tabora/update/TaboraUpdate.sys.mjs");
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
    upd.textContent = "Проверяем обновления…";
    TaboraUpdate.check({ force: true }).catch(e => { upd.textContent = `Не удалось проверить: ${e.message}`; });
  });
  restart.addEventListener("click", () => TaboraUpdate.restart());
  for (const b of document.querySelectorAll(".link[data-url]")) {
    b.addEventListener("click", () => open(url(b.dataset.url)));
  }
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" || (e.key === "w" && (e.metaKey || e.ctrlKey))) {
      window.close();
    }
  });
}

fill();
