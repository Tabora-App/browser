import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Родительская сторона провайдера кошелька: принимает запросы страниц и передаёт их
 * в окно браузера (Tabora.walletHandleRequest), которое показывает подтверждения. */

export class TaboraWalletParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name !== "TaboraWallet:Request") {
      return undefined;
    }
    const win = this.browsingContext.topChromeWindow;
    const principal = this.manager.documentPrincipal;
    // Только обычные документы с настоящим origin: без system/null/expanded принципалов,
    // без data:/blob:/sandbox-фреймов и без http (кроме localhost).
    if (!win?.Tabora?.walletHandleRequest || !principal || !principal.isContentPrincipal) {
      throw { code: 4100, message: tt`Кошелёк недоступен для этого документа` };
    }
    let host = "";
    let hostPort = "";
    try {
      host = principal.host;
      hostPort = principal.hostPort || host; // порт показываем: https://host:8443 не должен выглядеть как host
    } catch (e) {}
    const local = ["localhost", "127.0.0.1"].includes(host) || host.endsWith(".localhost");
    if (!principal.schemeIs("https") && !(principal.schemeIs("http") && local)) {
      throw { code: 4100, message: tt`Кошелёк доступен только сайтам по HTTPS` };
    }
    const origin = principal.origin;
    let topHost = hostPort;
    try {
      topHost = this.browsingContext.top.currentWindowGlobal?.documentPrincipal?.hostPort || hostPort;
    } catch (e) {}
    const data = message.data || {};
    // Признак взаимодействия приходит из контент-актора (navigator.userActivation через Xray):
    // сама страница его подделать не может.
    const userInteracted = !!data.activation?.been;
    const transient = !!data.activation?.active;
    try {
      return await win.Tabora.walletHandleRequest({
        chain: String(data.chain || ""),
        method: String(data.method || ""),
        params: data.params,
        origin,
        host: hostPort || origin,
        topHost,
        isFrame: this.browsingContext.top !== this.browsingContext,
        userInteracted,
        transient,
        secure: principal.schemeIs("https"),
        // приватное окно: разрешения и действия такого сайта не записываются в файл кошелька
        private: principal.privateBrowsingId > 0,
        browsingContext: this.browsingContext,
        actor: this,
      });
    } catch (e) {
      // Ошибки EIP-1193: { code, message }
      throw { code: e?.code || -32603, message: e?.message || String(e) };
    }
  }

  /** Событие для страницы: accountsChanged, chainChanged, connect, disconnect и т. п. */
  emit(chain, event, payload) {
    try {
      this.sendAsyncMessage("TaboraWallet:Event", { chain, event, payload });
    } catch (e) {}
  }
}
