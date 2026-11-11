/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Хранилище почты Tabora. Один экземпляр на процесс: им пользуются страница tabora://mail,
 * окно нового письма в оболочке и агент.
 *
 * Ящики: ящик аккаунта Tabora (доступ выдаёт сервер аккаунтов — пароль приложения этого
 * устройства, см. Account.mailAccess) и любые внешние по IMAP и SMTP (Gmail, свой сервер),
 * добавленные пользователем. Для всех один движок: mail/net/Imap, Smtp, Mime.
 *
 * Интерфейс читает данные синхронно из памяти (messages, aliases), а изменения применяет
 * сразу и ставит в очередь на сервер: флаги, перенос между папками, удаление. Раз в несколько
 * минут и по запросу папки сверяются с сервером: в памяти держится окно последних писем каждой
 * папки. Если операция на сервере не удалась, сообщается ошибка и запускается сверка —
 * истина всегда на сервере.
 *
 * Почта доступна только после входа в аккаунт Tabora и при разблокированном сейфе: кэш писем
 * и пароли внешних ящиков лежат в профиле (tabora-mail.json) зашифрованными подключом сейфа
 * "mail" (AES-GCM); при выходе из аккаунта или блокировке сейфа данные в памяти сбрасываются.
 * Об изменениях модуль сообщает через Services.obs "tabora-mail-changed".
 *
 * Письма OpenPGP (mail/Pgp.sys.mjs): зашифрованное письмо расшифровывается после получения, в
 * кэше лежит уже его содержимое (кэш зашифрован сейфом), запись помечается pgp: { encrypted,
 * signature, signer } либо pgp: { encrypted, error }. Письмо с адреса аккаунта можно отправить
 * зашифрованным, если известны ключи всех получателей; свои письма несут ключ в заголовке
 * Autocrypt, ключи собеседников берутся оттуда же. */

const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
const { Account } = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ImapClient: "chrome://tabora/content/mail/net/Imap.sys.mjs",
  smtpSend: "chrome://tabora/content/mail/net/Smtp.sys.mjs",
  Pgp: "chrome://tabora/content/mail/Pgp.sys.mjs",
  MailView: "chrome://tabora/content/mail/MailView.sys.mjs",
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "Mime", () => ChromeUtils.importESModule("chrome://tabora/content/mail/net/Mime.sys.mjs"));

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-mail.json");
const FORMAT = 4; // файл: { v: 4, enc: { iv, ct } }
const DATA = 5; // данные внутри: { v: 5, accounts, messages, aliases }
const ROLES = ["inbox", "sent", "drafts", "archive", "spam", "trash"];
const WINDOW = { inbox: 80, sent: 40, drafts: 20, archive: 40, spam: 30, trash: 30 };
const FETCH_BYTES = 262_144; // от каждого письма читается начало: заголовки и текст; вложения — по запросу
const HTML_FETCH_BYTES = 1_048_576; // письмо, открытое до появления показа с вёрсткой, дочитывается за ней
const SYNC_EVERY_MS = 3 * 60_000;
const WRITE_GAP_MS = 2000;
const NOTIFY_PREF = "tabora.mail.notify"; // сообщать о новых письмах системным уведомлением
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const TABORA = "tabora"; // id ящика аккаунта
const CODE_RULES = 2; // версия правил распознавания кода: при смене коды в кэше пересчитываются

export const SPACES = ["Личное", "Работа", "Проекты"];
export const SPACE_COLORS = { Личное: "#c8f25a", Работа: "#7cc4ff", Проекты: "#ff9f5a" };

