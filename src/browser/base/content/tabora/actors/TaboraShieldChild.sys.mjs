/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Актор страницы для блокировщика рекламы: добавляет документу стили, прячущие рекламные блоки.
 * Какие именно — решает родитель (shield/Shield.sys.mjs). Стили встают на уровне браузера
 * (AGENT_SHEET): страница не может их ни увидеть, ни перебить. Кода на странице актор не
 * выполняет и её содержимого не читает.
 *
 * The one exception is the YouTube player (TubeSkipper below): there the actor watches the
 * player for the start of an ad and skips it. It still runs nothing in the page's own world: it
 * works with the page's video element and buttons from outside.
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

/* ---- ads inside YouTube videos ---------------------------------------------------------------
 * The player marks an ad with a class on its root element. While the class is there:
 *   - the sound is off and the ad's picture is hidden by a sheet of the browser (its text comes
 *     from the parent);
 *   - "Skip" is pressed as soon as the button exists;
 *   - the ad is played at the highest speed the engine has (16x): fifteen seconds take one.
 * The ad is never moved to its end: where an ad is a part of the same stream as the video, that
 * would end the video itself. For the same reason the video the person came for is not sped up
 * in the first moments of a break, while the player has not replaced it with the ad yet.
 * A pod of several ads is passed one after another. If an ad does not move (a live one, a stalled
 * one), the sheet is taken away and the sound and the speed are given back, so a person sees the
 * ad and its own controls instead of a black player. */

const AD_PLAYER = ".html5-video-player.ad-showing, .html5-video-player.ad-interrupting";
const AD_SKIP = ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button, .ytp-ad-skip-button-slot button";
const TICK_MS = 150;
const GAP_MS = 400; // how long the video itself may still be in the player after a break began
const STUCK_MS = 5000; // an ad that plays, but no faster than a person would watch it
const BREAK_MS = 25000; // the longest an ad break stays hidden
const FAST = 16;
const MEDIA_EVENTS = ["playing", "durationchange", "loadedmetadata"];

class TubeSkipper {
  constructor(win, css, report) {
    this.win = win;
    this.utils = win.windowUtils;
    this.hideUri = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
    this.report = report;
    this.hidden = false;
    this.breakAt = 0; // when the current ad break was noticed
    this.timer = null;
    this.pending = false;
    this.given = false; // this break could not be passed and is shown to the person as it is
    this.did = new Set(); // what was done to the ads of this break
    this.saved = new Map(); // video -> { muted, rate } as they were before the break
    this.marks = new WeakMap(); // video -> { key, at, pos } for the ad it plays now
    this.content = null; // { page, duration, src } of the video itself, seen while no ad was shown
    this.onMedia = () => this.check();
  }

  start() {
    this.hide(true);
    const doc = this.win.document;
    this.observer = new this.win.MutationObserver(() => this.soon());
    this.observer.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    // media events do not bubble: they are caught on their way down
    for (const type of MEDIA_EVENTS) {
      this.win.addEventListener(type, this.onMedia, { capture: true });
    }
    this.check();
  }

  stop() {
    this.observer?.disconnect();
    try {
      this.win.clearInterval(this.timer);
      for (const type of MEDIA_EVENTS) {
        this.win.removeEventListener(type, this.onMedia, { capture: true });
      }
    } catch (e) {}
    this.timer = null;
  }

  /** The player changes its classes many times a second: one look per turn of the event loop is enough. */
  soon() {
    if (!this.pending) {
      this.pending = true;
      this.win.setTimeout(() => {
        this.pending = false;
        this.check();
      }, 0);
    }
  }

  hide(on) {
    if (this.hidden === on) {
      return;
    }
    try {
      if (on) {
        this.utils.loadSheetUsingURIString(this.hideUri, this.utils.AGENT_SHEET);
      } else {
        this.utils.removeSheetUsingURIString(this.hideUri, this.utils.AGENT_SHEET);
      }
      this.hidden = on;
    } catch (e) {}
  }

