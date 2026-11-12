/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Где приложение для телефона хранит вход в аккаунт. В сохранённой записи лежат токен сессии и
 * ключ данных аккаунта, поэтому в хранилище страницы она не пишется вовсе: запись отдаётся
 * приложению, а оно держит её зашифрованной ключом из хранилища ключей Android.
 *
 * Войдя один раз, человек остаётся в аккаунте, пока сам не выйдет: сбой чтения или записи вход
 * не стирает — он остаётся в памяти до перезапуска приложения. */

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class NativeStore {
  /** @param {import("./bridge.js").Bridge} bridge */
  constructor(bridge) {
    this._bridge = bridge;
    this._device = "";
    this._name = "";
    this._session = null;
  }

  /** Прочитать у приложения номер устройства, его имя и сохранённый вход. До этого аккаунт не запускать. */
  async init() {
    const r = await this._bridge.request({ type: "store-load" });
    if (!ID_RE.test(r.deviceId || "")) {
      throw new Error("приложение не сообщило номер устройства");
    }
    this._device = r.deviceId;
    this._name = String(r.deviceName || "").trim().slice(0, 64) || "Android";
    try {
      const saved = typeof r.session === "string" && r.session ? JSON.parse(r.session) : null;
      this._session = saved && typeof saved === "object" ? saved : null;
    } catch (e) {
      this._session = null;
    }
  }

  /** Номер этого телефона для сервера: случайный, постоянный, без сведений об устройстве. */
  deviceId() {
    return this._device;
  }

  /** Имя телефона, как его назвал владелец: под ним вкладки видны на других устройствах. */
  deviceName() {
    return this._name;
  }

  async load() {
    return this._session ? JSON.parse(JSON.stringify(this._session)) : null;
  }

  async save(data) {
    this._session = JSON.parse(JSON.stringify(data));
    const r = await this._bridge.request({ type: "store-save", session: JSON.stringify(this._session) });
    if (!r.ok) {
      throw new Error("приложение не сохранило вход");
    }
  }

  async clear() {
    this._session = null;
    await this._bridge.request({ type: "store-clear" });
  }

  /* ---- копия данных синхронизации: чтобы коды и чужие вкладки были под рукой без сети ---- */

  /** Сохранённый объект или null. */
  async loadData(name) {
    try {
      const r = await this._bridge.request({ type: "data-load", name });
      const value = typeof r.value === "string" && r.value ? JSON.parse(r.value) : null;
      return value && typeof value === "object" ? value : null;
    } catch (e) {
      return null;
    }
  }

  async saveData(name, value) {
    await this._bridge.request({ type: "data-save", name, value: JSON.stringify(value) });
  }

  async clearData(name) {
    await this._bridge.request({ type: "data-clear", name });
  }
}
