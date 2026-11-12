// Страницы сайта tabora.app на четырёх языках из одного русского шаблона pages/index.html:
// site/ru/, site/en/, site/uk/, site/es/ и site/index.html — копия английской страницы для тех,
// кто попал на «/» без перенаправления по языку (его делает nginx по Accept-Language).
//
// Переводы лежат в i18n/site/<язык>.json; ключ — русский текст из шаблона, как в словарях приложения.
// Единица перевода — фраза целиком:
//   • содержимое элемента, в котором есть русский текст, вместе с тегами внутри (<b>, <a>, <code>…);
//     значки и пустые элементы по краям в единицу не входят;
//   • значение любого атрибута с русским текстом (content, aria-label, data-*…);
//   • строки с русским текстом в <script type="application/ld+json">.
// Пометки в шаблоне (в готовые страницы не попадают):
//   data-i18n          — содержимое элемента переводится, хотя русских букв в нём нет (числа, примеры);
//   data-i18n="a b"    — так же для атрибутов a и b;
//   translate="no"     — элемент не переводится (названия языков в переключателе); атрибут остаётся.
// Сборка останавливается, если перевода нет, в переводе другие теги или подстановки {0}, остались буквы
// чужого языка, страницы разошлись по разметке или местная ссылка ведёт в никуда.
//
// Запуск: node pages.mjs [каталог вывода] [--i18n каталог словарей] [--files каталог сайта для проверки ссылок]
//         node pages.mjs --units   — список единиц перевода по порядку (JSON), для переводчика
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseFragment } from "parse5";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "pages/index.html");
const ORIGIN = "https://tabora.app";
const SOURCE = "ru";
const FALLBACK = "en"; // x-default и site/index.html
// порядок — как в переключателе языков; forbid — буквы, которых в готовом тексте быть не должно
const LANGS = {
  ru: { ogLocale: "ru_RU" },
  en: { ogLocale: "en_US", forbid: /[Ѐ-ӿ]/ },
  uk: { ogLocale: "uk_UA", forbid: /[ыэъёЫЭЪЁ]/ },
  es: { ogLocale: "es_ES", forbid: /[Ѐ-ӿ]/ },
};
// эти адреса nginx отдаёт не из каталога сайта
const SERVED_ELSEWHERE = ["/downloads/"];

const CYR = /[Ѐ-ӿ]/;
const MARK = "data-i18n";

class BuildError extends Error {}
const fail = lines => {
  throw new BuildError([].concat(lines).join("\n"));
};

// ---- разбор ----

function parsePage(html, what) {
  const errors = [];
  const doc = parse(html, { sourceCodeLocationInfo: true, onParseError: e => errors.push(e) });
  if (errors.length) {
    fail(errors.map(e => `${what}:${e.startLine}:${e.startCol}: ошибка разметки ${e.code}`));
  }
  return doc;
}

const isElement = n => typeof n.tagName === "string";
const isText = n => n.nodeName === "#text";
const kids = n => (n.tagName === "template" ? n.content.childNodes : n.childNodes) || [];
const attr = (el, name) => el.attrs.find(a => a.name === name)?.value;
const textOf = n => (isText(n) ? n.value : kids(n).map(textOf).join(""));
const squeeze = s => s.trim().replace(/\s+/g, " ");

function* elements(node) {
  for (const child of kids(node)) {
    if (isElement(child)) {
      yield child;
      yield* elements(child);
    }
  }
}

const find = (doc, test, what) => {
  const found = [...elements(doc)].filter(test);
  if (found.length !== 1) {
    fail(`шаблон: ожидался один ${what}, найдено ${found.length}`);
  }
  return found[0];
};

// ---- единицы перевода ----

/** Что в шаблоне переводится: [{ kind: "text" | "attr" | "json", key, start, end, name?, where }]
 *  и что из шаблона убирается (пометки data-i18n): [{ start, end }]. */
