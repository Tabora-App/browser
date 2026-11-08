/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class TaboraCookiesParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "TaboraCookies:Handled") {
      return;
    }
    const win = this.browsingContext.topChromeWindow;
    win?.Tabora?.cookieBannerHandled?.(message.data, this.browsingContext.top);
  }
}
