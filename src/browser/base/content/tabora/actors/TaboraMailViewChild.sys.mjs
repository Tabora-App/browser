/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Просмотр письма с вёрсткой: сторона процесса страницы.
 *
 * Письмо показано в отдельном процессе содержимого (элемент browser группы "tabora-mail" на
 * странице почты, см. mail/MailView.sys.mjs): документ data: с пустым происхождением, скрипты
 * запрещены, загрузки ограничены политикой содержимого. Этот актор делает три вещи:
 *   - сообщает высоту содержимого, чтобы письмо занимало на странице почты ровно своё место, и
 *     не даёт документу письма прокручиваться самому: колесо над письмом прокручивает переписку;
 *   - не даёт документу уйти со своего адреса: щелчок по ссылке не переходит по ней, а
 *     отправляет адрес родителю (тот откроет его новой вкладкой), перетаскивание отклоняется;
 *   - сообщает адрес ссылки под курсором: страница почты показывает, куда она ведёт на самом
 *     деле, что бы ни было написано в письме.
 * Всё, что актор отправляет родителю, родитель проверяет заново: процесс страницы не доверенный. */

const MAX_HEIGHT = 200_000;

export class TaboraMailViewChild extends JSWindowActorChild {
  handleEvent(event) {
    if (!this.ours()) {
      return;
    }
    switch (event.type) {
      case "DOMContentLoaded":
        this.start();
        break;
      case "click":
      case "auxclick":
        this.onClick(event);
        break;
      case "mouseover":
      case "mouseout":
        this.onHover(event);
        break;
      case "dragover":
      case "drop":
      case "submit":
        event.preventDefault();
        event.stopPropagation();
        break;
    }
  }

  /** Актор работает только в документе письма: верхний уровень, адрес data:. */
  ours() {
    const doc = this.document;
    return !!doc && this.browsingContext === this.browsingContext.top && doc.documentURI.startsWith("data:text/html");
  }

  start() {
    const doc = this.document;
    const win = this.contentWindow;
    // Письмо занимает на странице всю свою высоту и само не прокручивается. Если бы у него
    // оставался хоть пиксель своей прокрутки, колесо над письмом сначала выбирало бы его, и
    // переписка под курсором не двигалась. Правило стоит на самом элементе с важностью: стили
    // письма его не перекроют.
    doc.documentElement.style.setProperty("overflow", "hidden", "important");
    // Высота и ширина содержимого и ширина окна письма (всё в единицах самого письма): по ним
    // страница почты отводит письму место и, если письмо шире, уменьшает его масштаб.
    let floor = 0;
    let floorView = 0;
    const report = () => {
      const root = doc.documentElement;
      const body = doc.body;
      const view = Math.round(win.innerWidth);
      // Содержимое, которое выступает за измеренные блоки (внешние отступы, абсолютные блоки),
      // видно по высоте прокрутки. Она не меньше высоты окна, поэтому годится только пока
      // письмо не помещается; найденная так высота держится до смены ширины.
      if (view !== floorView) {
        floorView = view;
        floor = 0;
      }
      if (root.scrollHeight > win.innerHeight + 0.5) {
        floor = root.scrollHeight;
      }
      const height = Math.min(MAX_HEIGHT, Math.ceil(Math.max(root.getBoundingClientRect().height, body ? body.getBoundingClientRect().bottom : 0, floor)));
      const width = Math.ceil(Math.max(root.scrollWidth, body ? body.scrollWidth : 0));
      const key = `${height}|${width}|${view}`;
      if (key !== this._size) {
        this._size = key;
        this.sendAsyncMessage("TaboraMailView:Size", { height, width, view });
      }
    };
    this._observer = new win.ResizeObserver(report);
    this._observer.observe(doc.documentElement);
    if (doc.body) {
      this._observer.observe(doc.body);
    }
    report();
  }

  onHover(event) {
    const link = event.type === "mouseover" ? event.target?.closest?.("a[href], area[href]") : null;
    const href = link ? String(link.href).slice(0, 4096) : "";
    if (href !== this._hover) {
      this._hover = href;
      this.sendAsyncMessage("TaboraMailView:Hover", { href });
    }
  }

  onClick(event) {
    const link = event.target?.closest?.("a[href], area[href]");
    if (!link) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 0 || event.button === 1) {
      this.sendAsyncMessage("TaboraMailView:Link", { href: String(link.href).slice(0, 4096) });
    }
  }

  didDestroy() {
    this._observer?.disconnect();
    this._observer = null;
  }
}
