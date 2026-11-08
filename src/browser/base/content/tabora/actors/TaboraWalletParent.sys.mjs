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
    if (!win?.Tabora?.walletHandleRequest || !principal || principal.isSystemPrincipal) {
      throw { code: 4200, message: "Кошелёк недоступен" };
    }
    const origin = principal.origin;
    const data = message.data || {};
    try {
      return await win.Tabora.walletHandleRequest({
        chain: String(data.chain || ""),
        method: String(data.method || ""),
        params: data.params,
        origin,
        host: principal.host || origin,
        secure: principal.schemeIs("https"),
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
