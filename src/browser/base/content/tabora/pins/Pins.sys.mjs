/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Pinned sites of the account, shared by all its windows. In the engine a pinned tab belongs to one
 * window, so a new window started with no pinned tabs at all. Here the list of pinned sites lives in
 * the profile (tabora-pins.json), and every window keeps a pinned tab for each entry (pins/pins.js).
 * Windows learn about changes through the TOPIC notification.
 *
 * An entry: { id, u: address, t: title, c: container of the space it was pinned in }. */

const FILE = "tabora-pins.json";
const MAX = 100;
const ID_RE = /^[a-z0-9]{8,24}$/;

function valid(p) {
  return (
    !!p &&
    typeof p.id === "string" &&
    ID_RE.test(p.id) &&
    typeof p.u === "string" &&
    p.u.length <= 8192 &&
    /^https?:\/\//i.test(p.u) &&
    URL.canParse(p.u) &&
    typeof p.t === "string" &&
    Number.isInteger(p.c) &&
    p.c >= 0
  );
}

export const Pins = {
  TOPIC: "tabora-pins-changed",

  _list: [],
  _loaded: null,
  _writing: Promise.resolve(),
  // No list in the profile yet (or it could not be read): windows then build it from the tabs they
  // have, tagged ones included, instead of letting those tabs go.
  fresh: false,

  get path() {
    return PathUtils.join(PathUtils.profileDir, FILE);
  },

  /** Resolves once the list is read from the profile. */
  ready() {
    this._loaded ||= (async () => {
      try {
        const data = await IOUtils.readJSON(this.path);
        const seen = new Set();
        this._list = (Array.isArray(data?.pins) ? data.pins : [])
          .filter(p => valid(p) && !seen.has(p.id) && seen.add(p.id))
          .slice(0, MAX)
          .map(p => ({ id: p.id, u: p.u, t: p.t.slice(0, 300), c: p.c }));
      } catch (e) {
        if (!(DOMException.isInstance(e) && e.name === "NotFoundError")) {
          console.error("Tabora: pinned sites", e);
        }
        this._list = [];
        this.fresh = true;
      }
    })();
    return this._loaded;
  },

  get list() {
    return this._list;
  },

  has(id) {
    return this._list.some(p => p.id === id);
  },

  /** Adds a site before the entry `before` (at the end without it). Returns its id, "" if it cannot be added. */
  add({ id = "", u, t = "", c = 0 }, before = "") {
    const own = ID_RE.test(id) && !this.has(id) ? id : Services.uuid.generateUUID().toString().replace(/[^0-9a-f]/g, "").slice(0, 16);
    const pin = { id: own, u, t: String(t).slice(0, 300), c };
    if (!valid(pin) || this._list.length >= MAX) {
      return "";
    }
    const at = before ? this._list.findIndex(p => p.id === before) : -1;
    this._list.splice(at < 0 ? this._list.length : at, 0, pin);
    this._changed();
    return pin.id;
  },

  remove(id) {
    const next = this._list.filter(p => p.id !== id);
    if (next.length !== this._list.length) {
      this._list = next;
      this._changed();
    }
  },

  /** The order one window has: the entries it names come first, in its order; the rest keep theirs. */
  order(ids) {
    const byId = new Map(this._list.map(p => [p.id, p]));
    const next = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean);
    for (const p of this._list) {
      if (!next.includes(p)) {
        next.push(p);
      }
    }
    if (next.some((p, i) => p !== this._list[i])) {
      this._list = next;
      this._changed();
    }
  },

  _changed() {
    const data = { version: 1, pins: this._list };
    this._writing = this._writing
      .then(() => IOUtils.writeJSON(this.path, data, { tmpPath: `${this.path}.tmp` }))
      .catch(e => console.error("Tabora: pinned sites", e));
    Services.obs.notifyObservers(null, this.TOPIC);
  },
};
