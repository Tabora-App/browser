/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Родительская часть актора блокировщика рекламы: отвечает документу, какие стили скрытия ему
 * применить. Хост документа и страницы берётся из принципалов, а не из сообщения: страница не
 * может выпросить себе чужие правила или отключить свои. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Shield: "chrome://tabora/content/shield/Shield.sys.mjs",
});

export class TaboraShieldParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name === "Shield:Tube") {
      try {
        lazy.Shield.tubePassed(this.manager, message.data);
      } catch (e) {}
      return null;
    }
    if (message.name !== "Shield:Style") {
      return null;
    }
    const answer = () => {
      try {
        return lazy.Shield.styleFor(this.manager);
      } catch (e) {
        return { off: true };
      }
    };
    // правила ещё собираются (первые мгновения после запуска): документ получит стили, когда соберутся
    const settling = lazy.Shield.settling();
    return settling ? settling.then(answer) : answer();
  }
}
