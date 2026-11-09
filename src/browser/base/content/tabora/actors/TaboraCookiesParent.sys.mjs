/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Баннер cookie закрыт: сообщаем оболочке только сайт вкладки. Хост берётся здесь,
 * из адреса верхнего документа, а не из сообщения страницы. */

export class TaboraCookiesParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "TaboraCookies:Handled") {
      return;
    }
    if (!this.manager?.documentPrincipal?.isContentPrincipal) {
      return;
    }
    const top = this.browsingContext.top;
    let host = "";
    try {
      const uri = top?.currentWindowGlobal?.documentURI;
      if (uri && (uri.schemeIs("http") || uri.schemeIs("https"))) {
        host = uri.host.replace(/^www\./, "");
      }
    } catch (e) {}
    if (!host) {
      return;
    }
    const how = message.data?.how === "rule" ? "rule" : "text";
    // фрейм и «чужой ли это сайт» определяются здесь, по принципалам, а не по словам страницы
    const frame = !!this.browsingContext.parent;
    let thirdParty = false;
    if (frame) {
      try {
        const base = top.currentWindowGlobal.documentPrincipal.baseDomain;
        thirdParty = !base || this.manager.documentPrincipal.baseDomain !== base;
      } catch (e) {
        thirdParty = true;
      }
    }
    const win = this.browsingContext.topChromeWindow;
    win?.Tabora?.cookieBannerHandled?.({ host, how, frame, thirdParty }, top);
  }
}
