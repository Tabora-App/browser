/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Актор страницы для блокировщика рекламы: добавляет документу стили, прячущие рекламные блоки.
 * Какие именно — решает родитель (shield/Shield.sys.mjs). Стили встают на уровне браузера
 * (AGENT_SHEET): страница не может их ни увидеть, ни перебить. Кода на странице актор не
 * выполняет и её содержимого не читает.
 *
 * Общий лист (тысячи правил для всех сайтов) приходит в процесс через общую память и
 * разбирается один раз на процесс; документам он подключается готовым. */

const SHARED = "tabora-shield";
let generic = { v: 0, sheet: null }; // разобранный общий лист этого процесса

function genericSheet(version) {
  if (generic.v !== version) {
    const data = Services.cpmm.sharedData.get(SHARED);
    if (!data || data.v !== version || !data.css) {
      return null;
    }
    const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
    generic = { v: version, sheet: sss.preloadSheet(Services.io.newURI(`data:text/css;charset=utf-8,${encodeURIComponent(data.css)}`), sss.AGENT_SHEET) };
  }
  return generic.sheet;
}

export class TaboraShieldChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type === "DOMDocElementInserted" && event.target === this.document) {
      this.apply();
    }
  }

  async apply() {
    let style;
    try {
      style = await this.sendQuery("Shield:Style", {});
    } catch (e) {
      return; // документ уже ушёл
    }
    const win = this.contentWindow;
    if (!style || style.off || !win) {
      return;
    }
    const utils = win.windowUtils;
    try {
      if (style.generic) {
        const sheet = genericSheet(style.v);
        if (sheet) {
          utils.addSheet(sheet, utils.AGENT_SHEET);
        }
      }
      for (const css of [style.extra, style.css]) {
        if (css) {
          utils.loadSheetUsingURIString(`data:text/css;charset=utf-8,${encodeURIComponent(css)}`, utils.AGENT_SHEET);
        }
      }
    } catch (e) {
      console.error("Tabora shield: стили не применены", e);
    }
  }
}