function unitsOf(doc, src) {
  const units = [];
  const drops = [];
  const where = node => `pages/index.html:${node.sourceCodeLocation.startLine}`;

  const attrUnits = el => {
    const marked = attr(el, MARK);
    const forced = marked ? marked.split(/\s+/) : [];
    for (const name of forced) {
      attr(el, name) ?? fail(`${where(el)}: ${MARK} называет атрибут ${name}, которого нет`);
    }
    for (const a of el.attrs) {
      if (a.name !== MARK && (CYR.test(a.value) || forced.includes(a.name))) {
        const loc = el.sourceCodeLocation.attrs[a.name];
        units.push({ kind: "attr", key: a.value, name: a.name, start: loc.startOffset, end: loc.endOffset, where: where(el) });
      }
    }
    if (marked !== undefined) {
      const loc = el.sourceCodeLocation.attrs[MARK];
      drops.push({ start: loc.startOffset - 1, end: loc.endOffset }); // вместе с пробелом перед атрибутом
    }
  };

  const walk = (node, attrsOnly) => {
    for (const el of kids(node)) {
      if (!isElement(el) || attr(el, "translate") === "no") {
        continue;
      }
      attrUnits(el);
      if (el.tagName === "script" || el.tagName === "style") {
        if (!attrsOnly && el.tagName === "script" && attr(el, "type") === "application/ld+json") {
          jsonUnits(el);
        } else if (CYR.test(textOf(el))) {
          fail(`${where(el)}: русский текст внутри <${el.tagName}> не переводится`);
        }
        continue;
      }
      const own = !attrsOnly && (attr(el, MARK) === "" || kids(el).some(n => isText(n) && CYR.test(n.value)));
      if (!own) {
        walk(el, attrsOnly);
        continue;
      }
      // фраза: от первого до последнего потомка с текстом; значки и пустые элементы по краям остаются на месте
      const empty = n => textOf(n).trim() === "";
      const inner = [...kids(el)];
      const outside = [];
      while (inner.length && empty(inner[0])) {
        outside.push(inner.shift());
      }
      while (inner.length && empty(inner.at(-1))) {
        outside.push(inner.pop());
      }
      if (!inner.length) {
        fail(`${where(el)}: в элементе с ${MARK} нет текста`);
      }
      let start = inner[0].sourceCodeLocation.startOffset;
      let end = inner.at(-1).sourceCodeLocation.endOffset;
      const raw = src.slice(start, end);
      start += raw.length - raw.trimStart().length;
      end -= raw.length - raw.trimEnd().length;
      units.push({ kind: "text", key: squeeze(raw), start, end, where: where(el) });
      for (const part of inner) {
        for (const sub of isElement(part) ? [part, ...elements(part)] : []) {
          if (sub.attrs.some(a => CYR.test(a.value) || a.name === MARK)) {
            fail(`${where(sub)}: внутри фразы у <${sub.tagName}> переводимый атрибут — вынесите элемент из фразы`);
          }
        }
      }
      walk({ childNodes: outside }, true);
    }
  };

  // JSON-LD: переводятся строки с русским текстом, остальное остаётся как написано
  const jsonUnits = el => {
    const node = kids(el)[0];
    if (!node) {
      return;
    }
    const base = node.sourceCodeLocation.startOffset;
    const text = src.slice(base, node.sourceCodeLocation.endOffset);
    try {
      JSON.parse(text);
    } catch (e) {
      fail(`${where(el)}: JSON-LD не разбирается: ${e.message}`);
    }
    for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      const value = JSON.parse(m[0]);
      if (CYR.test(value)) {
        units.push({ kind: "json", key: value, start: base + m.index, end: base + m.index + m[0].length, where: where(el) });
      }
    }
  };

  walk(doc, false);
  return { units, drops };
}

// ---- проверка перевода одной единицы ----

