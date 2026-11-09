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
// Пинги Glean и старой телеметрии по отдельности: usage-reporting, архив, новые профили,
// завершение работы, обновления, зависания, характеристики пользователя
pref("datareporting.usage.uploadEnabled", false);
pref("datareporting.policy.firstRunURL", "");
pref("toolkit.telemetry.archive.enabled", false);
pref("toolkit.telemetry.newProfilePing.enabled", false);
pref("toolkit.telemetry.shutdownPingSender.enabled", false);
pref("toolkit.telemetry.firstShutdownPing.enabled", false);
pref("toolkit.telemetry.updatePing.enabled", false);
pref("toolkit.telemetry.bhrPing.enabled", false);
pref("toolkit.telemetry.user_characteristics_ping.opt-out", true);
pref("toolkit.telemetry.server", "data:,");
pref("browser.newtabpage.activity-stream.telemetry.privatePing.enabled", false);
pref("browser.search.serpEventTelemetryCategorization.enabled", false);
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false);
// Эксперименты и раскатки Nimbus меняют настройки удалённо — выключены
pref("nimbus.rollouts.enabled", false);
pref("nimbus.telemetry.targetingContextEnabled", false);
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

// Диалог условий использования Mozilla не показываем: у Tabora свои условия в онбординге
pref("termsofuse.bypassNotification", true);
pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
pref("browser.newtabpage.activity-stream.showWeather", false);
pref("browser.newtabpage.activity-stream.system.showWeather", false);

// Стартовая страница своя (накладывается на пустую вкладку), страница Firefox не нужна
pref("browser.newtabpage.enabled", false);
pref("browser.startup.page", 1);
pref("browser.startup.homepage", "about:blank");
pref("browser.newtab.preload", false);

// Язык интерфейса: русский. Перевод встроен в сборку (mach package-multi-locale из
// firefox-l10n, бренд Tabora из нашего брендинга), подпись дополнений не снимается.
pref("intl.locale.requested", "ru,en-US");

// Настройки: без разделов Mozilla (управление ИИ, профили Firefox)
pref("browser.preferences.aiControls", false);
pref("browser.profiles.enabled", false);

// Закрытие последней вкладки не закрывает окно: остаётся пустая вкладка
pref("browser.tabs.closeWindowWithLastTab", false);

// Баннеры cookie закрываем сами: отклоняем необязательные (reject | accept | off)
pref("tabora.cookies.banners", "reject");
pref("tabora.cookies.notify", true);
pref("tabora.cookies.handledCount", 0);

// Web3: имя.eth и ipfs:// открываются через публичные шлюзы; оба можно сменить
pref("tabora.web3.ensGateway", "eth.limo");
pref("tabora.web3.ipfsGateway", "dweb.link");

// Кошелёк: автоблокировка (минуты), публичные ноды меняются в настройках кошелька
pref("tabora.wallet.autolockMinutes", 15);

// Сейф: пароли сайтов в Rust-хранилище Firefox под ключом сейфа (без key4.db)
pref("tabora.vault.passwords", true);
pref("signon.storage.rust.enabled", true);

// Аккаунт Tabora: домен почты и сервер (пусто — локальный режим без сервера)
pref("tabora.account.domain", "tabora.app");
pref("tabora.account.server", "");

// Обновления: подписанный манифест цели и update.xml лежат в репозитории GitHub, пакеты —
// в GitHub Releases. Адреса читаются только из настроек по умолчанию (значение пользователя
// не действует) и только https; формат и подпись — docs/UPDATES.md.
pref("tabora.update.manifestUrl", "https://raw.githubusercontent.com/Tabora-App/browser/main/updates/%CHANNEL%/%BUILD_TARGET%/manifest.json");
pref("tabora.update.url", "https://raw.githubusercontent.com/Tabora-App/browser/main/updates/%CHANNEL%/%BUILD_TARGET%/update.xml");
pref("app.update.auto", true);
pref("app.update.staging.enabled", true);
pref("app.update.interval", 3600);

// Перевод страниц: без всплывающего предложения, только по кнопке в адресной строке
pref("browser.translations.automaticallyPopup", false);
