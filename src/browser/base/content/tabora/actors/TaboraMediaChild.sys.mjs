/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Собирает картинки и видео со страницы для раздела «Медиа» в ящике Tabora. */

const MIN_SIDE = 72;
const LIMIT = 80;

export class TaboraMediaChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name !== "TaboraMedia:Collect") {
      return null;
    }
    const doc = this.document;
    if (!doc || !doc.location || !/^https?:$/.test(doc.location.protocol)) {
      return [];
    }
    const seen = new Set();
    const out = [];
    const push = item => {
      if (!item.src || seen.has(item.src) || !/^https?:/.test(item.src)) {
        return;
      }
      seen.add(item.src);
      out.push({ ...item, page: doc.location.href, title: doc.title });
    };
    for (const img of doc.images) {
      if (out.length >= LIMIT) {
        break;
      }
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < MIN_SIDE || h < MIN_SIDE) {
        continue;
      }
      push({ kind: "image", src: img.currentSrc || img.src, w, h, alt: img.alt || "" });
    }
    for (const video of doc.querySelectorAll("video")) {
      if (out.length >= LIMIT) {
        break;
      }
      const src = video.currentSrc || video.src || video.querySelector("source")?.src || "";
      push({ kind: "video", src, poster: video.poster || "", w: video.videoWidth, h: video.videoHeight, alt: video.title || "" });
    }
    return out;
  }
}