const tagsOf = html => (html.match(/<\/?[a-zA-Z][^>]*>/g) || []).sort().join(" ");
const slotsOf = s => (s.match(/\{\d+\}/g) || []).sort().join(" ");

function checkUnit(unit, value, lang) {
  const problems = [];
  if (LANGS[lang].forbid?.test(value)) {
    problems.push("остались буквы другого языка");
  }
  if (slotsOf(unit.key) !== slotsOf(value)) {
    problems.push("подстановки {0} не совпадают с исходными");
  }
  if (unit.kind !== "text") {
    // значение атрибута и строка JSON — простой текст: разметка и &nbsp; попали бы на страницу буквально
    if (/<\/?[a-zA-Z]|&#?\w+;/.test(value)) {
      problems.push("в простом тексте (атрибут, JSON-LD) не должно быть тегов и подстановок вида &nbsp;");
    }
  } else {
    if (tagsOf(unit.key) !== tagsOf(value)) {
      problems.push(`теги не совпадают с исходными: ${tagsOf(unit.key) || "нет"} ≠ ${tagsOf(value) || "нет"}`);
    }
    const errors = [];
    parseFragment(value, { onParseError: e => errors.push(e.code) });
    if (errors.length) {
      problems.push(`разметка с ошибкой (${errors.join(", ")})`);
    }
  }
  return problems;
}

const escAttr = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\u00a0/g, "&nbsp;");
// «<» внутри <script> не должен закрыть его раньше времени
const escJson = s => JSON.stringify(s).replace(/</g, "\\u003c");

// ---- страница одного языка ----

/** Правки, от языка зависящие: lang, свой адрес, og:locale, отметка текущего языка в переключателе. */
function localEdits(doc, lang) {
  const edits = [];
  const set = (el, name, value) => {
    const loc = el.sourceCodeLocation.attrs?.[name] ?? fail(`шаблон: у <${el.tagName}> нет атрибута ${name}`);
    edits.push({ start: loc.startOffset, end: loc.endOffset, text: `${name}="${escAttr(value)}"` });
  };
  const url = `${ORIGIN}/${lang}/`;
  set(find(doc, el => el.tagName === "html", "<html>"), "lang", lang);
  set(find(doc, el => el.tagName === "link" && attr(el, "rel") === "canonical", "link rel=canonical"), "href", url);
  set(find(doc, el => el.tagName === "meta" && attr(el, "property") === "og:url", "meta og:url"), "content", url);
  set(find(doc, el => el.tagName === "meta" && attr(el, "property") === "og:locale", "meta og:locale"), "content", LANGS[lang].ogLocale);
  const current = find(doc, el => el.tagName === "a" && attr(el, "hreflang") === lang, `пункт переключателя для ${lang}`);
  const at = current.sourceCodeLocation.startTag.endOffset - 1;
  edits.push({ start: at, end: at, text: ' aria-current="page"' });
  return edits;
}

/** Шаблон должен сам называть все языки: ссылки hreflang в <head> и пункты переключателя. */
function checkTemplate(doc) {
  const all = [...elements(doc)];
  const alternates = all.filter(el => el.tagName === "link" && attr(el, "rel") === "alternate").map(el => `${attr(el, "hreflang")} ${attr(el, "href")}`);
  const wantAlternates = [...Object.keys(LANGS).map(l => `${l} ${ORIGIN}/${l}/`), `x-default ${ORIGIN}/${FALLBACK}/`];
  if (alternates.join("\n") !== wantAlternates.join("\n")) {
    fail(["шаблон: ссылки rel=alternate hreflang должны быть такими:", ...wantAlternates.map(a => `  ${a}`)]);
  }
  const switcher = all.filter(el => el.tagName === "a" && attr(el, "hreflang")).map(el => `${attr(el, "hreflang")} ${attr(el, "href")} ${attr(el, "lang")} ${attr(el, "translate")}`);
  const wantSwitcher = Object.keys(LANGS).map(l => `${l} /${l}/ ${l} no`);
  if (switcher.join("\n") !== wantSwitcher.join("\n")) {
    fail(["шаблон: в переключателе языков должны быть ссылки (hreflang, href, lang, translate):", ...wantSwitcher.map(a => `  ${a}`)]);
  }
  if (attr(find(doc, el => el.tagName === "html", "<html>"), "lang") !== SOURCE) {
    fail(`шаблон: ожидался <html lang="${SOURCE}">`);
  }
}

