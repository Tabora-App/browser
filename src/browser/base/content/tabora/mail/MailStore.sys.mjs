/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Хранилище почты Tabora. Один экземпляр на процесс: им пользуются страница
 * tabora://mail и окно нового письма в оболочке браузера. Данные пока
 * демонстрационные, лежат в профиле (tabora-mail.json). Когда появится почтовый
 * сервер, этот модуль станет его клиентом, интерфейс не меняется.
 * Об изменениях модуль сообщает через Services.obs "tabora-mail-changed". */

export const ACCOUNT = { address: "felix@tabora.app", domain: "tabora.app", quotaUsedGb: 2.1, quotaTotalGb: 20 };
export const SPACES = ["Личное", "Работа", "Проекты"];
export const SPACE_COLORS = { Личное: "#c8f25a", Работа: "#7cc4ff", Проекты: "#ff9f5a" };

/* ---- Демонстрационные данные ------------------------------------------- */

function at(daysAgo, hh, mm) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

export function seed() {
  const me = ACCOUNT.address;
  const messages = [
    {
      id: "m1", thread: "t1", folder: "inbox", unread: true, starred: false, labels: ["codes"],
      from: { name: "Booking.com", email: "noreply@booking.com" }, to: ["booking-k3f9@tabora.app"], alias: "booking-k3f9@tabora.app",
      date: at(0, 10, 42), subject: "Код подтверждения: 482917", code: "482917",
      agent: { site: "booking.com", tab: "Регистрация · booking.com" },
      body: [
        { h: "Подтвердите адрес электронной почты" },
        { p: "Введите этот код на странице регистрации, чтобы завершить создание аккаунта. Код действует 10 минут." },
        { code: "482917" },
        { fine: "Если вы не создавали аккаунт, просто проигнорируйте это письмо." },
      ],
    },
    {
      id: "m2", thread: "t2", folder: "inbox", unread: true, starred: true, labels: ["travel"],
      from: { name: "Анна Петрова", email: "anna.petrova@gmail.com" }, to: [me], alias: me,
      date: at(0, 9, 15), subject: "Фотки с Праги и план на декабрь",
      body: [
        { p: "Привет! Наконец разобрала фотографии, кидаю лучшие. Карлов мост на рассвете получился просто космос." },
        { p: "По декабрю: у меня свободны 12–14 и 19–21. Если берём Вену, то лучше вторые выходные, там рынки ещё открыты. Посмотришь билеты через своего агента?" },
        { p: "Обнимаю, А." },
      ],
      attachments: [{ name: "praha-01.jpg", size: 3_240_000 }, { name: "praha-02.jpg", size: 2_870_000 }, { name: "praha-most.jpg", size: 4_110_000 }],
    },
    {
      id: "m2b", thread: "t2", folder: "sent", unread: false, starred: false, labels: ["travel"],
      from: { name: "Я", email: me }, to: ["anna.petrova@gmail.com"], alias: me,
      date: at(1, 22, 5), subject: "Фотки с Праги и план на декабрь",
      body: [{ p: "Ань, скинь фотки, когда разберёшь. И давай решать с декабрём, а то билеты дорожают." }],
    },
    {
      id: "m3", thread: "t3", folder: "inbox", unread: true, starred: false, labels: ["finance"],
      from: { name: "Hetzner", email: "billing@hetzner.com" }, to: ["hetzner-q8m2@tabora.app"], alias: "hetzner-q8m2@tabora.app",
      date: at(1, 8, 2), subject: "Invoice for October 2026",
      body: [
        { h: "Your invoice is ready" },
        { p: "Invoice R0012345678 for October 2026 has been issued. Amount due: 23,80 €. Payment will be collected automatically from your registered payment method on 12.11.2026." },
        { btn: "Open invoice" },
        { fine: "Hetzner Online GmbH · Industriestr. 25 · 91710 Gunzenhausen" },
      ],
      attachments: [{ name: "Hetzner_2026-10_R0012345678.pdf", size: 86_000 }],
    },
    {
      id: "m4", thread: "t4", folder: "inbox", unread: false, starred: false, labels: ["news"],
      from: { name: "Notion", email: "team@mail.notion.so" }, to: ["notion-p1z7@tabora.app"], alias: "notion-p1z7@tabora.app",
      date: at(1, 7, 30), subject: "Weekly digest: 4 updates in Tabora", newsletter: true,
      body: [
        { h: "This week in your workspace" },
        { p: "«Roadmap» — 2 новых страницы. «Design tokens» — обновлена 3 раза. «Mail server» — добавлен комментарий от Felix." },
        { btn: "Open Notion" },
      ],
    },
    {
      id: "m5", thread: "t5", folder: "inbox", unread: false, starred: false, labels: ["travel"],
      from: { name: "Deutsche Bahn", email: "noreply@bahn.de" }, to: ["bahn-x4k1@tabora.app"], alias: "bahn-x4k1@tabora.app",
      date: at(3, 16, 20), subject: "Ваш билет Прага — Берлин",
      body: [
        { h: "Билет оформлен" },
        { p: "EC 174 · 21.12.2026 · отправление 10:28 из Praha hl.n., прибытие 14:46 в Berlin Hbf. Вагон 262, место 61, у окна." },
        { p: "Покажите QR-код из вложения контролёру. Распечатывать не нужно." },
      ],
      attachments: [{ name: "ticket-EC174.pdf", size: 212_000 }],
    },
    {
      id: "m6", thread: "t6", folder: "inbox", unread: false, starred: false, labels: [],
      from: { name: "GitHub", email: "notifications@github.com" }, to: ["github-m0c3@tabora.app"], alias: "github-m0c3@tabora.app",
      date: at(3, 12, 1), subject: "[Tabora-App/browser] Build succeeded: darwin-aarch64",
      body: [
        { p: "Run #42481288875 finished successfully in 58m 12s. Artifact: tabora-darwin-aarch64 (105 MB)." },
        { btn: "View run" },
      ],
    },
    {
      id: "m7", thread: "t7", folder: "inbox", unread: false, starred: false, labels: ["codes"],
      from: { name: "Hetzner", email: "noreply@hetzner.com" }, to: ["hetzner-q8m2@tabora.app"], alias: "hetzner-q8m2@tabora.app",
      date: at(6, 11, 9), subject: "Your login code", code: "731 204",
      body: [{ h: "Login verification" }, { p: "Use this code to finish signing in. It expires in 5 minutes." }, { code: "731 204" }],
    },
    {
      id: "m8", thread: "t8", folder: "archive", unread: false, starred: false, labels: ["finance"],
      from: { name: "Revolut", email: "no-reply@revolut.com" }, to: [me], alias: me,
      date: at(9, 18, 44), subject: "Выписка за октябрь",
      body: [{ p: "Ваша выписка за октябрь готова. Расходы: 1 284,30 €. Больше всего ушло на категорию «Путешествия»." }],
      attachments: [{ name: "statement-2026-10.pdf", size: 140_000 }],
    },
    {
      id: "m9", thread: "t9", folder: "spam", unread: true, starred: false, labels: [],
      from: { name: "Zalando Lounge", email: "promo@zalando-lounge.cz" }, to: ["zalando-t7r2@tabora.app"], alias: "zalando-t7r2@tabora.app",
      date: at(2, 6, 0), subject: "Только сегодня: −70% на куртки", newsletter: true,
      body: [{ p: "Алиас zalando-t7r2 выключен, поэтому письмо попало сюда, а не во входящие." }],
    },
    {
      id: "m10", thread: "t10", folder: "drafts", unread: false, starred: false, labels: [],
      from: { name: "Я", email: me }, to: ["support@hetzner.com"], alias: me,
      date: at(0, 8, 50), subject: "Вопрос по счёту R0012345678",
      body: [{ p: "Здравствуйте! В счёте за октябрь указан сервер CX32, хотя с 14 октября у нас CX22. Проверьте, пожалуйста," }],
      draft: true,
    },
    {
      id: "m11", thread: "t11", folder: "inbox", unread: false, starred: true, labels: ["travel"],
      from: { name: "Ryanair", email: "noreply@ryanair.com" }, to: ["ryanair-c2n6@tabora.app"], alias: "ryanair-c2n6@tabora.app",
      date: at(12, 14, 12), subject: "Регистрация на рейс FR 1024 открыта",
      body: [{ h: "Пора регистрироваться" }, { p: "Рейс FR 1024 Прага — Дублин, 19.11.2026, вылет 07:05. Онлайн-регистрация открыта до 06:05 в день вылета." }, { btn: "Зарегистрироваться" }],
    },
  ];

  const aliases = [
    { id: "a1", address: "booking-k3f9@tabora.app", site: "booking.com", by: "агент при регистрации", count: 1, created: at(0, 10, 40), space: "Личное", on: true, agent: true },
    { id: "a2", address: "hetzner-q8m2@tabora.app", site: "hetzner.com", by: "агент", count: 6, created: at(6, 11, 0), space: "Проекты", on: true, agent: true },
    { id: "a3", address: "bahn-x4k1@tabora.app", site: "bahn.de", by: "агент", count: 3, created: at(3, 16, 0), space: "Личное", on: true, agent: true },
    { id: "a4", address: "notion-p1z7@tabora.app", site: "notion.so", by: "вручную", count: 27, created: at(27, 9, 0), space: "Работа", on: true, agent: false, warn: "14 рассылок за неделю" },
    { id: "a5", address: "github-m0c3@tabora.app", site: "github.com", by: "вручную", count: 58, created: at(30, 9, 0), space: "Работа", on: true, agent: false },
    { id: "a6", address: "zalando-t7r2@tabora.app", site: "zalando.cz", by: "агент", count: 41, created: at(48, 9, 0), space: "Личное", on: false, agent: true, warn: "выключен: спам" },
    { id: "a7", address: "promo-d5w8@tabora.app", site: "рассылки акций", by: "вручную", count: 112, created: at(97, 9, 0), space: "Личное", on: false, agent: false, warn: "выключен" },
    { id: "a8", address: "ryanair-c2n6@tabora.app", site: "ryanair.com", by: "агент", count: 9, created: at(101, 9, 0), space: "Личное", on: true, agent: true },
  ];

  return { v: 3, messages, aliases, blockedThisMonth: 312 };
}

