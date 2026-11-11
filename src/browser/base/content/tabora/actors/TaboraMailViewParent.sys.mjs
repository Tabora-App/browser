/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Просмотр письма с вёрсткой: сторона браузера. Сообщения приходят из процесса страницы, в
 * котором лежит чужое письмо, поэтому каждое проверяется: высота — число в разумных пределах,
 * ссылка — http, https или mailto. Проверенное передаётся странице почты событием на элементе
 * browser (см. mail/mail.js, htmlView). */

const MAX_HEIGHT = 200_000;

export class TaboraMailViewParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext?.top?.embedderElement;
    // элемент browser создаёт только страница почты: в других местах актору делать нечего
    if (!browser?.isConnected || browser.getAttribute("messagemanagergroup") !== "tabora-mail") {
      return;
    }
    const win = browser.ownerDocument.defaultView;
    if (!win) {
      return;
    }
    const send = (type, detail) => browser.dispatchEvent(new win.CustomEvent(type, { detail: Cu.cloneInto(detail, win) }));
    switch (message.name) {
      case "TaboraMailView:Size": {
        const [height, width, view] = [message.data?.height, message.data?.width, message.data?.view].map(Number);
        const sane = n => Number.isFinite(n) && n >= 0 && n <= MAX_HEIGHT;
        if (sane(height) && sane(width) && sane(view)) {
          send("tabora-mail-size", { height: Math.ceil(height), width: Math.ceil(width), view: Math.round(view) });
        }
        break;
      }
      case "TaboraMailView:Hover": {
        const href = String(message.data?.href || "");
        // показывается как текст: длина ограничена, схема любая (чужую схему человек должен увидеть)
        send("tabora-mail-hover", { href: href.length > 300 ? `${href.slice(0, 300)}…` : href });
        break;
      }
      case "TaboraMailView:Link": {
        const href = String(message.data?.href || "");
        if (href.length <= 4096 && /^(https?:\/\/|mailto:)/i.test(href)) {
          send("tabora-mail-link", { href });
        }
        break;
      }
    }
  }
}
