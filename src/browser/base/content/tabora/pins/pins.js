/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Pinned sites in a window. The list is common to all windows of the account (pins/Pins.sys.mjs);
 * this window keeps one pinned tab for each site, in the list's order. A site pinned, unpinned or
 * moved here changes the list, and the other windows follow. A tab made for a site pinned elsewhere
 * stays unloaded until the person opens it. Closing a pinned tab unloads it: the tile stays, and only
 * "Unpin" removes the site. Private windows take no part.
 *
 * A tab knows its site by a value kept with the session (PIN_KEY), so it survives a restart.
 * Loaded from tabora.js. */

Object.assign(Tabora, {
  PIN_KEY: "tabora-pin",
  // set on a copy the person has not opened in this window; such a copy is unloaded again after a restart
  PIN_IDLE: "tabora-pin-idle",
  _pinsMod: null,
  _pinsOn: false,
  _pinsBusy: false,
  _pinsQueued: false,
  _pinsRan: false,

  pinsMod() {
    if (!this._pinsMod) {
      this._pinsMod = ChromeUtils.importESModule("chrome://tabora/content/pins/Pins.sys.mjs").Pins;
    }
    return this._pinsMod;
  },

  initPins() {
    if (PrivateBrowsingUtils.isWindowPrivate(window)) {
      return;
    }
    const Pins = this.pinsMod();
    const observer = () => this.pinsSchedule();
    Services.obs.addObserver(observer, Pins.TOPIC);
    window.addEventListener("unload", () => Services.obs.removeObserver(observer, Pins.TOPIC), { once: true });
    const tabs = gBrowser.tabContainer;
    tabs.addEventListener("TabPinned", () => this.pinsSchedule());
    tabs.addEventListener("TabClose", e => e.target.pinned && this.pinsSchedule());
    tabs.addEventListener("TabUnpinned", e => this.pinsUnpinned(e.target));
    tabs.addEventListener("TabMove", e => this.pinsMoved(e.target));
    tabs.addEventListener("TabSelect", e => SessionStore.getCustomTabValue(e.target, this.PIN_IDLE) && SessionStore.deleteCustomTabValue(e.target, this.PIN_IDLE));
    window.addEventListener("SSWindowRestored", () => this.pinsSchedule());
    // Not before the session is back: a restored tab gets its pinned state first and its tag after.
    (async () => {
      await window.delayedStartupPromise;
      await window.SessionStore?.promiseAllWindowsRestored;
      await Pins.ready();
      this._pinsOn = true;
      this.pinsSchedule();
    })().catch(e => console.error("Tabora: pinned sites", e));
  },

  /** One run for any number of changes; not a timer: timers of a window in the background are held back. */
  pinsSchedule() {
    if (!this._pinsOn || this._pinsBusy || this._pinsQueued) {
      return;
    }
    this._pinsQueued = true;
    Services.tm.dispatchToMainThread(() => {
      this._pinsQueued = false;
      this.pinsReconcile();
    });
  },

  pinOf(tab) {
    return SessionStore.getCustomTabValue(tab, this.PIN_KEY);
  },

  pinTag(tab, id) {
    if (id) {
      SessionStore.setCustomTabValue(tab, this.PIN_KEY, id);
    } else {
      SessionStore.deleteCustomTabValue(tab, this.PIN_KEY);
    }
  },

  pinAsleep(tab) {
    return tab.hasAttribute("pending") || !tab.linkedPanel;
  },

  /** The address a pinned tab shows; for an unloaded one, the address it will open. */
  pinUrlOf(tab) {
    if (!this.pinAsleep(tab)) {
      return tab.linkedBrowser?.currentURI?.spec || "";
    }
    try {
      const state = JSON.parse(SessionStore.getTabState(tab));
      return state.entries?.[(state.index || state.entries.length) - 1]?.url || "";
    } catch (e) {
      return "";
    }
  },

  /** Bring this window's pinned tabs in line with the list. Safe to run at any time. */
  pinsReconcile() {
    if (!this._pinsOn || this._pinsBusy || window.closed) {
      return;
    }
    const Pins = this.pinsMod();
    const pinned = () => gBrowser.tabs.filter(t => t.pinned && !t.closing);
    const byId = new Map(); // site → the tab that stands for it here
    // A tab that no longer stands for a site: an unloaded copy goes away, a page in use stays as a plain
    // tab. `spare`: a second tab for the same site that start-up brought back from another window.
    const letGo = (tab, spare = false) => {
      this.pinTag(tab, "");
      SessionStore.deleteCustomTabValue(tab, this.PIN_IDLE);
      if (!tab.selected && (spare || this.pinAsleep(tab))) {
        gBrowser.removeTab(tab, { animate: false });
      } else {
        gBrowser.unpinTab(tab);
      }
    };
    // With no list in the profile, the first run in a window takes the sites of its tagged tabs back
    // into the list; later a tag the list does not know means the site was unpinned elsewhere.
    const first = !this._pinsRan;
    const adopt = Pins.fresh && first;
    this._pinsRan = true;
    this._pinsBusy = true;
    try {
      for (const tab of gBrowser.tabs) {
        if (!tab.pinned && this.pinOf(tab)) {
          this.pinTag(tab, ""); // unpinned by something other than the person: a plain tab from now on
        }
      }
      // Tabs that already stand for a site: one per site, a loaded page rather than an unloaded copy.
      for (const tab of pinned()) {
        const id = this.pinOf(tab);
        if (!id) {
          continue;
        }
        if (!Pins.has(id) && !(adopt && Pins.add({ id, u: this.pinUrlOf(tab), t: tab.label || "", c: this.contextOf(tab) }))) {
          letGo(tab);
          continue;
        }
        const had = byId.get(id);
        if (!had) {
          byId.set(id, tab);
        } else if ((this.pinAsleep(had) && !this.pinAsleep(tab)) || tab.selected) {
          byId.set(id, tab);
          letGo(had, first);
        } else {
          letGo(tab, first);
        }
      }
      // Pinned tabs with no site yet: kept from before, pinned just now, or moved in from another window.
      for (const tab of pinned()) {
        if (this.pinOf(tab)) {
          continue;
        }
        const u = this.pinUrlOf(tab);
        const c = this.contextOf(tab);
        if (!/^https?:\/\//i.test(u)) {
          continue; // the start page and internal pages stay pinned in this window only
        }
        const twin = Pins.list.find(p => p.u === u && p.c === c && (!byId.has(p.id) || this.pinAsleep(byId.get(p.id))));
        let id = twin?.id || "";
        if (twin && byId.has(id)) {
          letGo(byId.get(id));
        }
        if (!id) {
          // before the next site of this window, so the tile keeps the place it was pinned at
          const rest = pinned();
          const next = rest.slice(rest.indexOf(tab) + 1).map(t => this.pinOf(t)).find(x => x && Pins.has(x));
          id = Pins.add({ u, t: tab.label || "", c }, next || "");
        }
        if (id) {
          this.pinTag(tab, id);
          byId.set(id, tab);
        }
      }
      // An unloaded copy for every site this window does not have.
      for (const pin of Pins.list) {
        if (byId.has(pin.id)) {
          continue;
        }
        // pinned after it is made: an unloaded tab gets its state on creation, and that state unpins it
        const tab = gBrowser.addTab(pin.u, {
          createLazyBrowser: true,
          lazyTabTitle: pin.t || pin.u,
          userContextId: pin.c,
          skipAnimation: true,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        gBrowser.pinTab(tab);
        this.pinTag(tab, pin.id);
        SessionStore.setCustomTabValue(tab, this.PIN_IDLE, "1");
        byId.set(pin.id, tab);
      }
      // The same order in every window, and an icon for the tiles that have not been opened here.
      Pins.list.forEach((pin, i) => {
        const tab = byId.get(pin.id);
        if (!tab) {
          return;
        }
        if (tab._tPos !== i) {
          gBrowser.moveTabTo(tab, { tabIndex: i });
        }
        // The session brings every pinned tab back loaded; a copy nobody opened here goes back to sleep.
        if (first && !tab.selected && tab.linkedPanel && SessionStore.getCustomTabValue(tab, this.PIN_IDLE)) {
          gBrowser.discardBrowser(tab, true);
        }
        if (this.pinAsleep(tab) && !tab.getAttribute("image")) {
          tab.setAttribute("image", `page-icon:${pin.u}`);
          gBrowser._tabAttrModified(tab, ["image"]);
        }
      });
    } catch (e) {
      console.error("Tabora: pinned sites", e);
    } finally {
      this._pinsBusy = false;
    }
  },

  pinsUnpinned(tab) {
    if (!this._pinsOn || this._pinsBusy) {
      return;
    }
    const id = this.pinOf(tab);
    if (id) {
      this.pinTag(tab, "");
      this.pinsMod().remove(id);
    }
  },

  pinsMoved(tab) {
    if (!this._pinsOn || this._pinsBusy || !tab.pinned || !this.pinOf(tab)) {
      return;
    }
    this.pinsMod().order(gBrowser.tabs.filter(t => t.pinned && !t.closing).map(t => this.pinOf(t)).filter(Boolean));
  },
});