function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  let before = Infinity;
  for (const e of sorted) {
    if (e.end > before) {
      fail(`правки шаблона пересекаются на позиции ${e.start}`);
    }
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    before = e.start;
  }
  return out;
}

function render(src, doc, { units, drops }, lang, catalog) {
  const edits = [...localEdits(doc, lang), ...drops.map(d => ({ ...d, text: "" }))];
  const problems = [];
  if (lang !== SOURCE) {
    const used = new Set();
    for (const unit of units) {
      const value = catalog[unit.key];
      used.add(unit.key);
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${unit.where}: нет перевода: ${JSON.stringify(unit.key)}`);
        continue;
      }
      const bad = checkUnit(unit, value, lang);
      if (bad.length) {
        problems.push(`${unit.where}: ${JSON.stringify(unit.key)}: ${bad.join("; ")}`);
        continue;
      }
      const text = unit.kind === "attr" ? `${unit.name}="${escAttr(value)}"` : unit.kind === "json" ? escJson(value) : value;
      edits.push({ start: unit.start, end: unit.end, text });
    }
    for (const key of Object.keys(catalog)) {
      if (!used.has(key)) {
        problems.push(`лишняя запись в словаре (в шаблоне такой фразы нет): ${JSON.stringify(key)}`);
      }
    }
  }
  if (problems.length) {
    fail([`i18n/site/${lang}.json:`, ...problems.map(p => `  ${p}`)]);
  }
  return applyEdits(src, edits);
}

// ---- проверки готовых страниц ----

const shapeOf = doc => [...elements(doc)].map(el => `${el.tagName}[${el.attrs.map(a => a.name).filter(n => n !== "aria-current").sort().join(",")}]`);

function visibleStrings(doc) {
  const out = [];
  const walk = node => {
    for (const n of kids(node)) {
      if (isText(n)) {
        out.push(n.value);
      } else if (isElement(n) && attr(n, "translate") !== "no") {
        out.push(...n.attrs.map(a => a.value));
        walk(n);
      }
    }
  };
  walk(doc);
  return out;
}

function checkPages(pages, filesDir) {
  const problems = [];
  const docs = {};
  for (const [lang, html] of Object.entries(pages)) {
    docs[lang] = parsePage(html, `${lang}/index.html`);
  }
  const base = shapeOf(docs[SOURCE]);
  for (const [lang, doc] of Object.entries(docs)) {
    const shape = shapeOf(doc);
    const at = shape.findIndex((s, i) => s !== base[i]);
    if (shape.length !== base.length || at !== -1) {
      problems.push(`${lang}: разметка расходится с русской страницей (элементов ${shape.length} и ${base.length}${at === -1 ? "" : `, первое отличие: ${shape[at]} вместо ${base[at]}`})`);
    }
    const forbid = LANGS[lang].forbid;
    for (const s of forbid ? visibleStrings(doc) : []) {
      if (forbid.test(s)) {
        problems.push(`${lang}: в тексте страницы остались буквы другого языка: ${JSON.stringify(squeeze(s).slice(0, 80))}`);
      }
    }
    const all = [...elements(doc)];
    const ids = new Set(all.map(el => attr(el, "id")).filter(Boolean));
    const current = all.filter(el => attr(el, "aria-current") === "page").map(el => attr(el, "hreflang"));
    if (attr(all[0], "lang") !== lang || current.join() !== lang) {
      problems.push(`${lang}: язык страницы или отметка в переключателе не совпадают с языком`);
    }
    for (const el of all) {
      for (const name of ["popovertarget", "data-copy", "for", "aria-controls"]) {
        const id = attr(el, name);
        if (id && !ids.has(id)) {
          problems.push(`${lang}: ${name}="${id}" указывает на элемент, которого нет`);
        }
      }
      const targets = [attr(el, "href"), attr(el, "src"), el.tagName === "meta" && /^og:(url|image)$/.test(attr(el, "property") || "") && attr(el, "content")];
      for (const target of targets.filter(Boolean)) {
        if (target.startsWith("#")) {
          if (target.length > 1 && !ids.has(decodeURIComponent(target.slice(1)))) {
            problems.push(`${lang}: ссылка ${target} указывает на раздел, которого нет`);
          }
          continue;
        }
        // адрес страницы — /<язык>/: относительные ссылки считаются от него
        const url = new URL(target, `${ORIGIN}/${lang}/`);
        if (url.origin !== ORIGIN || SERVED_ELSEWHERE.some(p => url.pathname.startsWith(p))) {
          continue;
        }
        if (!target.startsWith("/") && !target.startsWith(ORIGIN) && target !== "./") {
          problems.push(`${lang}: ссылка ${target} относительная; страницы лежат в подкаталогах, нужен путь от корня`);
        }
        if (filesDir) {
          const path = join(filesDir, decodeURIComponent(url.pathname));
          const file = url.pathname.endsWith("/") ? join(path, "index.html") : path;
          // страницы языков появятся в этом же запуске
          const generated = Object.keys(pages).some(l => url.pathname === `/${l}/`);
          if (!generated && !(existsSync(file) && statSync(file).isFile())) {
            problems.push(`${lang}: ${target} — файла ${file} нет`);
          }
        }
      }
    }
  }
  if (problems.length) {
    fail(["готовые страницы не прошли проверку:", ...new Set(problems)].map((p, i) => (i ? `  ${p}` : p)));
  }
}

// ---- запуск ----

function main(argv) {
  const args = { out: join(here, "../../site"), i18n: join(here, "../../i18n/site"), files: null, units: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--units") {
      args.units = true;
    } else if (argv[i] === "--i18n" || argv[i] === "--files") {
      args[argv[i].slice(2)] = resolve(argv[++i] ?? fail(`после ${argv[i - 1]} нужен каталог`));
    } else if (argv[i].startsWith("--")) {
      fail(`неизвестный параметр ${argv[i]}`);
    } else {
      args.out = resolve(argv[i]);
    }
  }
  const src = readFileSync(TEMPLATE, "utf8");
  const doc = parsePage(src, "pages/index.html");
  checkTemplate(doc);
  const found = unitsOf(doc, src);
  if (args.units) {
    process.stdout.write(JSON.stringify([...new Set(found.units.map(u => u.key))], null, 1) + "\n");
    return;
  }
  const pages = {};
  for (const lang of Object.keys(LANGS)) {
    let catalog = {};
    if (lang !== SOURCE) {
      const file = join(args.i18n, `${lang}.json`);
      try {
        catalog = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        fail(`${file}: словарь не читается: ${e.message}`);
      }
    }
    pages[lang] = render(src, doc, found, lang, catalog);
  }
  checkPages(pages, args.files ?? args.out);
  for (const [lang, html] of Object.entries(pages)) {
    mkdirSync(join(args.out, lang), { recursive: true });
    writeFileSync(join(args.out, lang, "index.html"), html);
  }
  writeFileSync(join(args.out, "index.html"), pages[FALLBACK]);
  const count = new Set(found.units.map(u => u.key)).size;
  console.log(`✓ страницы сайта: ${Object.keys(LANGS).join(", ")} и index.html (${FALLBACK}); фраз для перевода: ${count}`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof BuildError) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  throw e;
}