  page() {
    const { pathname, search } = this.win.location;
    return pathname + search;
  }

  check() {
    let doc = null;
    let player = null;
    try {
      doc = this.win.document;
      player = doc.querySelector(AD_PLAYER);
    } catch (e) {
      return; // the document is gone
    }
    if (!player) {
      this.end();
      this.learn(doc);
      return;
    }
    if (!this.breakAt) {
      this.breakAt = Date.now();
      this.timer = this.win.setInterval(() => this.check(), TICK_MS);
    }
    this.skip(player);
  }

  /** The video itself: the one in the player while no ad is shown. */
  learn(doc) {
    const video = doc.querySelector(".html5-video-player video");
    const duration = video?.duration;
    if (Number.isFinite(duration) && duration > 0) {
      this.content = { page: this.page(), duration, src: video.currentSrc };
    }
  }

  skip(player) {
    for (const button of player.querySelectorAll(AD_SKIP)) {
      button.click();
      if (button.getClientRects().length) {
        this.did.add("button"); // one a person could have pressed
      }
    }
    if (this.given) {
      return;
    }
    const now = Date.now();
    if (now - this.breakAt > BREAK_MS) {
      this.give();
      return;
    }
    const known = this.content?.page === this.page() ? this.content : null;
    for (const video of player.querySelectorAll("video")) {
      if (!this.saved.has(video)) {
        this.saved.set(video, { muted: video.muted, rate: video.playbackRate });
      }
      if (!video.muted) {
        video.muted = true;
      }
      if (video.paused || video.readyState < 1) {
        this.marks.delete(video); // the time an ad stands still does not count against it
        continue;
      }
      const end = video.duration;
      const itself = known && video.currentSrc === known.src && Math.abs(end - known.duration) <= 1;
      if (itself && now - this.breakAt < GAP_MS) {
        continue; // the player has not put the ad in place of the video yet
      }
      const key = `${video.currentSrc}|${end}`;
      let mark = this.marks.get(video);
      if (!mark || mark.key !== key) {
        mark = { key, at: now, pos: video.currentTime };
        this.marks.set(video, mark);
      }
      if (video.playbackRate !== FAST) {
        video.playbackRate = FAST;
        this.did.add("fast");
      }
      const waited = now - mark.at;
      if (waited > STUCK_MS && (video.currentTime - mark.pos) * 1000 < waited * 3) {
        this.give();
        return;
      }
    }
  }

  /** The break could not be passed: the person gets it as the site shows it. */
  give() {
    this.given = true;
    this.hide(false);
    this.restore();
    this.tell(true);
  }

  tell(given) {
    try {
      this.report({ ms: Date.now() - this.breakAt, did: [...this.did], given });
    } catch (e) {}
    this.did.clear();
  }

  /** Give the sound and the speed back as they were before the break. */
  restore() {
    for (const [video, was] of this.saved) {
      try {
        if (video.muted !== was.muted) {
          video.muted = was.muted;
        }
        if (video.playbackRate === FAST && was.rate !== FAST) {
          video.playbackRate = was.rate;
        }
      } catch (e) {}
    }
    this.saved.clear();
  }

  end() {
    if (!this.breakAt) {
      return;
    }
    this.win.clearInterval(this.timer);
    this.timer = null;
    if (!this.given) {
      this.tell(false);
    }
    this.breakAt = 0;
    this.given = false;
    this.marks = new WeakMap();
    this.restore();
    this.hide(true);
  }
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
    if (style.tube && !this._tube) {
      try {
        this._tube = new TubeSkipper(win, style.tube, info => this.sendAsyncMessage("Shield:Tube", info));
        this._tube.start();
      } catch (e) {
        console.error("Tabora shield: the YouTube ad skipper did not start", e);
      }
    }
  }

  didDestroy() {
    try {
      this._tube?.stop();
    } catch (e) {}
    this._tube = null;
  }
}
