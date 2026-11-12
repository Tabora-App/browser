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
globalThis.tabora = new Service({ bridge, store: new NativeStore(bridge), api: new Api(__API_BASE__) });
globalThis.tabora.ready.catch(e => console.error("Tabora: аккаунт не запущен", e));
