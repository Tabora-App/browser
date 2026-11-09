/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Родительская часть актора сейфа: ссылки otpauth:// со страницы передаются в оболочку
 * окна (Tabora.otpAddFromUrl), которая показывает лист добавления только для активной вкладки. */

export class TaboraVaultParent extends JSWindowActorParent {
  receiveMessage(message) {
    const win = this.browsingContext.topChromeWindow;
    if (!win?.Tabora || message.name !== "TaboraVault:Otpauth") {
      return;
    }
    const data = message.data || {};
    const url = String(data.url || "");
    if (!/^otpauth(-migration)?:\/\//i.test(url) || url.length > 4096) {
      return;
    }
    let host = "";
    try {
      host = this.browsingContext.top.currentWindowGlobal?.documentPrincipal?.host || "";
    } catch (e) {}
    win.Tabora.otpAddFromUrl(url, { host, browser: this.browsingContext.top.embedderElement });
  }
}
