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
// Страница расширений открывается сразу на списке расширений: вводный экран «Рекомендации»
// без самих рекомендаций — это только реклама каталога Mozilla (и упоминание Firefox)
pref("extensions.getAddons.showPane", false);
// «Поделиться идеей или оставить отзыв» в меню помощи: в репозиторий Tabora, а не на сайт Mozilla
pref("app.feedback.baseURL", "https://github.com/Tabora-App/browser/issues/new");
// Сборка идёт без MOZ_DATA_REPORTING (src/browser/moz.configure.patch), поэтому all.js не задаёт
// значения политики отправки данных. Задаём их сами, чтобы код, читающий их без запасного
// значения, не падал; отправка при этом выключена и сборкой, и настройками выше.
pref("datareporting.policy.dataSubmissionPolicyNotifiedTime", "0");
pref("datareporting.policy.dataSubmissionPolicyAcceptedVersion", 0);
pref("datareporting.policy.currentPolicyVersion", 2);
pref("datareporting.policy.minimumPolicyVersion", 1);

// ---- Остальные каналы в Mozilla и Google (второй аудит, раздел «Сборка») ----

// Системные дополнения Mozilla не обновляются: запрос на aus5.mozilla.org/update/3/SystemAddons/
// раскрывал версию, идентификатор сборки, ОС и язык и позволял Mozilla доставить код в браузер.
// Пустой адрес — второй рубеж (XPIInstall.updateSystemAddons выходит, если адреса нет).
pref("extensions.systemAddon.update.enabled", false);
pref("extensions.systemAddon.update.url", "");

// Кодеки OpenH264 и Widevine (DRM-видео) оставлены и обновляются. Запрос списка уходит на
// aus5.mozilla.org раз в сутки; из адреса убрано всё, что отличает Tabora и пользователя
// (идентификатор сборки, язык, версия ОС, дистрибутив): остаются версия движка и платформа, как у
// любого Firefox. Ответ подписан (content signature); при ошибке берётся список, встроенный в
// сборку (toolkit/content/gmp-sources). Сами файлы качаются с ciscobinary.openh264.org и
// серверов Google (для Widevine ещё запрос версии на update.googleapis.com), видны IP и версия.
pref("media.gmp-manager.url", "https://aus5.mozilla.org/update/3/GMP/%VERSION%/20260101000000/%BUILD_TARGET%/en-US/release/default/default/default/update.xml");

// Сообщения и рекомендации Mozilla (ASRouter, CFR, «оцените Firefox»): все источники выключены.
// Каждая настройка — JSON; отсутствующая или пустая читается как «источника нет».
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "{\"id\":\"cfr\",\"enabled\":false,\"type\":\"remote-settings\",\"collection\":\"cfr\"}");
pref("browser.newtabpage.activity-stream.asrouter.providers.message-groups", "{\"id\":\"message-groups\",\"enabled\":false,\"type\":\"remote-settings\",\"collection\":\"message-groups\"}");
pref("browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments", "{\"id\":\"messaging-experiments\",\"enabled\":false,\"type\":\"remote-experiments\"}");
pref("browser.newtabpage.activity-stream.asrouter.providers.onboarding", "{\"id\":\"onboarding\",\"enabled\":false,\"type\":\"local\",\"localProvider\":\"OnboardingMessageProvider\",\"exclude\":[]}");
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);
pref("browser.newtabpage.activity-stream.asrouter.useRemoteL10n", false);
pref("messaging-system.askForFeedback", false);
// Плитки и реклама Mozilla на стартовой странице Firefox (сама страница выключена ниже)
pref("browser.topsites.contile.enabled", false);
pref("browser.newtabpage.activity-stream.discoverystream.enabled", false);
pref("browser.newtabpage.activity-stream.unifiedAds.tiles.enabled", false);
pref("browser.newtabpage.activity-stream.unifiedAds.spocs.enabled", false);
// Подсказки Firefox Suggest и погода через merino.services.mozilla.com
pref("browser.urlbar.quicksuggest.enabled", false);
pref("browser.urlbar.quicksuggest.online.enabled", false);
pref("browser.urlbar.suggest.weather", false);

// Проверка «портала авторизации» (Wi-Fi в гостинице): запрос на firefox-portal-detection.com при
// запуске и смене сети — выключена. Проверка связности IPv4/IPv6 (network.connectivity-service)
// оставлена: по ней движок выбирает семейство адресов и порядок соединений; это запросы
// http://firefox-portal-detection.com/success.txt?ipv4|ipv6 без cookie и идентификаторов (виден IP).
pref("network.captive-portal-service.enabled", false);

// Регион не определяется через location.services.mozilla.com (запрос раскрывал IP, а с включённым
// сканированием и сети Wi-Fi). Без адреса Region.sys.mjs оставляет регион неизвестным: поиск и
// прочее берут конфигурацию «по умолчанию для всех регионов».
pref("browser.region.network.url", "");
pref("browser.region.update.enabled", false);

// UITour: сайты mozilla.org/firefox.com не управляют интерфейсом. Права по умолчанию для этих
// сайтов (uitour, install, remote-troubleshooting) убраны из сборки: src/browser/app/permissions.patch.
pref("browser.uitour.enabled", false);
pref("browser.uitour.url", "");