export const MailStore = {
  TOPIC: "tabora-mail-changed",
  data: null,
  _ready: null,
  _file: null,

  /** Загружает данные один раз; повторные вызовы возвращают тот же промис. */
  ready() {
    if (!this._ready) {
      this._file = PathUtils.join(PathUtils.profileDir, "tabora-mail.json");
      this._ready = (async () => {
        try {
          const parsed = await IOUtils.readJSON(this._file);
          if (parsed?.v === 3) {
            this.data = parsed;
          }
        } catch (e) {}
        if (!this.data) {
          this.data = seed();
          await this._write();
        }
      })();
    }
    return this._ready;
  },

  async _write() {
    try {
      await IOUtils.writeJSON(this._file, this.data, { tmpPath: `${this._file}.tmp` });
    } catch (e) {
      console.error("Tabora mail: не удалось сохранить", e);
    }
  },

  save() {
    this._write();
    Services.obs.notifyObservers(null, this.TOPIC);
  },

  get messages() { return this.data.messages; },
  get aliases() { return this.data.aliases; },
  byId(id) { return this.data.messages.find(m => m.id === id); },
  thread(threadId) {
    return this.data.messages.filter(m => m.thread === threadId && m.folder !== "trash").sort((a, b) => a.date.localeCompare(b.date));
  },
  update(id, patch) {
    const m = this.byId(id);
    if (m) {
      Object.assign(m, patch);
      this.save();
    }
    return m;
  },
  add(message) {
    this.data.messages.unshift(message);
    this.save();
  },
  remove(id) {
    this.data.messages = this.data.messages.filter(m => m.id !== id);
    this.save();
  },
  unreadInbox() {
    return this.data.messages.filter(m => m.folder === "inbox" && m.unread).length;
  },
};
