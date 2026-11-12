/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Связь модуля аккаунта с приложением для телефона. Модуль встроен в приложение как расширение
 * движка; с частью на Kotlin (org.mozilla.fenix.tabora.TaboraAccount) он говорит сообщениями
 * расширения. Другого пути наружу у него нет: только эти сообщения и сервер аккаунтов.
 *
 * Запросы с ответом (request; ответ — строка JSON):
 *   { type: "store-load" }            → { deviceId, deviceName, session }   сохранённый вход
 *   { type: "store-save", session }   → { ok }
 *   { type: "store-clear" }           → { ok }
 * Канал (connect), приложение → модуль:
 *   { type: "tabs", tabs: [{ t, u }] }   открытые вкладки телефона (без приватных)
 *   { type: "sync" }                     сверить сейчас (открыли список вкладок)
 * Канал, модуль → приложение:
 *   { type: "state", signedIn, email, tabsOn, status, at, devices: [{ id, name, at, tabs: [{ t, u }] }] } */

const APP = "tabora";

export class Bridge {
  constructor(runtime = globalThis.browser?.runtime) {
    this._runtime = runtime;
    this._port = null;
    this._listeners = new Set();
  }

  /** Открыть канал. Если приложение его закроет, следующий post откроет заново. */
  connect() {
    if (this._port) {
      return;
    }
    const port = this._runtime.connectNative(APP);
    port.onMessage.addListener(message => {
      if (!message || typeof message !== "object") {
        return;
      }
      for (const fn of [...this._listeners]) {
        try {
          fn(message);
        } catch (e) {
          console.error(e);
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (this._port === port) {
        this._port = null;
      }
    });
    this._port = port;
  }

  onMessage(fn) {
    this._listeners.add(fn);
  }

  post(message) {
    try {
      this.connect();
      this._port.postMessage(message);
    } catch (e) {
      console.error("Tabora: приложение не приняло сообщение", e);
    }
  }

  /** Запрос с ответом. Приложение отвечает строкой JSON: движок передаёт в ответ только простые значения. */
  async request(message) {
    let r = await this._runtime.sendNativeMessage(APP, message);
    if (typeof r === "string") {
      try {
        r = JSON.parse(r);
      } catch (e) {
        r = null;
      }
    }
    return r && typeof r === "object" ? r : {};
  }
}