// Список установленных дополнений не отправляется в AMO (ежедневный запрос метаданных со всеми
// идентификаторами). Обновления дополнений (versioncheck.addons.mozilla.org, по одному запросу
// на дополнение раз в сутки) и блок-лист (Remote Settings) остаются.
pref("extensions.getAddons.cache.enabled", false);

// Поисковые подсказки — функция, оставлены; в приватных окнах запросы поисковику не уходят.
pref("browser.search.suggest.enabled.private", false);

// Оставлено сознательно:
// - Remote Settings (firefox.settings.services.mozilla.com): CRLite, отзыв сертификатов,
//   блок-лист дополнений, конфигурация поиска. Запрос без идентификаторов.
// - Push (dom.push.connection.enabled, wss://push.services.mozilla.com): PushService открывает
//   соединение при запуске независимо от наличия подписок (PushService.sys.mjs: connect()
//   вызывается всегда, по нему же приходят оповещения Remote Settings), сервер видит IP и
//   постоянный идентификатор профиля (UAID). Выключение ломает web push на сайтах.
// - Списки защиты от отслеживания (shavar.services.mozilla.com) и Safe Browsing Google
//   (см. browser.safebrowsing.downloads.remote.enabled, его задаёт tools/build.py по наличию ключа).

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
// По умолчанию вкладки сбоку. Вкладки сверху включаются в «Настройки → Вкладки и просмотр»;
// обе раскладки рисует оболочка (applyTabsLayout в tabora.js).
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

// Язык интерфейса — язык системы: русский, английский, украинский, испанский (любой другой —
// английский). Пустое значение означает «как в системе». Переводы встроены в сборку
// (mach package-multi-locale из firefox-l10n, бренд Tabora из нашего брендинга), подпись
// дополнений не снимается. Надписи Tabora идут за тем же языком: tabora/i18n/I18n.sys.mjs.
pref("intl.locale.requested", "");
// Язык меняется в «Настройки → Языки» из встроенных, после перезапуска: надписи Tabora
// загружаются один раз при запуске. Чужие языковые пакеты не скачиваются.
pref("intl.multilingual.enabled", true);
pref("intl.multilingual.downloadEnabled", false);
pref("intl.multilingual.liveReload", false);
pref("intl.multilingual.aboutWelcome.languageMismatchEnabled", false);

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

// Аккаунт Tabora: домен почты и сервер аккаунтов (пусто — локальный режим без сервера).
// Аккаунт, созданный до появления сервера, подключается к нему из настроек (Account.linkToServer).
pref("tabora.account.domain", "tabora.app");
pref("tabora.account.server", "https://api.tabora.app");

// Почта: системное уведомление о новом письме (выключается в почте, в меню аккаунта).
pref("tabora.mail.notify", true);
// Почта: в пустом поле адреса на сайте предлагать алиас для этого сайта и основной адрес.
pref("tabora.mail.suggest", true);

// Блокировщик рекламы (shield/Shield.sys.mjs): включён; списки фильтров и исключения сайтов
// меняются в настройках приватности и в счётчике заблокированного.
pref("tabora.shield.enabled", true);
pref("tabora.shield.lists", "easylist,ruadlist,easyprivacy,lowe");
pref("tabora.shield.allow", "[]");

// Синхронизация между устройствами аккаунта (sync/Sync.sys.mjs): включена с момента входа в
// аккаунт — данные шифруются на устройстве ключом аккаунта; человек может выключить её целиком
// или отдельные наборы в настройках аккаунта.
pref("tabora.sync.enabled", true);
pref("tabora.sync.passwords", true);
pref("tabora.sync.codes", true);
pref("tabora.sync.bookmarks", true);
pref("tabora.sync.tabs", true);

// Обновления: подписанный манифест цели и update.xml лежат в репозитории GitHub, пакеты —
// в GitHub Releases. Адреса читаются только из настроек по умолчанию (значение пользователя
// не действует) и только https; формат и подпись — docs/UPDATES.md.
pref("tabora.update.manifestUrl", "https://raw.githubusercontent.com/Tabora-App/browser/main/updates/%CHANNEL%/%BUILD_TARGET%/manifest.json");
pref("tabora.update.url", "https://raw.githubusercontent.com/Tabora-App/browser/main/updates/%CHANNEL%/%BUILD_TARGET%/update.xml");
pref("app.update.auto", true);
pref("app.update.staging.enabled", true);
// Проверка обновлений раз в 6 часов (единственное место, где задаётся интервал)
pref("app.update.interval", 21600);

// Перевод страниц: без всплывающего предложения, только по кнопке в адресной строке
pref("browser.translations.automaticallyPopup", false);

// Автоусыпление неактивных вкладок выключено: вкладка не перезагружается при возврате.
// Включается в настройках («Вкладки и просмотр» → «Спящие вкладки»). Выгрузка при нехватке памяти
// (browser.tabs.unloadOnLowMemory) остаётся штатной.
pref("tabora.tabs.sleepAfterMinutes", 0);
