/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Checking saved passwords against passwords that appeared in known breaches.
 *
 * The service is Pwned Passwords (Have I Been Pwned). A password never leaves the computer, and
 * neither does its hash: the SHA-1 hash is computed here, only its first five characters are
 * sent, and the service answers with every hash ending that starts with them (several hundred of
 * them). The comparison happens here. The request asks for a padded answer, so the size of the
 * answer says nothing about the password either.
 *
 * Nothing here runs by itself: the check starts only when the person asks for it
 * (Settings → Account → Security). The module does not read the password store; the caller hands
 * the logins over, which also lets the check be tested without a browser. */

const RANGE_URL = "https://api.pwnedpasswords.com/range/";
const PREFIX = 5;
const PARALLEL = 4;
const TIMEOUT_MS = 15000;

async function sha1(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out.toUpperCase();
}

// Timers are not globals in a browser module (and AbortSignal.timeout needs a window there).
const timers = globalThis.setTimeout
  ? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  : ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/** Hash endings known to the service for a prefix: Map "ending" → how many times it was seen. */
async function fetchRange(prefix) {
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(RANGE_URL + prefix, {
      headers: { "Add-Padding": "true" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal,
    });
    text = await res.text();
  } finally {
    timers.clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const out = new Map();
  for (const line of text.split("\n")) {
    const [ending, count] = line.trim().split(":");
    // padding lines carry a zero count
    if (ending && Number(count) > 0) {
      out.set(ending.toUpperCase(), Number(count));
    }
  }
  return out;
}

export const Breach = {
  /**
   * Check logins. Each distinct password is looked up once, however many sites share it.
   *
   * @param {{ origin: string, username: string, password: string }[]} logins
   * @param {{ onProgress?: (done: number, total: number) => void, range?: (prefix: string) => Promise<Map<string, number>> }} [options]
   *   range replaces the request to the service in tests.
   * @returns {Promise<{ checked: number, failed: number, found: { origin: string, username: string, count: number }[] }>}
   *   checked: logins whose password was looked up; failed: logins the service did not answer
   *   for; found: logins whose password is in a breach, most frequent first.
   */
  async check(logins, { onProgress = null, range = fetchRange } = {}) {
    const byHash = new Map(); // full hash → logins that use this password
    for (const login of logins) {
      if (typeof login?.password !== "string" || !login.password) {
        continue;
      }
      const hash = await sha1(login.password);
      if (!byHash.has(hash)) {
        byHash.set(hash, []);
      }
      byHash.get(hash).push(login);
    }
    const prefixes = [...new Set([...byHash.keys()].map(h => h.slice(0, PREFIX)))];
    const answers = new Map(); // prefix → Map of endings, or null if the service did not answer
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < prefixes.length) {
        const prefix = prefixes[next++];
        try {
          answers.set(prefix, await range(prefix));
        } catch (e) {
          answers.set(prefix, null);
        }
        done++;
        try {
          onProgress?.(done, prefixes.length);
        } catch (e) {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, prefixes.length) }, worker));

    const found = [];
    let checked = 0;
    let failed = 0;
    for (const [hash, users] of byHash) {
      const endings = answers.get(hash.slice(0, PREFIX));
      if (!endings) {
        failed += users.length;
        continue;
      }
      checked += users.length;
      const count = endings.get(hash.slice(PREFIX)) || 0;
      if (count > 0) {
        for (const login of users) {
          found.push({ origin: String(login.origin || ""), username: String(login.username || ""), count });
        }
      }
    }
    found.sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin));
    return { checked, failed, found };
  },
};
