/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Баннеры cookie: находим окно согласия и нажимаем за пользователя «Отклонить»
 * или «Только необходимые» (режим в pref tabora.cookies.banners: reject | accept | off).
 * Сначала правила известных систем согласия, затем текстовая эвристика. */

const PREF = "tabora.cookies.banners";
const RETRIES_MS = [0, 400, 1200, 2500, 5000, 9000];

const RULES = [
  // [селектор «отклонить»/«только необходимые», селектор «принять»]
  ["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler"],
  ["#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"],
  ["#didomi-notice-disagree-button, .didomi-continue-without-agreeing", "#didomi-notice-agree-button"],
  [".qc-cmp2-summary-buttons button[mode=secondary]", ".qc-cmp2-summary-buttons button[mode=primary]"],
  ["#truste-consent-required", "#truste-consent-button"],
  [".osano-cm-denyAll, .osano-cm-button--type_denyAll", ".osano-cm-accept-all"],
  ["button[data-cky-tag=reject-button], .cky-btn-reject", ".cky-btn-accept"],
  ["#cookiescript_reject", "#cookiescript_accept"],
  [".cc-btn.cc-deny, .cc-deny", ".cc-btn.cc-allow, .cc-allow"],
  ["#CookieBoxSaveButton, .cookie-consent__reject", ".cookie-consent__accept"],
  ["button[title='Reject All'], button[title='Отклонить все'], button[title='Reject all']", "button[title='Accept All'], button[title='Принять все']"],
  ["#gdpr-cookie-reject, .gdpr-reject", "#gdpr-cookie-accept"],
  ["button[data-id='button-all'].reject", "button[data-id='button-all']"],
];

const REJECT = /^(?:reject(?: all)?(?: cookies)?|decline(?: all)?|deny(?: all)?|refuse(?: all)?|disagree|only (?:essential|necessary|required)(?: cookies)?|(?:essential|necessary|strictly necessary) (?:cookies )?only|allow (?:only )?(?:essential|necessary)(?: cookies)?(?: only)?|use (?:only )?(?:essential|necessary)(?: cookies)?|continue without (?:accepting|agreeing)|отклонить(?: вс[её])?|отказаться(?: от всех)?|только (?:необходимые|обязательные|нужные)(?: cookie| куки| файлы cookie)?|запретить(?: все)?|не принимать|alle ablehnen|ablehnen|nur (?:notwendige|erforderliche)|tout refuser|refuser(?: tout)?|rechazar(?: todo)?|rifiuta(?: tutto)?|weigeren|odrzuć(?: wszystkie)?|odmítnout(?: vše)?)[.!]?$/i;
const ACCEPT = /^(?:accept(?: all)?(?: cookies)?|allow all(?: cookies)?|agree(?: and close)?|i agree|ok(?:ay)?|got it|принять(?: вс[её])?|разрешить вс[её]|согласен|согласиться|хорошо|понятно|alle akzeptieren|akzeptieren|tout accepter|aceptar(?: todo)?|accetta(?: tutto)?|zaakceptuj|přijmout)[.!]?$/i;
const BANNER_WORDS = /cookie|куки|consent|gdpr|согласи|privacy|конфиденциальн|datenschutz|файл[ыа]? cookie/i;

export class TaboraCookiesChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type === "DOMContentLoaded" || event.type === "pageshow") {
      this.start();
    }
  }

  start() {
    if (this._timers) {
      return;
    }
    const mode = Services.prefs.getStringPref(PREF, "reject");
    if (mode === "off" || !/^https?:$/.test(this.document?.location?.protocol || "")) {
      return;
    }
    this._done = false;
    this._timers = RETRIES_MS.map(ms => this.contentWindow.setTimeout(() => this.scan(mode), ms));
  }

  didDestroy() {
    for (const t of this._timers || []) {
      this.contentWindow?.clearTimeout(t);
    }
  }

  visible(el) {
    if (!el || !el.isConnected) {
      return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) {
      return false;
    }
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
  }

  textOf(el) {
    return (el.getAttribute("aria-label") || el.value || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** Элемент похож на баннер: закреплён поверх страницы или назван как cookie/consent. */
  bannerAncestor(el) {
    let node = el;
    for (let i = 0; i < 10 && node && node !== this.document.body; i++) {
      const cs = node.ownerDocument.defaultView.getComputedStyle(node);
      const idc = `${node.id} ${node.className && typeof node.className === "string" ? node.className : ""}`;
      if (cs.position === "fixed" || cs.position === "sticky" || /cookie|consent|gdpr|privacy|cmp|banner|notice|couki|куки/i.test(idc)) {
        return node;
      }
      node = node.parentElement;
    }
    // отдельный документ в iframe целиком является баннером
    return this.browsingContext.parent ? this.document.body : null;
  }

  scan(mode) {
    if (this._done) {
      return;
    }
    const doc = this.document;
    if (!doc?.body) {
      return;
    }
    const want = mode === "accept" ? 1 : 0;
    for (const rule of RULES) {
      const sel = rule[want] || rule[0];
      let el = null;
      try {
        el = doc.querySelector(sel);
      } catch (e) {}
      if (el && this.visible(el)) {
        this.press(el, `rule:${sel.split(",")[0].trim()}`);
        return;
      }
    }
    // Usercentrics в shadow DOM
    const uc = doc.getElementById("usercentrics-root")?.shadowRoot;
    if (uc) {
      const el = uc.querySelector(want ? "[data-testid=uc-accept-all-button]" : "[data-testid=uc-deny-all-button]");
      if (el) {
        this.press(el, "rule:usercentrics");
        return;
      }
    }
    // Эвристика по тексту кнопок внутри баннера
    const pattern = want ? ACCEPT : REJECT;
    const candidates = [];
    for (const el of doc.querySelectorAll("button, a[role=button], [role=button], input[type=button], input[type=submit], a.btn, a.button")) {
      const text = this.textOf(el);
      if (!text || text.length > 60 || !pattern.test(text) || !this.visible(el)) {
        continue;
      }
      if (/subscribe|подпис|pay|€|\$|£|premium|ad-lite/i.test(text) || /subscribe|подпис/i.test(el.closest("a, button")?.getAttribute("href") || "")) {
        continue; // «отклонить и подписаться» — это оплата, не отказ
      }
      const banner = this.bannerAncestor(el);
      if (!banner) {
        continue;
      }
      const bannerText = (banner.textContent || "").slice(0, 4000);
      if (!BANNER_WORDS.test(bannerText) && !BANNER_WORDS.test(doc.title)) {
        continue;
      }
      // Предпочитаем «отклонить всё», затем «только необходимые»
      const score = /reject|decline|deny|refuse|отклон|отказ|ablehnen|refuser|rechazar/i.test(text) ? 2 : 1;
      candidates.push({ el, text, score });
    }
    if (!candidates.length) {
      return;
    }
    candidates.sort((a, b) => b.score - a.score);
    this.press(candidates[0].el, `text:${candidates[0].text}`);
  }

  press(el, how) {
    this._done = true;
    for (const t of this._timers || []) {
      this.contentWindow?.clearTimeout(t);
    }
    try {
      el.click();
    } catch (e) {
      return;
    }
    this.sendAsyncMessage("TaboraCookies:Handled", {
      host: this.document.location.hostname.replace(/^www\./, ""),
      how,
      text: this.textOf(el).slice(0, 40),
      frame: !!this.browsingContext.parent,
    });
  }
}
