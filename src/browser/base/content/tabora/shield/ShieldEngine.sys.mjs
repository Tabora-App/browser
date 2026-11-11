/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Движок блокировщика рекламы: разбор списков фильтров в формате Adblock Plus (EasyList,
 * EasyPrivacy, RU AdList) и сопоставление с ними запросов и страниц. Здесь только вычисления:
 * ни сети, ни файлов, ни интерфейсов браузера — перехват запросов, загрузка списков и стили
 * страниц в shield/Shield.sys.mjs.
 *
 * Что понимает движок.
 *  Сетевые правила: ||хост^, |начало, конец|, разделитель ^, звёздочка, /регулярное выражение/;
 *  исключения @@; параметры вида ресурса (script, image, stylesheet, xmlhttprequest, subdocument,
 *  websocket, ping, media, font, object, other и их отрицания), third-party и first-party,
 *  domain= (from=), denyallow=, match-case, important, badfilter, all; параметры страницы у
 *  исключений: document, elemhide, generichide.
 *  Правила скрытия: ##селектор (общие), сайт##селектор, ~сайт##селектор, исключения #@#.
 *
 * Чего не делает намеренно. Правила, которым нужно выполнять код на странице или переписывать
 * ответы сервера (сценарии ##+js, #$#, #%#, redirect-rule, csp, removeparam, replace, header),
 * пропускаются: блокировщик только отменяет запросы и прячет элементы стилями. Правило с
 * незнакомым параметром пропускается целиком: применить его наполовину значит блокировать
 * лишнее.
 *
 * Скорость. Правила вида ||хост^ лежат в таблице по хосту и находятся по суффиксам хоста
 * запроса. Остальные разложены по одному слову из своего шаблона: запрос проверяет только
 * правила, чьё слово встретилось в его адресе. Шаблон превращается в регулярное выражение при
 * первой проверке. */

export const TYPE = {
  script: 1, image: 2, stylesheet: 4, object: 8, xhr: 16, subdocument: 32, ping: 64, websocket: 128, media: 256, font: 512, other: 1024,
  document: 2048, elemhide: 4096, generichide: 8192,
};
const TYPE_ALIAS = {
  script: "script", image: "image", stylesheet: "stylesheet", css: "stylesheet", object: "object", "object-subrequest": "object", xmlhttprequest: "xhr", xhr: "xhr",
  subdocument: "subdocument", frame: "subdocument", ping: "ping", beacon: "ping", websocket: "websocket", media: "media", font: "font", other: "other",
  document: "document", doc: "document", elemhide: "elemhide", ehide: "elemhide", generichide: "generichide", ghide: "generichide",
};
const ALL_RESOURCES = 2047; // все виды ресурсов, без параметров страницы
const PAGE_BITS = TYPE.document | TYPE.elemhide | TYPE.generichide;

const F_HOST = 1; // шаблон начинается с ||
const F_START = 2; // |в начале
const F_END = 4; // в конце|
const F_REGEX = 8;
const F_CASE = 16;
const F_THIRD = 32;
const F_FIRST = 64;
const F_IMPORTANT = 128;

/* слова, которые встречаются почти в каждом адресе: по ним правило не раскладывается */
const COMMON = new Set(["http", "https", "www", "com", "net", "org", "ru", "js", "css", "html", "htm", "php", "img", "image", "images", "static", "cdn", "api", "min", "index", "content", "assets", "src", "data"]);

/* параметры, которые меняют ответ или выполняют код: такие правила не для этого движка */
const SKIP_OPTIONS = /^(redirect-rule|csp|removeparam|queryprune|replace|header|rewrite|cookie|permissions|uritransform|urlskip|urltransform|webrtc|popup|popunder|inline-script|inline-font|method|app|network|extension|stealth|jsonprune|xmlprune|hls|referrerpolicy|empty|mp4|strict1p|strict3p|ipaddress|to|cname|redirect)(=|$)/;
const IGNORE_OPTIONS = /^(_+|genericblock|first-party-only|object-subrequest)$/;

const HOST_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const SEPARATOR = "(?:[^\\w\\d_\\-.%]|$)";

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Регулярное выражение по шаблону правила (без якорей в самом тексте). */
function patternRegex(pattern, flags) {
  let src = pattern.split("*").map(part => part.split("^").map(escapeRe).join(SEPARATOR)).join(".*");
  if (flags & F_HOST) {
    src = `^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?${src}`;
  } else if (flags & F_START) {
    src = `^${src}`;
  }
  if (flags & F_END) {
    src += "$";
  }
  return new RegExp(src, flags & F_CASE ? "" : "i");
}

/** Хост и его родители: a.b.example.com → [a.b.example.com, b.example.com, example.com, com]. */
export function hostChain(host) {
  const out = [];
  for (let h = host; h; ) {
    out.push(h);
    const dot = h.indexOf(".");
    if (dot < 0) {
      break;
    }
    h = h.slice(dot + 1);
  }
  return out;
}

function domainListMatches(list, host) {
  for (const d of list) {
    if (host === d || (host.length > d.length && host.endsWith(d) && host[host.length - d.length - 1] === ".")) {
      return true;
    }
  }
  return false;
}

class Bucket {
  constructor() {
    this.byHost = new Map(); // ||хост^ → правила
    this.byToken = new Map();
    this.loose = []; // без слова: проверяются для каждого запроса
    this.count = 0;
  }

  add(filter) {
    this.count++;
    if (filter.h) {
      const list = this.byHost.get(filter.h);
      if (list) {
        list.push(filter);
      } else {
        this.byHost.set(filter.h, [filter]);
      }
      return;
    }
    const token = filter.k;
    if (!token) {
      this.loose.push(filter);
      return;
    }
    const list = this.byToken.get(token);
    if (list) {
      list.push(filter);
    } else {
      this.byToken.set(token, [filter]);
    }
  }

  /** Первое подходящее правило; с predicate — первое, для которого он истинен. */
  find(req, tokens, wantBits) {
    for (const h of req.chain) {
      const list = this.byHost.get(h);
      if (list) {
        for (const f of list) {
          if (applies(f, req, wantBits)) {
            return f;
          }
        }
      }
    }
    for (const t of tokens) {
      const list = this.byToken.get(t);
      if (list) {
        for (const f of list) {
          if (applies(f, req, wantBits) && patternMatches(f, req)) {
            return f;
          }
        }
      }
    }
    for (const f of this.loose) {
      if (applies(f, req, wantBits) && patternMatches(f, req)) {
        return f;
      }
    }
    return null;
  }
}

/** Параметры правила против запроса: вид ресурса, сторона, домены страницы. */
function applies(f, req, wantBits) {
  if (!(f.t & wantBits)) {
    return false;
  }
  if (f.f & F_THIRD ? !req.thirdParty : f.f & F_FIRST && req.thirdParty) {
    return false;
  }
  if (f.d && !domainListMatches(f.d, req.docHost)) {
    return false;
  }
  if (f.nd && domainListMatches(f.nd, req.docHost)) {
    return false;
  }
  if (f.da && domainListMatches(f.da, req.host)) {
    return false;
  }
  return true;
}

function patternMatches(f, req) {
  if (f.re === undefined) {
    try {
      f.re = f.f & F_REGEX ? new RegExp(f.p, f.f & F_CASE ? "" : "i") : f.s ? null : patternRegex(f.p, f.f);
    } catch (e) {
      f.re = false; // негодное выражение: правило не срабатывает
    }
  }
  if (f.re === null) {
    return (f.f & F_CASE ? req.url : req.lower).includes(f.p); // простая подстрока
  }
  return f.re !== false && f.re.test(req.url);
}

/** Слово для раскладки правила: самое длинное целое слово шаблона, не из общеупотребительных.
 * Слово у края шаблона годится, только если край закреплён: иначе оно может быть частью
 * более длинного слова в адресе. */
function pickToken(pattern, flags) {
  let best = "";
  const re = /[a-z0-9%]+/g;
  let m;
  while ((m = re.exec(pattern))) {
    const word = m[0];
    const start = m.index;
    const end = start + word.length;
    const leftOk = start > 0 ? pattern[start - 1] !== "*" : !!(flags & (F_HOST | F_START));
    const rightOk = end < pattern.length ? pattern[end] !== "*" : !!(flags & F_END);
    if (leftOk && rightOk && word.length >= 2 && word.length > best.length && !COMMON.has(word)) {
      best = word;
    }
  }
  return best;
}

export class Engine {
  constructor({ validSelector = () => true } = {}) {
    this.block = new Bucket();
    this.allow = new Bucket();
    this.validSelector = validSelector;
    this.bad = new Set(); // тексты правил, отменённых badfilter
    this.generic = new Set(); // общие селекторы скрытия
    this.genericOff = new Map(); // хост → селекторы, которые на нём не скрываются
    this.specific = new Map(); // хост → [селекторы]
    this.specificOff = new Map(); // хост → селекторы, исключённые для него
    this.lists = []; // названия списков по номеру
    this.stats = { network: 0, cosmetic: 0, skipped: 0 };
  }

  /** До разбора: собрать правила, отменённые параметром badfilter (в любом из списков). */
  scanBadfilters(text) {
    let at = text.indexOf("badfilter");
    while (at >= 0) {
      const start = text.lastIndexOf("\n", at) + 1;
      let end = text.indexOf("\n", at);
      end = end < 0 ? text.length : end;
      const line = text.slice(start, end).trim();
      const dollar = line.lastIndexOf("$");
      if (dollar > 0 && !line.startsWith("!")) {
        const options = line.slice(dollar + 1).split(",").filter(o => o !== "badfilter");
        this.bad.add(options.length ? `${line.slice(0, dollar)}$${options.join(",")}` : line.slice(0, dollar));
      }
      at = text.indexOf("badfilter", end);
    }
  }

  /** Разобрать список. Генератор: отдаёт управление каждые step строк, чтобы разбор большого
   * списка не занимал поток надолго. kind — «ads» или «privacy» (для счётчика на странице). */
  *feed(text, { kind = "ads", step = 2000 } = {}) {
    const list = this.lists.push(kind) - 1;
    let n = 0;
    let from = 0;
    while (from < text.length) {
      let end = text.indexOf("\n", from);
      if (end < 0) {
        end = text.length;
      }
      this.addLine(text.slice(from, end), list);
      from = end + 1;
      if (++n % step === 0) {
        yield n;
      }
    }
  }

  addLine(raw, list = 0) {
    const line = raw.trim();
    if (!line || line[0] === "!" || line[0] === "[" || (line[0] === "#" && line[1] !== "#" && line[1] !== "@")) {
      return;
    }
    // правило скрытия: «домены##селектор» или «домены#@#селектор»; всё прочее с # между доменами и
    // телом (#?#, #$#, #%#, ##+js, ##^) — сценарии и переписывание, пропускаются
    const hash = line.indexOf("#");
    if (hash >= 0) {
      const marker = /^(#@?#)|^(#[?$%@]{1,2}#)/.exec(line.slice(hash));
      if (marker && (hash === 0 || /^[a-z0-9.,~*_-]+$/i.test(line.slice(0, hash)))) {
        if (marker[1]) {
          this.addCosmetic(line.slice(0, hash), line.slice(hash + marker[1].length), marker[1] === "#@#");
        } else {
          this.stats.skipped++;
        }
        return;
      }
    }
    this.addNetwork(line, list);
  }

  addCosmetic(domains, selector, exception) {
    selector = selector.trim();
    // сценарии, HTML-фильтры и процедурные селекторы стилями не выразить
    if (!selector || selector.startsWith("+js(") || selector[0] === "^" || /:(has-text|contains|xpath|matches-css|matches-attr|matches-path|min-text-length|upward|remove|style|watch-attr|others|shadow|-abp-|if|if-not|nth-ancestor)\b|\{/.test(selector) || !this.validSelector(selector)) {
      this.stats.skipped++;
      return;
    }
    const hosts = domains ? domains.toLowerCase().split(",").filter(Boolean) : [];
    if (hosts.some(h => h.includes("*"))) {
      this.stats.skipped++; // «google.*» требует списка публичных суффиксов
      return;
    }
    const push = (map, host) => {
      const set = map.get(host);
      if (set) {
        set.add(selector);
      } else {
        map.set(host, new Set([selector]));
      }
    };
    const include = hosts.filter(h => h[0] !== "~");
    const exclude = hosts.filter(h => h[0] === "~").map(h => h.slice(1));
    this.stats.cosmetic++;
    if (exception) {
      if (!include.length) {
        this.generic.delete(selector); // «#@#селектор»: общее правило отменено везде
        this._genericKilled ||= new Set();
        this._genericKilled.add(selector);
      } else {
        include.forEach(h => {
          push(this.genericOff, h);
          push(this.specificOff, h);
        });
      }
      return;
    }
    if (!include.length) {
      if (!this._genericKilled?.has(selector)) {
        this.generic.add(selector);
      }
      exclude.forEach(h => push(this.genericOff, h));
      return;
    }
    include.forEach(h => push(this.specific, h));
    exclude.forEach(h => push(this.specificOff, h));
  }

  addNetwork(line, list) {
    if (this.bad.has(line)) {
      return;
    }
    let text = line;
    const exception = text.startsWith("@@");
    if (exception) {
      text = text.slice(2);
    }
    let flags = 0;
    let types = 0;
    let negTypes = 0;
    let include = null;
    let exclude = null;
    let denyallow = null;
    // параметры — после последнего $, если это не часть регулярного выражения
    const isRegex = text.length > 2 && text[0] === "/" && /\/(\$[^/]*)?$/.test(text);
    const dollar = text.lastIndexOf("$");
    if (dollar >= 0 && (!isRegex || text.lastIndexOf("/") < dollar)) {
      const options = text.slice(dollar + 1);
      // в самом шаблоне $ бывает редко; «параметры» с недопустимыми знаками — это часть шаблона
      if (/^[\w,~=|.*_-]+$/.test(options) || options === "") {
        text = text.slice(0, dollar);
        for (let opt of options.split(",")) {
          if (!opt) {
            continue;
          }
          const neg = opt[0] === "~";
          if (neg) {
            opt = opt.slice(1);
          }
          const eq = opt.indexOf("=");
          const name = (eq < 0 ? opt : opt.slice(0, eq)).toLowerCase();
          const value = eq < 0 ? "" : opt.slice(eq + 1);
          if (TYPE_ALIAS[name]) {
            const bit = TYPE[TYPE_ALIAS[name]];
            if (neg) {
              negTypes |= bit;
            } else {
              types |= bit;
            }
          } else if (name === "all") {
            types |= ALL_RESOURCES;
          } else if (name === "third-party" || name === "3p") {
            flags |= neg ? F_FIRST : F_THIRD;
          } else if (name === "first-party" || name === "1p") {
            flags |= neg ? F_THIRD : F_FIRST;
          } else if (name === "match-case") {
            flags |= F_CASE;
          } else if (name === "important") {
            flags |= F_IMPORTANT;
          } else if (name === "domain" || name === "from") {
            for (const d of value.toLowerCase().split("|")) {
              if (!d || d.includes("*") || d.includes("/")) {
                this.stats.skipped++; // «google.*» и выражения в domain= не поддерживаются
                return;
              }
              if (d[0] === "~") {
                (exclude ||= []).push(d.slice(1));
              } else {
                (include ||= []).push(d);
              }
            }
          } else if (name === "denyallow") {
            denyallow = value.toLowerCase().split("|").filter(Boolean);
          } else if (name === "badfilter") {
            return; // учтено в scanBadfilters
          } else if (IGNORE_OPTIONS.test(name)) {
            // на применимость правила не влияет
          } else {
            // SKIP_OPTIONS и всё незнакомое: правило не для этого движка
            if (!SKIP_OPTIONS.test(name)) {
              this.stats.unknown = (this.stats.unknown || 0) + 1;
            }
            this.stats.skipped++;
            return;
          }
        }
      }
    }
    if (!types) {
      // без видов ресурсов правило действует на все ресурсы (но не на саму страницу)
      types = ALL_RESOURCES & ~negTypes;
    } else {
      types &= ~negTypes;
    }
    if (!exception) {
      types &= ALL_RESOURCES; // блокирующие правила уровня страницы не поддерживаются
    }
    if (!types) {
      this.stats.skipped++;
      return;
    }

    const filter = { t: types, f: flags, l: list };
    if (include) {
      filter.d = include;
    }
    if (exclude) {
      filter.nd = exclude;
    }
    if (denyallow) {
      filter.da = denyallow;
    }

    if (isRegex && text.length > 2 && text.endsWith("/")) {
      filter.f |= F_REGEX;
      filter.p = text.slice(1, -1);
      // слово для раскладки берётся только из явных букв выражения — надёжно его не выделить
    } else {
      if (text.startsWith("||")) {
        filter.f |= F_HOST;
        text = text.slice(2);
      } else if (text.startsWith("|")) {
        filter.f |= F_START;
        text = text.slice(1);
      }
      if (text.endsWith("|")) {
        filter.f |= F_END;
        text = text.slice(0, -1);
      }
      // лишние звёздочки по краям ничего не значат
      text = text.replace(/^\*+/, m => (filter.f & (F_HOST | F_START) ? m : "")).replace(/\*+$/, m => (filter.f & F_END ? m : ""));
      if (!(filter.f & F_CASE)) {
        text = text.toLowerCase();
      }
      if (!text || (text.length < 3 && !(filter.f & (F_HOST | F_START | F_END)) && !include)) {
        this.stats.skipped++; // пустой или слишком общий шаблон заблокировал бы всё подряд
        return;
      }
      // ||example.com^ — самый частый вид: проверяется по таблице хостов без регулярных выражений
      if (filter.f & F_HOST && !(filter.f & (F_END | F_CASE)) && text.endsWith("^") && HOST_RE.test(text.slice(0, -1))) {
        filter.h = text.slice(0, -1);
      } else {
        filter.p = text;
        filter.s = !(filter.f & (F_HOST | F_START | F_END)) && !/[*^]/.test(text); // простая подстрока
        filter.k = pickToken(text, filter.f);
      }
    }
    this.stats.network++;
    (exception ? this.allow : this.block).add(filter);
  }

  /** Запрос: { url, host, type (бит TYPE), docHost — хост документа, из которого идёт запрос,
   * thirdParty }. Ответ: null (пропустить) или { kind } — заблокировать. */
  match({ url, host, type, docHost, thirdParty }) {
    const lower = url.toLowerCase();
    const req = { url, lower, host, docHost: docHost || host, thirdParty: !!thirdParty, chain: hostChain(host) };
    const tokens = lower.match(/[a-z0-9%]+/g) || [];
    const hit = this.block.find(req, tokens, type);
    if (!hit) {
      return null;
    }
    if (!(hit.f & F_IMPORTANT) && this.allow.find(req, tokens, type)) {
      return null;
    }
    return { kind: this.lists[hit.l] || "ads" };
  }

  /** Исключения уровня страницы для адреса документа: { document, elemhide, generichide }. */
  pageOptions(url, host) {
    const lower = url.toLowerCase();
    const req = { url, lower, host, docHost: host, thirdParty: false, chain: hostChain(host) };
    const tokens = lower.match(/[a-z0-9%]+/g) || [];
    const out = { document: false, elemhide: false, generichide: false };
    for (const [name, bit] of [["document", TYPE.document], ["elemhide", TYPE.elemhide], ["generichide", TYPE.generichide]]) {
      out[name] = !!this.allow.find(req, tokens, bit);
    }
    return out;
  }

  /** Что прятать на странице хоста: { generic: общий лист годится как есть, off: общие
   * селекторы, которые на этом сайте не скрываются, selectors: свои селекторы сайта }. */
  cosmetics(host) {
    const chain = hostChain(host);
    const off = new Set();
    const mine = new Set();
    const notMine = new Set();
    for (const h of chain) {
      this.genericOff.get(h)?.forEach(s => off.add(s));
      this.specific.get(h)?.forEach(s => mine.add(s));
      this.specificOff.get(h)?.forEach(s => notMine.add(s));
    }
    notMine.forEach(s => mine.delete(s));
    const genericOff = [...off].filter(s => this.generic.has(s));
    return { generic: !genericOff.length, off: genericOff, selectors: [...mine] };
  }

  get counts() {
    return { network: this.block.count + this.allow.count, exceptions: this.allow.count, generic: this.generic.size, specific: this.specific.size, skipped: this.stats.skipped };
  }
}

/** Таблица стилей, скрывающая селекторы. Селекторы идут пачками: если один в пачке окажется
 * негодным, пропадёт только его пачка. */
export function hideSheet(selectors, chunk = 200) {
  const out = [];
  for (let i = 0; i < selectors.length; i += chunk) {
    out.push(`${selectors.slice(i, i + chunk).join(",\n")}\n{display:none!important}`);
  }
  return out.join("\n");
}

/** Срок годности списка из его заголовка («! Expires: 4 days»), в миллисекундах: от суток до недели. */
export function listExpiry(text) {
  const m = /^!\s*Expires:\s*(\d+)\s*(day|hour)/im.exec(text.slice(0, 4000));
  const ms = m ? Number(m[1]) * (m[2].toLowerCase() === "day" ? 86400000 : 3600000) : 2 * 86400000;
  return Math.min(7 * 86400000, Math.max(86400000, ms));
}
