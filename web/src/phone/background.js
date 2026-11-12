/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Фоновая страница модуля аккаунта в приложении для телефона: здесь живут вход и синхронизация.
 * Экран аккаунта получает этот объект через runtime.getBackgroundPage(). */

import { Api } from "../core/api.js";
import { Bridge } from "./bridge.js";
import { Service } from "./service.js";
import { NativeStore } from "./store.js";

const bridge = new Bridge();
const service = new Service({ bridge, store: new NativeStore(bridge), api: new Api(__API_BASE__), fillTestOrigin: __FILL_TEST_ORIGIN__ });
globalThis.tabora = service;
service.ready.catch(e => console.error("Tabora: аккаунт не запущен", e));
// скрипт автоввода на страницах сайтов (fill.js) спрашивает, какие коды привязаны к сайту
globalThis.browser.runtime.onMessage.addListener((message, sender) => service.fromPage(message, sender));
