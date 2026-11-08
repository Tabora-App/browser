// Настройки Tabora по умолчанию. Попадают в сборку через tools/build.py
// (дописываются в branding/pref/firefox-branding.js).

// Сервисы Mozilla выключены: аккаунт, синхронизация, VPN, Relay, Pocket.
// Своя синхронизация и аккаунт появятся отдельно.
pref("identity.fxaccounts.enabled", false);
pref("browser.vpn_promo.enabled", false);
pref("browser.contentblocking.report.vpn.enabled", false);
pref("browser.contentblocking.report.monitor.enabled", false);
pref("browser.contentblocking.report.lockwise.enabled", false);
pref("browser.privatebrowsing.vpnpromourl", "");
pref("browser.promo.focus.enabled", false);
pref("browser.preferences.moreFromMozilla", false);
pref("extensions.pocket.enabled", false);
pref("signon.firefoxRelay.feature", "disabled");

// Телеметрия, эксперименты и рекомендации
pref("datareporting.healthreport.uploadEnabled", false);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("toolkit.telemetry.enabled", false);
pref("toolkit.telemetry.unified", false);
pref("app.shield.optoutstudies.enabled", false);
pref("app.normandy.enabled", false);
pref("browser.discovery.enabled", false);
pref("extensions.htmlaboutaddons.recommendations.enabled", false);

// Стартовая страница без рекламы и подборок Mozilla
pref("browser.newtabpage.activity-stream.showSponsored", false);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
pref("browser.newtabpage.activity-stream.feeds.topsites", false);
pref("browser.newtabpage.activity-stream.telemetry", false);
pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);

// Чужой ИИ-чат в боковой панели выключен: будет свой агент
pref("browser.ml.chat.enabled", false);
pref("browser.ml.enable", false);

// Первый запуск без приветственных страниц и проверки «браузер по умолчанию»
pref("browser.aboutwelcome.enabled", false);
pref("browser.shell.checkDefaultBrowser", false);
pref("browser.startup.homepage_override.mstone", "ignore");

// Оболочка Tabora: вертикальные вкладки в боковой панели Firefox, без лишних инструментов
pref("sidebar.revamp", true);
pref("sidebar.verticalTabs", true);
pref("sidebar.visibility", "always-show");
pref("sidebar.expandOnHover", false);
pref("sidebar.main.tools", "");
pref("sidebar.position_start", true);
pref("browser.toolbars.bookmarks.visibility", "never");
pref("browser.tabs.hoverPreview.enabled", false);
pref("browser.uidensity", 0);
pref("browser.theme.content-theme", 0);
pref("browser.theme.toolbar-theme", 0);
pref("extensions.activeThemeID", "firefox-compact-dark@mozilla.org");
