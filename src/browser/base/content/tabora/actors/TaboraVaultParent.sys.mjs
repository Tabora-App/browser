/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Родительская часть актора сейфа. Сообщениям страницы не доверяет: хост для подбора
 * кодов берётся из принципала документа (только https, тот же сайт, что и вкладка), а
 * не из данных сообщения. Ссылки otpauth:// со страницы передаются в оболочку окна
 * (Tabora.otpAddFromUrl), которая показывает лист добавления только для активной вкладки. */

function num(v, min, max, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

export class TaboraVaultParent extends JSWindowActorParent {
  /** Хост документа для кодов или "" — коды выдаются только https-документу того же сайта,
   * что и вкладка: поле в рамке чужого сайта подсказку не получает. */
  otpHost() {
    try {
      const p = this.manager?.documentPrincipal;
      const top = this.browsingContext.top.currentWindowGlobal?.documentPrincipal;
      if (!p?.isContentPrincipal || !top?.isContentPrincipal || !p.schemeIs("https") || !top.schemeIs("https")) {
        return "";
      }
      if (p.baseDomain !== top.baseDomain) {
        return "";
      }
      return String(p.asciiHost || "").toLowerCase();
    } catch (e) {
      return "";
    }
  }

  receiveMessage(message) {
    const win = this.browsingContext.topChromeWindow;
    if (!win?.Tabora) {
      return;
    }
    const data = message.data || {};
    switch (message.name) {
      case "TaboraVault:OtpField": {
        const host = this.otpHost();
        if (!host) {
          return;
        }
        const r = data.rect || {};
        win.Tabora.otpFieldFocused({
          host,
          kind: String(data.kind || "").slice(0, 16),
          rect: { x: num(r.x, -1e5, 1e5), y: num(r.y, -1e5, 1e5), w: num(r.w, 0, 1e4), h: num(r.h, 0, 1e4) },
          zoom: num(data.zoom, 0.1, 10, 1),
          maxLength: Math.round(num(data.maxLength, 0, 64)),
        }, this);
        return;
      }
      case "TaboraVault:OtpFieldBlur":
        win.Tabora.otpFieldBlurred(this);
        return;
      case "TaboraVault:OtpAccept":
        // само сообщение ничего не вставляет: оболочка проверит, что окно видело настоящий Enter
        win.Tabora.otpPopAccept(this);
        return;
      case "TaboraVault:OtpMove":
        win.Tabora.otpPopMove(this, Number(data.delta) > 0 ? 1 : -1);
        return;
      case "TaboraVault:OtpDismiss":
        win.Tabora.otpPopHide(this);
        return;
      case "TaboraVault:Otpauth":
        break;
      default:
        return;
    }
    const url = String(data.url || "");
    if (!/^otpauth(-migration)?:\/\//i.test(url) || url.length > 4096) {
      return;
    }
    let host = "";
    try {
      const top = this.browsingContext.top.currentWindowGlobal?.documentPrincipal;
      // привязка к сайту — только для https-страницы; иначе пользователь укажет сайт сам
      if (top?.isContentPrincipal && top.schemeIs("https")) {
        host = String(top.asciiHost || "").toLowerCase();
      }
    } catch (e) {}
    win.Tabora.otpAddFromUrl(url, { host, browser: this.browsingContext.top.embedderElement });
  }
}