/** Настройки известных почтовых служб. note — что сказать пользователю про пароль. */
const PRESETS = [
  { domains: ["gmail.com", "googlemail.com"], imap: ["imap.gmail.com", 993], smtp: ["smtp.gmail.com", 465], savesSent: true, note: "Gmail пускает почтовые программы только по паролю приложения. Включите двухэтапную проверку и создайте пароль на myaccount.google.com/apppasswords" },
  { domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"], imap: ["outlook.office365.com", 993], smtp: ["smtp-mail.outlook.com", 587], note: "Outlook может потребовать пароль приложения: account.microsoft.com → Безопасность" },
  { domains: ["yahoo.com", "ymail.com"], imap: ["imap.mail.yahoo.com", 993], smtp: ["smtp.mail.yahoo.com", 465], note: "Yahoo требует пароль приложения: Account security → Generate app password" },
  { domains: ["icloud.com", "me.com", "mac.com"], imap: ["imap.mail.me.com", 993], smtp: ["smtp.mail.me.com", 587], note: "iCloud требует пароль приложения: account.apple.com → Вход и безопасность" },
  { domains: ["yandex.ru", "ya.ru", "yandex.com", "yandex.by", "yandex.kz"], imap: ["imap.yandex.ru", 993], smtp: ["smtp.yandex.ru", 465], note: "Яндекс требует пароль приложения: id.yandex.ru → Безопасность → Пароли приложений" },
  { domains: ["mail.ru", "bk.ru", "list.ru", "inbox.ru", "internet.ru"], imap: ["imap.mail.ru", 993], smtp: ["smtp.mail.ru", 465], note: "Mail.ru требует пароль для внешних приложений: Настройки → Безопасность" },
  { domains: ["fastmail.com", "fastmail.fm"], imap: ["imap.fastmail.com", 993], smtp: ["smtp.fastmail.com", 465], note: "Fastmail требует пароль приложения: Settings → Privacy & Security" },
  { domains: ["gmx.com", "gmx.net", "gmx.de"], imap: ["imap.gmx.com", 993], smtp: ["mail.gmx.com", 465] },
  { domains: ["zoho.com", "zohomail.com"], imap: ["imap.zoho.com", 993], smtp: ["smtp.zoho.com", 465] },
];

function accessError(code) {
  const text = code === "signed-out" ? "Почта доступна после входа в аккаунт Tabora" : "Сейф заблокирован: разблокируйте его, чтобы открыть почту";
  return Object.assign(new Error(text), { code });
}

/** Пауза до свободной минуты главного потока (не дольше 40 мс): длинная работа режется на куски,
 * чтобы не задерживать отрисовку и прокрутку. */
function breathe() {
  return new Promise(resolve => ChromeUtils.idleDispatch(resolve, { timeout: 40 }));
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const security = port => (Number(port) === 993 || Number(port) === 465 ? "tls" : "starttls");
const server = ([host, port]) => ({ host, port, security: security(port) });

/** Доступ к данным ящика Tabora и ACCOUNT прежнего интерфейса: адрес берётся из аккаунта. */
export const ACCOUNT = {
  get address() {
    return MailStore.primaryAddress;
  },
  get domain() {
    return Account.domain;
  },
};

export const MailStore = {
  TOPIC: "tabora-mail-changed",
  data: null,
  syncing: false,
  lastError: null,
  _loading: null,
  _writing: Promise.resolve(),
  _observing: false,
  _ops: Promise.resolve(),
  _syncTimer: null,
  _syncRun: null,
  _seq: 0,

  /** Есть ли доступ к почте прямо сейчас: вход выполнен и данные загружены. */
  get available() {
    return !!this.data && Account.signedIn && Vault.unlocked;
  },

  _observe() {
    if (this._observing) {
      return;
    }
    this._observing = true;
    lazy.AsyncShutdown.profileBeforeChange.addBlocker("Tabora: запись кэша почты", () => this.flush());
    Services.obs.addObserver((s, t, what) => {
      if (what === "signed-out") {
        this.forget();
      } else if (what === "signed-in" && this.data) {
        this.syncSoon(200); // после входа или подключения к серверу появился ящик аккаунта
      } else if (what === "signed-in" && this._started) {
        this.ready().catch(() => {});
      }
    }, Account.TOPIC);
    Services.obs.addObserver((s, t, what) => {
      if (what === "locked" || what === "reset") {
        this.forget();
      } else if (what === "unlocked" && this._started && !this.data) {
        this.ready().catch(() => {});
      }
    }, Vault.TOPIC);
    // связь вернулась или компьютер проснулся: соединения, ждавшие письма, уже мертвы
    const revive = () => {
      if (this.data) {
        this._stopWatching();
        this.syncSoon(1500);
      }
    };
    Services.obs.addObserver(revive, "wake_notification");
    Services.obs.addObserver((s, t, state) => state === "up" && revive(), "network:link-status-changed");
    Services.obs.addObserver((s, t, what) => {
      if (what === "own" && this.data) {
        this._retryDecrypt(); // ключ аккаунта появился или сменился: не открывшиеся письма пробуем снова
      }
    }, "tabora-pgp-changed");
  },

  /** Письма, которые не удалось расшифровать, расшифровываются заново (не больше сорока самых
   * свежих за раз, по очереди). */
  _retryDecrypt() {
    const list = this.data.messages.filter(m => m.pgp?.error && m.at?.uid).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
    this._pgpQueue = (this._pgpQueue || Promise.resolve()).then(async () => {
      for (const rec of list) {
        if (!this.data || !this.data.messages.includes(rec)) {
          return;
        }
        try {
          await this._decryptFull(rec);
        } catch (e) {
          this._pgpFailed(rec, e);
        }
      }
      if (this.data && list.length) {
        this.save({ soon: true });
      }
    });
  },

  /** Запуск из оболочки при открытии окна: почта работает с запуска браузера, а не с открытия
   * своей страницы — иначе о новом письме не узнать, пока её не откроешь. Без входа в аккаунт
   * ничего не происходит: загрузка начнётся после входа. */
  start() {
    this._started = true;
    this._observe();
    this.ready().catch(() => {});
  },

  /** Загружает данные один раз. Без входа в аккаунт или с заблокированным сейфом отклоняется
   * с кодом "signed-out" или "vault-locked". Сейф здесь открывается только тихо: после явной
   * блокировки нужна разблокировка пользователем. */
  async ready() {
    this._observe();
    await Account.ready();
    if (!Account.signedIn) {
      throw accessError("signed-out");
    }
    if (this.data && Vault.unlocked) {
      return;
    }
    if (!this._loading) {
      this._loading = this._load().finally(() => {
        this._loading = null;
      });
    }
    await this._loading;
  },

  async _load() {
    await Vault.ready();
    if (!Vault.unlocked && Vault.exists) {
      await Vault.unlock();
    }
    if (!Vault.unlocked) {
      throw accessError("vault-locked");
    }
    let data = null;
    try {
      const raw = await IOUtils.readJSON(FILE());
      if (raw?.v === FORMAT && raw.enc) {
        const bytes = await Vault.decrypt("mail", raw.enc);
        data = JSON.parse(new TextDecoder().decode(bytes));
        bytes.fill(0);
      }
    } catch (e) {
      if (e.name !== "NotFoundError") {
        console.error("Tabora mail: кэш не читается, начинаем заново", e);
      }
    }
    // прежний кэш (v: 3) хранил демонстрационные письма: настоящая почта начинается с пустого
    if (data?.v !== DATA || !Array.isArray(data.messages) || !Array.isArray(data.accounts)) {
      data = { v: DATA, accounts: [], messages: [], aliases: [] };
    }
    if (!Account.signedIn) {
      throw accessError("signed-out");
    }
    if (!Vault.unlocked) {
      throw accessError("vault-locked");
    }
    // ящик аккаунта привязан к адресу: после входа в другой аккаунт прежние письма не показываем
    const mine = data.accounts.find(a => a.id === TABORA);
    if (mine && mine.address !== Account.email) {
      data.accounts = data.accounts.filter(a => a.id !== TABORA);
      data.messages = data.messages.filter(m => m.account !== TABORA);
      data.aliases = [];
    }
    if (data.codeRules !== CODE_RULES) {
      data.messages.forEach(m => this._recode(m));
      data.codeRules = CODE_RULES;
    }
    this.data = data;
    this._seq = data.messages.reduce((n, m) => (/^m\d+$/.test(m.id) ? Math.max(n, Number(m.id.slice(1))) : n), 0);
    this.syncSoon(0);
  },

  /** Код подтверждения записи пересчитывается по сохранённому тексту: правила распознавания
   * менялись, а письма в кэше разобраны по прежним. */
  _recode(rec) {
    const blocks = rec.body || [];
    const outgoing = rec.local || rec.folder === "sent" || rec.folder === "drafts";
    const text = blocks.map(b => b.h || b.p || b.q || b.btn || b.code || "").filter(Boolean).join("\n");
    const code = outgoing ? null : lazy.Mime.findCode(rec.subject, text);
    blocks.forEach((b, i) => {
      if (b.code && b.code !== code) {
        blocks[i] = { p: b.code };
      }
    });
    rec.labels = (rec.labels || []).filter(l => l !== "codes");
    if (code) {
      rec.code = code;
      rec.labels.push("codes");
    } else {
      delete rec.code;
    }
  },

  /** Запись кэша на диск. Кэш шифруется целиком: на большом ящике это десятки миллисекунд
   * главного потока, поэтому изменения, которые сервер помнит и сам (сверка, пометки,
   * расшифровка), пишутся одним разом не чаще раза в WRITE_GAP_MS. То, что есть только здесь
   * (черновики, внешние ящики), пишется сразу: _writeNow(). */
  _write() {
    this._writeTimer ||= setTimeout(() => this._writeNow(), WRITE_GAP_MS);
  },

  /** Снимок данных шифруется сразу (ключ сейфа берётся в момент вызова, так что запись успевает
   * и перед выходом из аккаунта), сама запись в файл встаёт в очередь: две одновременные не
   * должны делить временный файл. */
  _writeNow() {
    clearTimeout(this._writeTimer);
    this._writeTimer = null;
    if (!this.data || !Vault.unlocked) {
      return this._writing;
    }
    let enc;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(this.data));
      enc = Vault.encrypt("mail", bytes).finally(() => bytes.fill(0));
    } catch (e) {
      console.error("Tabora mail: не удалось сохранить", e);
      return this._writing;
    }
    enc.catch(() => {}); // ошибка шифрования сообщается ниже, из очереди записи
    this._writing = this._writing
      .then(async () => {
        await IOUtils.writeJSON(FILE(), { v: FORMAT, enc: await enc }, { tmpPath: `${FILE()}.tmp` });
        try {
          await IOUtils.setPermissions(FILE(), 0o600);
        } catch (e) {}
      })
      .catch(e => console.error("Tabora mail: не удалось сохранить", e));
    return this._writing;
  },

  /** Дождаться, пока всё изменённое окажется на диске (закрытие браузера, проверки). */
  flush() {
    return this._writeTimer ? this._writeNow() : this._writing;
  },

  /** Выход из аккаунта или блокировка сейфа: данные в памяти больше не держим. */
  forget() {
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    if (this._writeTimer) {
      this._writeNow(); // при выходе из аккаунта ключ сейфа ещё в памяти; после блокировки писать нечем
    }
    this._stopWatching();
    lazy.MailView.forget();
    if (this.data) {
      this.data = null;
      Services.obs.notifyObservers(null, this.TOPIC, "closed");
    }
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  /** Данные изменились: записать и сообщить интерфейсу. soon: true — изменение не страшно
   * потерять (сервер его помнит), запись можно отложить и объединить с соседними. */
  save({ soon = false } = {}) {
    if (!this.data) {
      return;
    }
    if (soon) {
      this._write();
    } else {
      this._writeNow();
    }
    this.notify();
  },

  _fail(error, where) {
    this.lastError = { message: error?.message || String(error), code: error?.code || "", where, at: Date.now() };
    console.error(`Tabora mail: ${where}`, error);
    this.notify("error");
  },

  /* ---- чтение ----------------------------------------------------------------------- */

  get messages() { return this.data?.messages || []; },
  get aliases() { return this.data?.aliases || []; },
  byId(id) { return this.messages.find(m => m.id === id); },
  thread(threadId) {
    return this.messages.filter(m => m.thread === threadId && m.folder !== "trash").sort((a, b) => a.date.localeCompare(b.date));
  },
  unreadInbox() {
    return this.messages.filter(m => m.folder === "inbox" && m.unread).length;
  },

  /** Ящики без паролей: [{ id, kind, address, name, error, syncedAt }]. Первым — ящик аккаунта. */
  get accounts() {
    return (this.data?.accounts || []).map(a => ({ id: a.id, kind: a.kind, address: a.address, name: a.name || a.address, error: a.error || null, syncedAt: a.syncedAt || 0 }));
  },

  /** Адрес, с которого пишут по умолчанию: ящик аккаунта, иначе первый внешний. */
  get primaryAddress() {
    const list = this.data?.accounts || [];
    return (list.find(a => a.id === TABORA) || list[0])?.address || Account.email || "";
  },

  /** Все адреса, с которых можно отправлять: [{ address, account, note }]. */
  senders() {
    const out = [];
    for (const a of this.data?.accounts || []) {
      out.push({ address: a.address, account: a.id, note: a.kind === TABORA ? "ящик Tabora" : "внешний ящик" });
      if (a.id === TABORA) {
        for (const al of this.aliases.filter(x => x.on)) {
          out.push({ address: al.address, account: a.id, note: al.site });
        }
      }
    }
    return out;
  },

  /* ---- ящики -------------------------------------------------------------------------- */

  _acc(id) {
    return this.data?.accounts.find(a => a.id === id) || null;
  },

  /** Ящик аккаунта Tabora появляется сам, когда сервер выдал доступ, и исчезает без него. */
  async _ensureTabora() {
    const access = await Account.mailAccess().catch(e => {
      if (e.code !== "offline") {
        console.error("Tabora mail: доступ к ящику аккаунта не получен", e);
      }
      return undefined; // нет связи: оставляем как есть
    });
    if (access === undefined) {
      return;
    }
    const have = this._acc(TABORA);
    if (!access) {
      return; // локальный режим или аккаунт не подключён к серверу
    }
    if (!have) {
      this.data.accounts.unshift({ id: TABORA, kind: TABORA, address: access.address, name: access.address.split("@")[0], folders: {}, state: {} });
    }
  },

  async _creds(acc) {
    if (acc.id === TABORA) {
      const a = await Account.mailAccess();
      if (!a) {
        throw Object.assign(new Error("Нет доступа к ящику аккаунта: войдите в аккаунт заново"), { code: "auth" });
      }
      return { imap: a.imap, smtp: a.smtp, login: a.login, password: a.password };
    }
    return { imap: acc.imap, smtp: acc.smtp, login: acc.login, password: acc.password };
  },

  /** Соединение IMAP с ящиком. Для ящика аккаунта отказ во входе лечится новым паролем приложения. */
  async _connect(acc) {
    const creds = await this._creds(acc);
    try {
      return await lazy.ImapClient.connect(creds.imap, { login: creds.login, password: creds.password });
    } catch (e) {
      if (e.code === "auth" && acc.id === TABORA) {
        const fresh = await Account.mailAccess({ refresh: true });
        if (fresh) {
          return lazy.ImapClient.connect(fresh.imap, { login: fresh.login, password: fresh.password });
        }
      }
      throw e;
    }
  },

  /** Подсказка настроек по адресу: известные службы, затем автонастройка домена (только у
   * самого домена, без сторонних справочников), затем обычные имена серверов. */
  async guessSettings(address) {
    const domain = String(address).trim().toLowerCase().split("@")[1] || "";
    if (!domain) {
      return null;
    }
    const preset = PRESETS.find(p => p.domains.includes(domain));
    if (preset) {
      return { imap: server(preset.imap), smtp: server(preset.smtp), note: preset.note || "", source: "preset" };
    }
    for (const url of [`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address)}`, `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`]) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(url, { credentials: "omit", redirect: "follow", signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (!res.ok) {
          continue;
        }
        const xml = await res.text();
        const pick = (tag, type) => {
          const m = new RegExp(`<${tag}Server[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${tag}Server>`, "i").exec(xml);
          if (!m) {
            return null;
          }
          const host = /<hostname>([^<]+)<\/hostname>/i.exec(m[1])?.[1]?.trim();
          const port = Number(/<port>(\d+)<\/port>/i.exec(m[1])?.[1]);
          const socket = /<socketType>([^<]+)<\/socketType>/i.exec(m[1])?.[1]?.trim().toUpperCase();
          return host && port ? { host, port, security: socket === "SSL" ? "tls" : "starttls" } : null;
        };
        const imap = pick("incoming", "imap");
        const smtp = pick("outgoing", "smtp");
        if (imap && smtp) {
          return { imap, smtp, note: "", source: "autoconfig" };
        }
      } catch (e) {}
    }
    return { imap: server([`imap.${domain}`, 993]), smtp: server([`smtp.${domain}`, 465]), note: "", source: "guess" };
  },

  /** Добавить внешний ящик: сначала проверяется вход по IMAP, затем ящик сохраняется (пароль —
   * в зашифрованном кэше почты) и сверяется. settings: { address, password, name?, login?, imap, smtp }. */
  async addAccount(settings) {
    await this.ready();
    const address = String(settings.address || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      throw new Error("Проверьте адрес почты");
    }
    if (!settings.password) {
      throw new Error("Введите пароль");
    }
    if (this.data.accounts.some(a => a.address === address)) {
      throw new Error("Этот ящик уже добавлен");
    }
    const clean = s => ({ host: String(s?.host || "").trim().toLowerCase(), port: Number(s?.port) || 0, security: s?.security === "starttls" ? "starttls" : s?.security === "tls" ? "tls" : security(s?.port) });
    const imap = clean(settings.imap);
    const smtp = clean(settings.smtp);
    for (const s of [imap, smtp]) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s.host) || s.port < 1 || s.port > 65535) {
        throw new Error("Проверьте адреса и порты серверов");
      }
    }
    const login = String(settings.login || address).trim();
    const client = await lazy.ImapClient.connect(imap, { login, password: settings.password });
    await client.logout();
    const preset = PRESETS.find(p => p.domains.includes(address.split("@")[1]));
    const acc = {
      id: `x${Date.now().toString(36)}`, kind: "imap", address, name: String(settings.name || "").trim() || address.split("@")[0],
      login, password: settings.password, imap, smtp, savesSent: !!preset?.savesSent, folders: {}, state: {},
    };
    this.data.accounts.push(acc);
    this.save();
    this.syncSoon(0);
    return { id: acc.id, address };
  },

  async removeAccount(id) {
    await this.ready();
    if (id === TABORA) {
      throw new Error("Ящик аккаунта отключается выходом из аккаунта");
    }
    this.data.accounts = this.data.accounts.filter(a => a.id !== id);
    this.data.messages = this.data.messages.filter(m => m.account !== id);
    this.save();
  },

  /* ---- сверка с сервером ---------------------------------------------------------------- */

  syncSoon(delayMs = 0) {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      if (this._syncRun) {
        this._syncAgain = true; // сверка уже идёт и могла пройти нужную папку: повторим после неё
      } else {
        this.sync().catch(() => {});
      }
    }, delayMs);
  },

  /** Сверить все ящики. Повторный вызов во время сверки ждёт её конца. */
  sync() {
    if (!this._syncRun) {
      this._syncRun = this._sync().finally(() => {
        this._syncRun = null;
      });
    }
    return this._syncRun;
  },

  async _sync() {
    if (!this.available) {
      return;
    }
    clearTimeout(this._syncTimer);
    this.syncing = true;
    this.notify("sync");
    try {
      await this._ensureTabora();
      await this._ops; // сначала уходят изменения пользователя
      for (const acc of [...(this.data?.accounts || [])]) {
        if (!this.available) {
          return;
        }
        try {
          await this._syncAccount(acc);
          acc.error = null;
          acc.syncedAt = Date.now();
        } catch (e) {
          acc.error = e.message || String(e);
          this._fail(e, `сверка ящика ${acc.address}`);
        }
      }
      if (this.data) {
        this._countAliases();
        this._write();
        this._sweepHtml();
        this._watchAll();
        this._announce();
      }
    } finally {
      this.syncing = false;
      if (this.data) {
        this.notify();
        const again = this._syncAgain;
        this._syncAgain = false;
        this._syncTimer = setTimeout(() => this.sync().catch(() => {}), again ? 100 : SYNC_EVERY_MS);
      }
    }
  },

  /* ---- новые письма: ожидание и уведомление ------------------------------------------------ */

  /** У каждого ящика своё соединение, которое ждёт писем во «Входящих» (IMAP IDLE): сервер сам
   * сообщает о новом письме, и сверка запускается сразу, а не по расписанию. */
  _watchAll() {
    this._watchers ||= new Map();
    const ids = new Set(this.data.accounts.map(a => a.id));
    for (const [id, w] of this._watchers) {
      if (!ids.has(id)) {
        w.stop();
        this._watchers.delete(id);
      }
    }
    for (const acc of this.data.accounts) {
      if (!this._watchers.has(acc.id) && !acc.error) {
        this._watchers.set(acc.id, this._watch(acc));
      }
    }
  },

  _stopWatching() {
    for (const w of this._watchers?.values() || []) {
      w.stop();
    }
    this._watchers?.clear();
  },

  _watch(acc) {
    let stopped = false;
    let client = null;
    let timer = null;
    let wake = null;
    const run = async () => {
      let delay = 5000;
      while (!stopped && this.data && this._acc(acc.id)) {
        try {
          client = await this._connect(acc);
          if (!client.canIdle) {
            await client.logout(); // сервер ждать не умеет: остаётся сверка по расписанию
            return;
          }
          await client.select(acc.folders?.inbox || "INBOX");
          delay = 5000;
          while (!stopped) {
            const why = await client.idle();
            if (why === "exists") {
              this.syncSoon(150);
            } else if (why === "changed") {
              this.syncSoon(1500);
            } else if (why === "stopped") {
              break;
            }
          }
        } catch (e) {
          // связь пропала или сервер закрыл соединение: пробуем снова, всё реже
        } finally {
          client?.close();
          client = null;
        }
        if (stopped) {
          return;
        }
        await new Promise(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, delay);
        });
        delay = Math.min(delay * 2, 5 * 60_000);
      }
    };
    run();
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
        wake?.();
        client?.stopIdle();
        client?.close();
      },
    };
  },

  /** Системное уведомление о письмах, пришедших при этой сверке. Одно письмо — отправитель и
   * тема (текст письма в уведомление не попадает: его видно на заблокированном экране),
   * несколько — их число и отправители. Щелчок открывает письмо. */
  _announce() {
    const fresh = (this._fresh || []).filter(m => this.data.messages.includes(m) && m.unread && m.folder === "inbox");
    this._fresh = [];
    if (!fresh.length || !Services.prefs.getBoolPref(NOTIFY_PREF, true)) {
      return;
    }
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (win && Services.focus.activeWindow === win && win.Tabora?.isMailUrl(win.gBrowser?.selectedBrowser?.currentURI?.spec)) {
      return; // почта и так перед глазами
    }
    const one = fresh.length === 1 ? fresh[0] : null;
    const names = [...new Set(fresh.map(m => m.from?.name || m.from?.email).filter(Boolean))];
    const title = one ? one.from?.name || one.from?.email || "Новое письмо" : `Новых писем: ${fresh.length}`;
    const text = one ? one.subject || "(без темы)" : `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` и ещё ${names.length - 3}` : ""}`;
    const thread = one ? one.thread : "";
    this._alert(title.slice(0, 120), text.slice(0, 240), () => {
      const target = lazy.BrowserWindowTracker.getTopWindow();
      if (target?.Tabora) {
        target.focus();
        target.Tabora.openMail(thread && this.thread(thread).length ? `msg/${thread}` : "");
      }
    });
  },

  /** Системное уведомление (центр уведомлений macOS, Windows или среды Linux). */
  _alert(title, text, onClick) {
    try {
      const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
      alert.init(`tabora-mail-${Date.now()}`, "", title, text, true);
      Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).showAlert(alert, (subject, topic) => {
        if (topic === "alertclickcallback") {
          onClick();
        }
      });
    } catch (e) {
      console.error("Tabora mail: уведомление не показано", e);
    }
  },


  async _syncAccount(acc) {
    if (acc.id === TABORA) {
      await this._syncAliases();
    }
    const client = await this._connect(acc);
    try {
      const folders = await client.list();
      const map = {};
      for (const role of ROLES) {
        const hit = folders.find(f => f.role === role && !f.noselect) || (role === "archive" ? folders.find(f => f.role === "all" && !f.noselect) : null);
        if (hit) {
          map[role] = hit.path;
        }
      }
      acc.folders = map;
      acc.state ||= {};
      for (const role of ROLES) {
        if (map[role] && this.data) {
          await this._syncFolder(acc, client, role, map[role]);
        }
      }
    } finally {
      await client.logout();
    }
  },

  async _syncFolder(acc, client, role, path) {
    const box = await client.select(path);
    const st = (acc.state[role] ||= {});
    const mine = () => this.data.messages.filter(m => m.account === acc.id && m.at?.role === role);
    if (st.uidValidity && st.uidValidity !== box.uidValidity) {
      // сервер пересоздал папку: прежние номера писем ничего не значат
      const drop = new Set(mine().map(m => m.id));
      this.data.messages = this.data.messages.filter(m => !drop.has(m.id));
    }
    if (st.uidValidity !== box.uidValidity) {
      delete st.seen;
    }
    st.uidValidity = box.uidValidity;
    const win = await client.window(WINDOW[role] || 40);
    // О письмах с номером больше уже виденного сообщается уведомлением (_announce). При первой
    // сверке ящика уведомлять не о чем: все письма в нём «старые».
    const top = win.length ? win[win.length - 1].uid : 0;
    const announced = role === "inbox" ? st.seen : undefined;
    if (role === "inbox") {
      st.seen = Math.max(st.seen || 0, top);
    }
    const have = new Map(mine().map(m => [m.at.uid, m]));
    const seen = new Set();
    const need = [];
    for (const w of win) {
      seen.add(w.uid);
      const rec = have.get(w.uid);
      if (rec) {
        if (!rec.busy) {
          this._applyFlags(rec, w.flags, role);
        }
      } else {
        need.push(w.uid);
      }
    }
    // в памяти держится только окно: чего в нём нет, того на сервере нет (или оно старше окна).
    // Запись без номера (перенесена, а сервер номер не сообщил) ждёт своё письмо две минуты.
    const gone = new Set(mine().filter(m => !m.busy && (m.at.uid ? !seen.has(m.at.uid) : Date.now() - (m.at.since || 0) > 120_000)).map(m => m.id));
    if (gone.size) {
      this.data.messages = this.data.messages.filter(m => !gone.has(m.id));
    }
    for (let i = 0; i < need.length && this.data; i += 12) {
      const items = await client.fetch(need.slice(i, i + 12), { maxBytes: FETCH_BYTES });
      for (const item of items) {
        // разбор письма занимает главный поток: между письмами отдаём его интерфейсу и страницам
        await breathe();
        if (!this.data) {
          return;
        }
        const rec = this._record(acc, role, path, box.uidValidity, item);
        if (rec) {
          this._adopt(rec);
          if (announced !== undefined && item.uid > announced && rec.unread) {
            (this._fresh ||= []).push(rec);
          }
          if (rec._autocrypt) {
            // сначала ключ отправителя из заголовка: им же проверяется подпись этого письма
            await lazy.Pgp.noteAutocrypt(rec.from.email, rec._autocrypt, rec.date);
          }
          this._openPgp(rec);
        }
      }
      if (this.data && need.length > 12) {
        this.notify(); // длинная первая загрузка: письма появляются по мере чтения
      }
    }
  },

  _applyFlags(rec, flags, role) {
    const f = new Set((flags || []).map(x => String(x).toLowerCase()));
    rec.unread = !f.has("\\seen") && role !== "sent" && role !== "drafts";
    rec.starred = f.has("\\flagged");
  },

  /** Письмо с сервера → запись хранилища. */
  _record(acc, role, path, uidValidity, item) {
    let parsed;
    try {
      parsed = lazy.Mime.parseMessage(item.raw || "");
    } catch (e) {
      console.error("Tabora mail: письмо не разобрано", e);
      return null;
    }
    const { body, snippet, code } = lazy.Mime.toBlocks(parsed);
    const root = parsed.references[0] || parsed.inReplyTo || parsed.messageId || `${parsed.subject}|${parsed.from.email}`;
    const outgoing = role === "sent" || role === "drafts";
    const own = new Set([acc.address, ...(acc.id === TABORA ? this.aliases.map(a => a.address) : [])]);
    const domain = acc.id === TABORA ? `@${Account.domain}` : null;
    const rcpt = [...parsed.deliveredTo, ...parsed.to, ...parsed.cc];
    const alias = outgoing ? parsed.from.email || acc.address : rcpt.find(a => own.has(a)) || (domain && rcpt.find(a => a.endsWith(domain))) || acc.address;
    const labels = [];
    const found = outgoing ? null : code; // в своих письмах код искать незачем
    if (found) {
      labels.push("codes");
    }
    if (parsed.newsletter) {
      labels.push("news");
    }
    const rec = {
      id: "", account: acc.id, thread: `t${hash(`${acc.id}|${root}`)}`, folder: role,
      at: { role, path, uid: item.uid, uidValidity },
      unread: false, starred: false, labels,
      from: outgoing ? { name: "Я", email: parsed.from.email || acc.address } : parsed.from,
      to: parsed.to.length ? parsed.to : [acc.address], cc: parsed.cc, replyTo: parsed.replyTo || "",
      alias, date: parsed.date || new Date().toISOString(), subject: parsed.subject,
      messageId: parsed.messageId, refs: [...parsed.references, parsed.inReplyTo].filter(Boolean).slice(-12),
      body, snippet, attachments: parsed.attachments, size: item.size || 0, partial: (item.size || 0) > FETCH_BYTES,
    };
    if (found) {
      rec.code = found;
    }
    if (parsed.newsletter) {
      rec.newsletter = true;
    }
    if (role === "drafts") {
      rec.draft = true;
    }
    if (parsed.images) {
      rec.images = parsed.images;
    }
    if (parsed.pgp) {
      // расшифровка и проверка подписи идут следом (_openPgp); исходные данные для них в запись
      // на диске не попадают
      Object.defineProperty(rec, "_pgp", { value: parsed.pgp, enumerable: false, writable: true });
      if (parsed.pgp.kind !== "signed") {
        rec.pgp = { encrypted: true, pending: true };
        rec.body = [{ p: "Письмо зашифровано. Расшифровываем…" }];
        rec.snippet = "Зашифрованное письмо";
        rec.attachments = [];
      }
    }
    if (parsed.autocrypt && role === "inbox") {
      Object.defineProperty(rec, "_autocrypt", { value: parsed.autocrypt, enumerable: false });
    }
    if (!parsed.pgp || parsed.pgp.kind === "signed") {
      this._keepHtml(rec, parsed);
    }
    this._applyFlags(rec, item.flags, role);
    return rec;
  },

  /* ---- письмо с вёрсткой ---------------------------------------------------------------- */

  /** Разметка письма (если это письмо с вёрсткой) сохраняется в свой кэш, в записи остаётся
   * имя: html. Простое письмо показывается блоками, у него стоит noHtml. */
  _keepHtml(rec, part) {
    if (part.html && lazy.MailView.rich(part.html)) {
      rec.html = lazy.MailView.newToken();
      delete rec.noHtml;
      lazy.MailView.put(rec.html, lazy.MailView.embedInline(part.html, part.inline));
    } else {
      delete rec.html;
      rec.noHtml = true;
    }
  },

  /** Разметка письма для показа: из кэша, а для письма, полученного до появления показа с
   * вёрсткой (или после смены ключа сейфа), — заново с сервера. null — у письма её нет. */
  async loadHtml(id) {
    await this.ready();
    const rec = this.byId(id);
    if (!rec || rec.noHtml || rec.pgp?.error || rec.pgp?.pending) {
      return null;
    }
    if (rec.html) {
      const html = await lazy.MailView.get(rec.html);
      if (html) {
        return html;
      }
      delete rec.html; // запись кэша пропала: читаем письмо заново
    }
    if (rec.local || !rec.at?.uid) {
      return null;
    }
    if (!this._htmlJobs) {
      this._htmlJobs = new Map();
    }
    if (!this._htmlJobs.has(id)) {
      this._htmlJobs.set(id, this._fetchHtml(rec).finally(() => this._htmlJobs.delete(id)));
    }
    return this._htmlJobs.get(id);
  },

  async _fetchHtml(rec) {
    let part = null;
    try {
      if (rec.pgp?.encrypted) {
        const { kind, bytes } = await this._fetchDecrypted(rec);
        if (kind !== "inline") {
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          part = lazy.Mime.parseEntity(bin);
        }
      } else {
        let raw = "";
        await this._ops;
        await this._withFolder(rec, async client => {
          raw = (await client.fetch([rec.at.uid], { maxBytes: HTML_FETCH_BYTES }))[0]?.raw || "";
        });
        part = raw ? lazy.Mime.parseMessage(raw) : null;
      }
    } catch (e) {
      console.error("Tabora mail: вёрстка письма не получена", e);
      return null; // связи нет или письмо уже не на сервере: в следующий раз попробуем снова
    }
    if (!this.data || !this.data.messages.includes(rec)) {
      return null;
    }
    this._keepHtml(rec, part || {});
    this.save({ soon: true });
    return rec.html ? lazy.MailView.embedInline(part.html, part.inline) : null;
  },

  /** Документ письма для показа в отдельном процессе: { url, remote } или null (см. MailView). */
  async htmlDocument(id, { images = false } = {}) {
    const html = await this.loadHtml(id);
    return html ? lazy.MailView.document(html, { images }) : null;
  },

  /** Записи кэша вёрстки, на которые не ссылается ни одно письмо, убираются. */
  _sweepHtml() {
    if (this.data) {
      lazy.MailView.sweep(new Set(this.data.messages.map(m => m.html).filter(Boolean)));
    }
  },

  /* ---- OpenPGP: расшифровка, подписи, ключи собеседников ------------------------------------ */

  /** Адрес, чьим ключом должна быть подписана запись: у своих писем — свой адрес. */
  _pgpSender(rec) {
    return rec.folder === "sent" || rec.folder === "drafts" ? rec.alias || this._acc(rec.account)?.address || "" : rec.from?.email || "";
  },

  /** Содержимое зашифрованного письма → поля записи. bytes — расшифрованная часть письма. */
  async _applyDecrypted(rec, kind, bytes, signature) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    // письмо без PGP/MIME: внутри просто текст
    const part = kind === "inline" ? { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), html: "", attachments: [], images: 0, pgp: null } : lazy.Mime.parseEntity(bin);
    let sig = signature;
    if (part.pgp?.kind === "signed" && sig.state === "none") {
      // подпись не внутри шифрования, а отдельным слоем под ним
      sig = await lazy.Pgp.verify(lazy.Mime.bytesOf(part.pgp.data), part.pgp.signature, this._pgpSender(rec));
    }
    const { body, snippet, code } = lazy.Mime.toBlocks({ ...part, subject: rec.subject });
    this._keepHtml(rec, part);
    rec.body = body;
    rec.snippet = snippet;
    rec.attachments = part.attachments.map(a => ({ ...a, inner: true }));
    if (code) {
      rec.code = code;
      if (!rec.labels.includes("codes")) {
        rec.labels.push("codes");
      }
    }
    if (part.images) {
      rec.images = part.images;
    }
    rec.pgp = { encrypted: true, signature: sig.state, signer: sig.address || "" };
    return bin;
  },

  _pgpFailed(rec, e) {
    const error = e.code === "no-key" ? "no-key" : e.code === "signed-out" ? "locked" : "failed";
    rec.pgp = { encrypted: true, error };
    rec.body = [{ p: error === "no-key" ? "Письмо зашифровано ключом, которого нет в этом профиле. Прочитать его можно там, где этот ключ есть." : "Письмо зашифровано, но расшифровать его не удалось: оно повреждено или зашифровано неизвестным способом." }];
    rec.snippet = "Зашифрованное письмо";
  },

  /** Письмо OpenPGP после получения: расшифровать или проверить подпись. Большое зашифрованное
   * письмо получено не целиком — оно дочитывается с сервера. Работа идёт по очереди. */
  _openPgp(rec) {
    const job = rec._pgp;
    if (!job) {
      return;
    }
    rec._pgp = null;
    this._pgpQueue = (this._pgpQueue || Promise.resolve()).then(async () => {
      if (!this.data || !this.data.messages.includes(rec)) {
        return;
      }
      try {
        if (job.kind === "signed") {
          const sig = await lazy.Pgp.verify(lazy.Mime.bytesOf(job.data), job.signature, this._pgpSender(rec));
          rec.pgp = { signature: sig.state, signer: sig.address || "" };
        } else if (rec.partial) {
          await this._decryptFull(rec);
        } else {
          const { bytes, signature } = await lazy.Pgp.decrypt(job.armored, { from: this._pgpSender(rec) });
          await this._applyDecrypted(rec, job.kind, bytes, signature);
        }
      } catch (e) {
        if (job.kind === "signed") {
          rec.pgp = { signature: "unknown", signer: "" };
        } else {
          this._pgpFailed(rec, e);
        }
      }
      if (this.data) {
        this.save({ soon: true });
      }
    });
  },

  /** Исходник письма целиком с сервера и расшифрованная часть: { kind, bin } либо бросает ошибку. */
  async _fetchDecrypted(rec) {
    if (!rec.at?.uid) {
      throw new Error("Письмо ещё не на сервере");
    }
    let raw = "";
    await this._ops;
    await this._withFolder(rec, async client => {
      raw = (await client.fetch([rec.at.uid]))[0]?.raw || "";
    });
    const parsed = lazy.Mime.parseMessage(raw);
    if (!parsed.pgp || parsed.pgp.kind === "signed") {
      throw new Error("Письмо на сервере не зашифровано");
    }
    const { bytes, signature } = await lazy.Pgp.decrypt(parsed.pgp.armored, { from: this._pgpSender(rec) });
    return { kind: parsed.pgp.kind, bytes, signature };
  },

  async _decryptFull(rec) {
    const { kind, bytes, signature } = await this._fetchDecrypted(rec);
    await this._applyDecrypted(rec, kind, bytes, signature);
    rec.partial = false;
  },

  /** Повторить расшифровку письма (ключ появился позже, сейф был закрыт). */
  async decryptAgain(id) {
    await this.ready();
    const rec = this.byId(id);
    if (!rec?.pgp?.encrypted) {
      return rec;
    }
    try {
      await this._decryptFull(rec);
    } catch (e) {
      this._pgpFailed(rec, e);
    }
    this.save({ soon: true });
    return rec;
  },

  /** Можно ли зашифровать письмо с адреса from этим получателям: { available, possible, missing,
   * suggested }. available — у отправителя есть ключ (это адрес аккаунта Tabora). */
  async encryptPlan(from, recipients) {
    const none = { available: false, possible: false, missing: [], suggested: false };
    try {
      await this.ready();
      if (String(from || "").toLowerCase() !== Account.email) {
        return none;
      }
      if (!(await lazy.Pgp.accountKey())) {
        return none; // ключ аккаунта есть на сервере, но здесь его не открыть (экран «Шифрование»)
      }
      await lazy.Pgp.lookupMissing(recipients);
      return { available: true, ...(await lazy.Pgp.plan(recipients)) };
    } catch (e) {
      return none;
    }
  },

  /** Запись входит в хранилище; местная копия того же письма (только что отправленного или
   * перенесённого без номера) уступает ей место и передаёт свой id, чтобы открытое письмо не закрылось. */
  _adopt(rec) {
    const twin = rec.messageId ? this.data.messages.find(m => m.account === rec.account && m.messageId === rec.messageId && (m.local || (m.at && !m.at.uid)) && m.folder === rec.folder) : null;
    if (twin) {
      rec.id = twin.id;
      rec.thread = twin.thread;
      if (rec.pgp?.pending && twin.pgp?.encrypted && !twin.pgp.error) {
        // своё зашифрованное письмо: пока копия с сервера расшифровывается, показываем уже известный текст
        rec.body = twin.body;
        rec.snippet = twin.snippet;
      }
      this.data.messages = this.data.messages.filter(m => m !== twin);
    } else {
      rec.id = `m${++this._seq}`;
    }
    this.data.messages.push(rec);
  },

  /* ---- изменения ------------------------------------------------------------------------ */

  /** Очередь операций на сервере: строго по одной. */
  _enqueue(where, fn) {
    this._ops = this._ops.then(fn).catch(e => {
      this._fail(e, where);
      this.syncSoon(500); // состояние в памяти могло разойтись с сервером
    });
    return this._ops;
  },

  async _withFolder(rec, fn) {
    const acc = this._acc(rec.account);
    if (!acc || !rec.at?.uid) {
      return;
    }
    const client = await this._connect(acc);
    try {
      await client.select(rec.at.path);
      await fn(client, acc);
    } finally {
      await client.logout();
    }
  },

  update(id, patch) {
    const m = this.byId(id);
    if (!m) {
      return m;
    }
    const before = { unread: m.unread, starred: m.starred, folder: m.folder };
    Object.assign(m, patch);
    if (!m.local && m.at) {
      if (m.unread !== before.unread) {
        const unread = m.unread;
        this._enqueue("отметка «прочитано»", () => this._withFolder(m, c => c.setFlags([m.at.uid], ["\\Seen"], !unread)));
      }
      if (m.starred !== before.starred) {
        const starred = m.starred;
        this._enqueue("звезда", () => this._withFolder(m, c => c.setFlags([m.at.uid], ["\\Flagged"], starred)));
      }
      if (m.folder !== before.folder && ROLES.includes(m.folder)) {
        const to = m.folder;
        m.busy = true; // до ответа сервера сверка эту запись не трогает
        this._enqueue("перенос письма", () => this._move(m, to));
      }
    }
    this.save({ soon: !m.local }); // черновик есть только здесь, пометки письма помнит сервер
    return m;
  },

  async _move(m, to) {
    try {
      if (m.at.role === to) {
        return;
      }
      await this._withFolder(m, async (client, acc) => {
        let dest = acc.folders[to];
        if (!dest && to === "archive") {
          await client.create("Archive");
          dest = acc.folders.archive = "Archive";
        }
        if (!dest) {
          throw new Error("На сервере нет такой папки");
        }
        const r = await client.move([m.at.uid], dest);
        const uid = r?.map?.[m.at.uid] || 0;
        m.at = { role: to, path: dest, uid, uidValidity: r?.uidValidity || 0, since: Date.now() };
        if (!uid) {
          this.syncSoon(300); // сервер не сообщил новый номер: узнаем сверкой
        }
      });
    } finally {
      m.busy = false;
    }
  },

  add(message) {
    if (!this.data) {
      throw accessError(Account.signedIn ? "vault-locked" : "signed-out");
    }
    if (message.folder === "sent" && !message.local) {
      // прежний вызов «добавить отправленное»: отправляем; ошибка придёт уведомлением
      this.send(message).catch(e => this._fail(e, "отправка письма"));
      return;
    }
    // черновики живут на этом компьютере
    this.data.messages.unshift({ ...message, local: true, account: message.account || this._senderAccount(message.from?.email)?.id || TABORA });
    this.save();
  },

  remove(id) {
    if (!this.data) {
      return;
    }
    const m = this.byId(id);
    if (!m) {
      return;
    }
    this.data.messages = this.data.messages.filter(x => x !== m);
    if (!m.local && m.at?.uid) {
      this._enqueue("удаление письма", () => this._withFolder(m, c => c.destroy([m.at.uid])));
    }
    this.save({ soon: !m.local });
  },

  _senderAccount(address) {
    const list = this.data?.accounts || [];
    const a = String(address || "").toLowerCase();
    return list.find(x => x.address === a) || (this.aliases.some(x => x.address === a) ? this._acc(TABORA) : null) || list.find(x => x.id === TABORA) || list[0] || null;
  },

  /** Отправить письмо. message: { from: { email }, to: [адреса], cc?, subject, body: [{ p }] | text,
   * replyTo?: id письма, на которое отвечают, thread?, labels? }. Возвращает запись «Отправленных».
   * Бросает ошибку с текстом для пользователя, если сервер письмо не принял. */
  async send(message) {
    await this.ready();
    const from = String(message.from?.email || this.primaryAddress).toLowerCase();
    const acc = this._senderAccount(from);
    if (!acc) {
      throw new Error("Нет ящика для отправки: добавьте ящик или подключите аккаунт к серверу");
    }
    const to = (message.to || []).map(s => String(s).trim()).filter(Boolean);
    const cc = (message.cc || []).map(s => String(s).trim()).filter(Boolean);
    if (!to.length) {
      throw new Error("Укажите получателя");
    }
    const text = typeof message.text === "string" ? message.text : (message.body || []).map(b => b.p || b.h || b.q || "").filter(Boolean).join("\n\n");
    const original = message.replyTo ? this.byId(message.replyTo) : null;
    const name = acc.id === TABORA ? "" : acc.name || "";
    // вложения: файлы с диска (path) и пересылаемые из другого письма (source: { id, index })
    const attachments = [];
    let total = 0;
    for (const a of message.attachments || []) {
      let bytes;
      let type = a.type || "";
      if (a.path) {
        bytes = await IOUtils.read(a.path).catch(() => {
          throw new Error(`Файл «${a.name}» не читается: возможно, он перемещён или удалён`);
        });
      } else if (a.source) {
        const got = await this.attachment(a.source.id, a.source.index);
        bytes = got.bytes;
        type ||= got.type;
      } else {
        continue;
      }
      total += bytes.length;
      if (total > MAX_ATTACH_BYTES) {
        throw new Error("Вложения больше 20 МБ не отправятся: уберите часть файлов");
      }
      attachments.push({ name: a.name, type, bytes });
    }
    // Письмо с адреса аккаунта несёт его открытый ключ в заголовке Autocrypt и может быть
    // зашифровано; у алиасов и внешних ящиков своего ключа нет.
    const keyed = acc.id === TABORA && from === Account.email;
    if (message.encrypt && !keyed) {
      throw new Error("Зашифровать можно только письмо с адреса аккаунта Tabora");
    }
    let entity = lazy.Mime.buildEntity({ text, attachments });
    const extraHeaders = [];
    if (keyed) {
      try {
        const autocrypt = (await lazy.Pgp.accountKey()) ? await lazy.Pgp.autocryptHeader(from) : "";
        if (autocrypt) {
          extraHeaders.push(lazy.Mime.foldHeader("Autocrypt", autocrypt));
        } else if (message.encrypt) {
          throw new Error("Ключ шифрования аккаунта на этом компьютере недоступен: откройте в почте раздел «Шифрование»");
        }
      } catch (e) {
        if (message.encrypt) {
          throw e;
        }
        console.error("Tabora mail: ключ шифрования недоступен, письмо уходит без него", e);
      }
    }
    if (message.encrypt) {
      entity = lazy.Mime.encryptedEntity(await lazy.Pgp.encrypt(lazy.Mime.bytesOf(entity), [...to, ...cc]));
    }
    const built = lazy.Mime.buildMessage({
      from: { name, email: from }, to, cc, subject: message.subject || "(без темы)", entity, extraHeaders,
      inReplyTo: original?.messageId || "", references: original ? [...(original.refs || []), original.messageId].filter(Boolean).slice(-10) : [],
    });
    const creds = await this._creds(acc);
    const deliver = c => lazy.smtpSend(c.smtp, { login: c.login, password: c.password }, { from, to: [...to, ...cc], raw: built.raw });
    try {
      await deliver(creds);
    } catch (e) {
      if (e.code === "auth" && acc.id === TABORA) {
        const fresh = await Account.mailAccess({ refresh: true });
        await deliver({ smtp: fresh.smtp, login: fresh.login, password: fresh.password });
      } else {
        throw e;
      }
    }
    const rec = {
      id: `m${++this._seq}`, account: acc.id, thread: original?.thread || message.thread || `t${hash(`${acc.id}|${built.messageId}`)}`, folder: "sent", local: true,
      unread: false, starred: false, labels: message.labels || [], from: { name: "Я", email: from }, to, cc, alias: from,
      date: new Date().toISOString(), subject: message.subject || "(без темы)", messageId: built.messageId,
      refs: original ? [...(original.refs || []), original.messageId].filter(Boolean) : [], body: lazy.Mime.toBlocks({ text, html: "", subject: message.subject || "" }).body,
      attachments: attachments.map(a => ({ name: a.name, size: a.bytes.length })),
    };
    if (message.encrypt) {
      rec.pgp = { encrypted: true, signature: "valid", signer: from };
    }
    this.data.messages.unshift(rec);
    this.save();
    // копия в «Отправленные» на сервере (Gmail кладёт её сам)
    if (!acc.savesSent) {
      this._enqueue("копия в «Отправленные»", async () => {
        const client = await this._connect(acc);
        try {
          const path = acc.folders?.sent || (await client.list()).find(f => f.role === "sent")?.path;
          if (path) {
            await client.append(path, built.raw, ["\\Seen"]);
          }
        } finally {
          await client.logout();
        }
      });
    }
    this._ops.then(() => this.syncSoon(1500));
    return rec;
  },

  /** Содержимое вложения: { name, type, bytes: Uint8Array }. Читается с сервера по запросу. */
  async attachment(id, index) {
    const m = this.byId(id);
    const att = m?.attachments?.[index];
    if (!m || !att || !m.at?.uid) {
      throw new Error("Вложение недоступно");
    }
    if (att.inner) {
      // вложение внутри зашифрованного письма: сервер видит только шифртекст
      const { bytes } = await this._fetchDecrypted(m);
      let inner = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        inner += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const part = lazy.Mime.findSection(inner, att.section);
      if (!part) {
        throw new Error("Вложение недоступно");
      }
      return { name: att.name, type: att.type, bytes: lazy.Mime.decodeAttachment(part.bin, part.encoding) };
    }
    let bin = "";
    await this._ops;
    await this._withFolder(m, async client => {
      bin = await client.fetchSection(m.at.uid, att.section);
    });
    return { name: att.name, type: att.type, bytes: lazy.Mime.decodeAttachment(bin, att.encoding) };
  },

  /* ---- алиасы ящика Tabora (хранит сервер аккаунтов) ---------------------------------------- */

  _aliasView(a, prev) {
    const agent = a.by === "agent";
    return {
      id: a.id, address: a.address, site: a.site || "без привязки к сайту", by: agent ? "агент" : "вручную", agent,
      count: prev?.count || 0, created: a.created, space: a.space || SPACES[0], on: !!a.on, ...(a.on ? {} : { warn: "выключен" }),
    };
  },

  async _syncAliases() {
    try {
      const list = await Account.aliases();
      const prev = new Map(this.aliases.map(a => [a.id, a]));
      this.data.aliases = list.map(a => this._aliasView(a, prev.get(a.id)));
    } catch (e) {
      if (e.code !== "offline") {
        console.error("Tabora mail: список алиасов не получен", e);
      }
    }
  },

  _countAliases() {
    const count = new Map();
    for (const m of this.messages) {
      if (m.folder !== "sent" && m.alias) {
        count.set(m.alias, (count.get(m.alias) || 0) + 1);
      }
    }
    for (const a of this.aliases) {
      a.count = count.get(a.address) || 0;
    }
  },

  /** Новый алиас для сайта: адрес выбирает сервер (например, booking-k3f9@tabora.app). */
  async aliasCreate({ site = "", space = "", by = "manual" } = {}) {
    await this.ready();
    // «https://www.booking.com/signup» → «booking.com»: в списке алиасов виден сайт, а не ссылка
    const typed = String(site).trim();
    const host = typed.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
    site = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : typed;
    const a = this._aliasView(await Account.aliasCreate({ site, space, by }));
    this.data.aliases.unshift(a);
    this.save();
    return a;
  },

  /** Включить или выключить алиас: выключенный перестаёт принимать письма. */
  async aliasSet(id, on) {
    await this.ready();
    const a = await Account.aliasUpdate(id, { on: !!on });
    const i = this.data.aliases.findIndex(x => x.id === id);
    if (i >= 0) {
      this.data.aliases[i] = this._aliasView(a, this.data.aliases[i]);
    }
    this.save();
    return this.data.aliases[i];
  },
};

/* Смена ключа сейфа: кэш перешифровывается новым подключом. Не обязательна: если не
 * удалась, кэш начнётся заново и наполнится с сервера (пароли внешних ящиков придётся ввести снова). */
Vault.registerRekey("mail", async ({ decryptOld, encryptNew }) => {
  if (MailStore.data) {
    await MailStore._writeNow(); // Vault.encrypt уже работает новым ключом
    return;
  }
  let raw;
  try {
    raw = await IOUtils.readJSON(FILE());
  } catch (e) {
    return;
  }
  if (raw?.v !== FORMAT || !raw.enc) {
    return;
  }
  const bytes = await decryptOld("mail", raw.enc);
  try {
    await IOUtils.writeJSON(FILE(), { v: FORMAT, enc: await encryptNew("mail", bytes) }, { tmpPath: `${FILE()}.tmp` });
  } finally {
    bytes.fill(0);
  }
});
