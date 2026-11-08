/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Загрузки Tabora: страница tabora://downloads поверх настоящего списка загрузок
 * Firefox (Downloads.sys.mjs). Живой прогресс и скорость, пауза и возобновление,
 * миниатюры картинок, перетаскивание файла из списка, действия с файлом,
 * поиск и фильтры по типу, контекстное меню оболочки. */

"use strict";

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const { DownloadsCommon } = ChromeUtils.importESModule("moz-src:///browser/components/downloads/DownloadsCommon.sys.mjs");
const Shell = window.browsingContext?.topChromeWindow?.Tabora || null;

const $ = id => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) {
      continue;
    }
    if (k === "class") {
      node.className = v;
    } else if (k === "text") {
      node.textContent = v;
    } else if (k.startsWith("on")) {
      node.addEventListener(k.slice(2), v);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

const ICONS = {
  open: "M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  pause: "M8 5v14M16 5v14",
  play: "M7 4l12 8-12 8z",
  retry: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  close: "M6 6l12 12M18 6 6 18",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  download: "M12 4v11M7 10l5 5 5-5M4 19h16",
};

function icon(name, size = 15, stroke = 2) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": stroke, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/* ---- Форматирование ---------------------------------------------------- */

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) {
    return "";
  }
  if (bytes < 1000) {
    return `${bytes} Б`;
  }
  if (bytes < 1_000_000) {
    return `${Math.round(bytes / 1000)} КБ`;
  }
  if (bytes < 1_000_000_000) {
    return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0).replace(".", ",")} МБ`;
  }
  return `${(bytes / 1_000_000_000).toFixed(2).replace(".", ",")} ГБ`;
}

function fmtSpeed(bps) {
  return bps > 0 ? `${fmtSize(bps)}/с` : "";
}

function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (seconds < 60) {
    return `${Math.ceil(seconds)} с`;
  }
  if (seconds < 3600) {
    return `${Math.ceil(seconds / 60)} мин`;
  }
  return `${Math.floor(seconds / 3600)} ч ${Math.ceil((seconds % 3600) / 60)} мин`;
}

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function dayKey(date) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(date);
  const diff = Math.floor((start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  return diff <= 0 ? "today" : diff === 1 ? "yesterday" : diff < 7 ? "week" : "earlier";
}

function fmtTime(date) {
  const d = new Date(date);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const key = dayKey(date);
  return key === "today" ? time : key === "yesterday" ? `вчера, ${time}` : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) {
    return many;
  }
  if (b > 1 && b < 5) {
    return few;
  }
  return b === 1 ? one : many;
}

/* ---- Тип файла --------------------------------------------------------- */

const KINDS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "svg", "bmp", "tiff"],
  video: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "m4a", "flac", "wav", "aac", "ogg", "opus"],
  doc: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf", "csv", "epub", "pages", "numbers", "key", "json", "xml"],
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"],
  app: ["dmg", "pkg", "exe", "msi", "app", "apk", "deb", "rpm", "appimage", "xpi"],
};

function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function kindOf(download) {
  const ext = extOf(fileName(download));
  const type = download.contentType || "";
  for (const [kind, exts] of Object.entries(KINDS)) {
    if (exts.includes(ext)) {
      return kind;
    }
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/") || type.startsWith("audio/")) {
    return "video";
  }
  if (type.startsWith("text/") || type.includes("pdf")) {
    return "doc";
  }
  return "other";
}

function fileName(download) {
  const path = download.target?.path || "";
  const base = path.split(/[\\/]/).pop();
  if (base) {
    return base;
  }
  try {
    return decodeURIComponent(new URL(download.source.url).pathname.split("/").pop()) || download.source.url;
  } catch (e) {
    return download.source.url;
  }
}

function hostOf(download) {
  try {
    return new URL(download.source.originalUrl || download.source.url).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function stateOf(d) {
  if (d.succeeded) {
    return d.target.exists === false ? "missing" : "done";
  }
  if (d.error) {
    return "failed";
  }
  if (d.canceled) {
    return d.hasPartialData ? "paused" : "canceled";
  }
  if (!d.stopped) {
    return "active";
  }
  return "pending";
}

/* ---- Страница ---------------------------------------------------------- */

const App = {
  list: null,
  downloads: new Map(), // Download → { node, state }
  order: [],
  filter: "all",
  query: "",
  view: "list",
  renderTimer: null,

  async init() {
    try {
      this.view = localStorage.getItem("tabora.downloads.view") || "list";
    } catch (e) {
      this.view = Services.prefs.getStringPref("tabora.downloads.view", "list");
    }
    $("page").dataset.view = this.view;
    this.bind();
    this.list = await Downloads.getList(Downloads.ALL);
    const view = {
      onDownloadAdded: d => this.add(d, true),
      onDownloadChanged: d => this.change(d),
      onDownloadRemoved: d => this.remove(d),
    };
    await this.list.addView(view);
    window.addEventListener("unload", () => this.list.removeView(view));
    this.scheduleRender();
  },

  add(download, fresh) {
    if (!this.downloads.has(download)) {
      this.downloads.set(download, { node: null, fresh: fresh && this.downloads.size > 0 });
      if (download.succeeded && download.target?.exists === undefined) {
        download.refresh().catch(() => {});
      }
    }
    this.scheduleRender();
  },

  change(download) {
    const entry = this.downloads.get(download);
    if (entry?.node && !this.structureChanged(download, entry)) {
      this.updateNode(download, entry);
      this.updateSummary();
      return;
    }
    this.scheduleRender();
  },

  remove(download) {
    this.downloads.delete(download);
    this.scheduleRender();
  },

  structureChanged(download, entry) {
    return entry.state !== stateOf(download);
  },

  scheduleRender() {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 30);
  },

  visible() {
    const q = this.query.trim().toLowerCase();
    return [...this.downloads.keys()]
      .filter(d => {
        if (this.filter === "active") {
          return ["active", "paused", "pending"].includes(stateOf(d));
        }
        if (this.filter !== "all" && kindOf(d) !== this.filter) {
          return false;
        }
        return !q || `${fileName(d)} ${hostOf(d)}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const sa = stateOf(a), sb = stateOf(b);
        const activeA = ["active", "paused", "pending"].includes(sa), activeB = ["active", "paused", "pending"].includes(sb);
        if (activeA !== activeB) {
          return activeA ? -1 : 1;
        }
        return (b.startTime?.getTime() || 0) - (a.startTime?.getTime() || 0);
      });
  },

  render() {
    const items = this.visible();
    const list = $("list");
    list.replaceChildren();
    const all = [...this.downloads.keys()];
    $("empty").hidden = items.length > 0;
    if (!items.length) {
      const filtered = all.length > 0;
      $("empty-title").textContent = filtered ? "Ничего не нашлось" : "Пока ничего не скачано";
      $("empty-sub").textContent = filtered ? "Попробуйте другой фильтр или запрос." : "Файлы появятся здесь сразу, как начнётся загрузка. Картинки покажем миниатюрой, файлы можно перетаскивать прямо отсюда.";
    }
    const groups = [["active", "Сейчас"], ["today", "Сегодня"], ["yesterday", "Вчера"], ["week", "На этой неделе"], ["earlier", "Ранее"]];
    const byGroup = new Map(groups.map(([k]) => [k, []]));
    for (const d of items) {
      const st = stateOf(d);
      const key = ["active", "paused", "pending"].includes(st) ? "active" : dayKey(d.startTime || Date.now());
      byGroup.get(key).push(d);
    }
    for (const [key, title] of groups) {
      const ds = byGroup.get(key);
      if (!ds.length) {
        continue;
      }
      const total = ds.reduce((s, d) => s + (d.target?.size || d.totalBytes || d.currentBytes || 0), 0);
      const group = el("section", { class: "group" }, [
        el("div", { class: "group-title" }, [title, el("span", { text: total ? `${ds.length} · ${fmtSize(total)}` : String(ds.length) })]),
        el("div", { class: "group-items" }, ds.map(d => this.node(d))),
      ]);
      list.append(group);
    }
    this.updateSummary();
  },

  node(download) {
    const entry = this.downloads.get(download);
    const state = stateOf(download);
    const name = fileName(download);
    const kind = kindOf(download);
    const host = hostOf(download);
    const node = el("div", {
      class: "item", role: "listitem", tabindex: "0", dataset: { state, kind, new: String(!!entry.fresh) },
      draggable: state === "done" ? "true" : null,
      oncontextmenu: e => {
        e.preventDefault();
        this.contextMenu(download, e.clientX, e.clientY);
      },
      ondblclick: () => state === "done" && this.open(download),
      onkeydown: e => {
        if (e.key === "Enter" && state === "done") {
          this.open(download);
        } else if (e.key === "Backspace" || e.key === "Delete") {
          this.removeFromList(download);
        }
      },
      ondragstart: e => this.dragStart(download, e, node),
      ondragend: () => delete node.dataset.dragging,
    });
    entry.fresh = false;

    const thumb = el("div", { class: "thumb" });
    if (state === "done" && kind === "image" && download.target.path) {
      const img = el("img", { alt: "", src: `file://${encodeURI(download.target.path)}` });
      img.addEventListener("error", () => img.replaceWith(this.iconFor(download)));
      thumb.append(img);
    } else {
      thumb.append(this.iconFor(download));
    }

    const info = el("div", { class: "info" }, [
      el("div", { class: "name-row" }, [
        el("span", { class: "name", text: name, title: download.target?.path || name }),
        state === "missing" ? el("span", { class: "badge warn", text: "файл перемещён" }) : null,
        state === "failed" ? el("span", { class: "badge warn", text: "ошибка" }) : null,
        state === "canceled" ? el("span", { class: "badge", text: "отменено" }) : null,
        state === "paused" ? el("span", { class: "badge", text: "пауза" }) : null,
        entry.justDone ? el("span", { class: "badge accent", text: "готово" }) : null,
      ]),
      el("div", { class: "meta" }, this.metaParts(download, state, host)),
      ["active", "paused", "pending"].includes(state)
        ? el("div", { class: `progress${download.hasProgress ? "" : " indeterminate"}`, style: `--p:${download.progress || 0}` }, el("span"))
        : null,
    ]);

    const actions = el("div", { class: "actions" }, this.actionButtons(download, state));
    node.append(thumb, info, actions);
    entry.node = node;
    entry.state = state;
    return node;
  },

  /** Плашка типа файла: значок по виду и расширение, цвет по категории. */
  iconFor(download) {
    const kind = kindOf(download);
    const ext = extOf(fileName(download));
    const glyph = {
      doc: ["M6 3h8l5 5v13H6z", "M14 3v5h5", "M9 13h6M9 17h6"],
      archive: ["M4 7h16v13H4z", "M4 7l1.5-3h13L20 7", "M10 11h4"],
      app: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M12 12l8-4.5M12 12v9M12 12L4 7.5"],
      video: ["M4 6h16v12H4z", "M10 9.5v5l4.5-2.5z"],
      image: ["M4 5h16v14H4z", "M4 15l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"],
      other: ["M6 3h8l5 5v13H6z", "M14 3v5h5"],
    }[kind] || ["M6 3h8l5 5v13H6z", "M14 3v5h5"];
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(k, v);
    }
    for (const d of glyph) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return el("span", { class: "plate", dataset: { kind } }, [svg, el("b", { class: "ext", text: ext || "файл" })]);
  },

  metaParts(d, state, host) {
    const parts = [];
    if (host) {
      parts.push(el("span", { class: "host" }, [el("img", { src: `page-icon:${d.source.url}`, alt: "" }), el("span", { text: host })]));
    }
    const dot = () => el("span", { class: "dot" });
    if (state === "active") {
      const left = d.totalBytes > 0 && d.speed > 0 ? (d.totalBytes - d.currentBytes) / d.speed : 0;
      parts.push(dot(), el("span", { class: "mono", text: d.totalBytes > 0 ? `${fmtSize(d.currentBytes)} из ${fmtSize(d.totalBytes)}` : fmtSize(d.currentBytes) }));
      if (d.speed > 0) {
        parts.push(dot(), el("span", { class: "mono speed", text: fmtSpeed(d.speed) }));
      }
      if (left) {
        parts.push(dot(), el("span", { text: `осталось ${fmtEta(left)}` }));
      }
    } else if (state === "paused") {
      parts.push(dot(), el("span", { class: "mono", text: `${fmtSize(d.currentBytes)}${d.totalBytes ? ` из ${fmtSize(d.totalBytes)}` : ""}` }));
    } else if (state === "failed") {
      parts.push(dot(), el("span", { class: "error", text: this.errorText(d) }));
    } else {
      const size = d.target?.size || d.totalBytes || d.currentBytes;
      if (size) {
        parts.push(dot(), el("span", { class: "mono", text: fmtSize(size) }));
      }
      if (d.startTime) {
        parts.push(dot(), el("span", { text: fmtTime(d.endTime || d.startTime) }));
      }
    }
    return parts;
  },

  errorText(d) {
    const e = d.error || {};
    if (e.becauseBlockedByParentalControls) {
      return "заблокировано родительским контролем";
    }
    if (e.becauseBlockedByReputationCheck) {
      return "файл помечен как опасный";
    }
    if (e.becauseTargetFailed) {
      return "не удалось записать файл";
    }
    if (e.becauseSourceFailed) {
      return "сервер оборвал загрузку";
    }
    return "не удалось скачать";
  },

  actionButtons(d, state) {
    const btn = (label, name, run, cls = "") => {
      const b = el("button", { class: `act ${cls}`.trim(), type: "button", title: label, "aria-label": label, onclick: e => { e.stopPropagation(); run(); } }, [icon(name), cls.includes("icon-only") ? null : el("span", { class: "label", text: label })]);
      return b;
    };
    switch (state) {
      case "active":
        return [
          btn("Пауза", "pause", () => d.cancel(), "icon-only"),
          btn("Отменить", "close", () => this.cancel(d), "icon-only danger"),
        ];
      case "paused":
        return [
          btn("Продолжить", "play", () => d.start(), "primary"),
          btn("Отменить", "close", () => this.cancel(d), "icon-only danger quiet"),
        ];
      case "pending":
        return [btn("Отменить", "close", () => this.cancel(d), "icon-only danger")];
      case "done":
        return [
          btn("Открыть", "open", () => this.open(d), "primary"),
          btn("Показать в Finder", "folder", () => d.showContainingDirectory(), "icon-only quiet"),
          btn("Убрать из списка", "close", () => this.removeFromList(d), "icon-only quiet"),
        ];
      case "missing":
        return [
          btn("Скачать снова", "download", () => this.redownload(d), ""),
          btn("Убрать из списка", "close", () => this.removeFromList(d), "icon-only quiet"),
        ];
      default: // failed, canceled
        return [
          btn("Повторить", "retry", () => this.retry(d), ""),
          btn("Убрать из списка", "close", () => this.removeFromList(d), "icon-only quiet"),
        ];
    }
  },

  /** Быстрое обновление без перестройки карточки: прогресс, скорость, время. */
  updateNode(d, entry) {
    const node = entry.node;
    const state = stateOf(d);
    const bar = node.querySelector(".progress");
    if (bar) {
      bar.style.setProperty("--p", d.progress || 0);
      bar.classList.toggle("indeterminate", !d.hasProgress);
    }
    const meta = node.querySelector(".meta");
    if (meta) {
      meta.replaceChildren(...this.metaParts(d, state, hostOf(d)));
    }
  },

  updateSummary() {
    const all = [...this.downloads.keys()];
    const active = all.filter(d => stateOf(d) === "active");
    const paused = all.filter(d => stateOf(d) === "paused");
    const speed = active.reduce((s, d) => s + (d.speed || 0), 0);
    const today = all.filter(d => d.succeeded && d.startTime && dayKey(d.startTime) === "today");
    const todayBytes = today.reduce((s, d) => s + (d.target?.size || d.totalBytes || 0), 0);
    const parts = [];
    if (active.length) {
      parts.push(el("b", { text: `${active.length} ${plural(active.length, "загрузка идёт", "загрузки идут", "загрузок идут")}` }));
      if (speed) {
        parts.push(" · ", el("span", { class: "mono", text: fmtSpeed(speed) }));
      }
    } else if (paused.length) {
      parts.push(el("b", { text: `${paused.length} на паузе` }));
    } else {
      parts.push("Ничего не скачивается");
    }
    if (today.length) {
      parts.push(" · сегодня ", el("b", { text: `${today.length} ${plural(today.length, "файл", "файла", "файлов")}` }), ", ", el("span", { class: "mono", text: fmtSize(todayBytes) }));
    }
    $("summary").replaceChildren(...parts);
    const count = active.length + paused.length;
    $("active-count").hidden = !count;
    $("active-count").textContent = String(count);
    $("pause-all").hidden = !active.length;
    $("resume-all").hidden = !paused.length;
    $("clear-done").disabled = !all.some(d => d.succeeded || d.error || d.canceled);
    document.title = `${active.length ? `${active.length} ↓ · ` : ""}Загрузки`;
  },

  /* ---- Действия ---- */

  async open(d) {
    try {
      await d.launch();
    } catch (e) {
      this.toast("Не удалось открыть файл");
    }
  },

  async cancel(d) {
    await d.cancel();
    await d.removePartialData().catch(() => {});
    await this.list.remove(d);
    this.toast("Загрузка отменена");
  },

  async retry(d) {
    try {
      await d.start();
    } catch (e) {
      this.toast("Не получилось: " + this.errorText(d));
    }
  },

  async redownload(d) {
    try {
      const fresh = await Downloads.createDownload({ source: d.source.url, target: d.target.path });
      await this.list.add(fresh);
      await this.list.remove(d);
      fresh.start().catch(() => {});
    } catch (e) {
      this.toast("Не удалось начать загрузку");
    }
  },

  async removeFromList(d) {
    const wasActive = !d.stopped;
    if (wasActive) {
      await d.cancel();
    }
    await this.list.remove(d);
    this.toast("Убрано из списка", async () => {
      await this.list.add(d);
    });
  },

  async deleteFile(d) {
    await DownloadsCommon.deleteDownloadFiles(d);
    this.toast("Файл удалён с диска");
  },

  copyLink(d) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(d.source.url);
    this.toast("Ссылка скопирована");
  },

  async openFolder() {
    const path = await Downloads.getPreferredDownloadsDirectory();
    const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    dir.initWithPath(path);
    DownloadsCommon.showDirectory(dir);
  },

  dragStart(d, e, node) {
    if (!d.succeeded || !d.target?.path) {
      e.preventDefault();
      return;
    }
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(d.target.path);
      if (!file.exists()) {
        e.preventDefault();
        return;
      }
      const url = Services.io.newFileURI(file).spec;
      e.dataTransfer.mozSetDataAt("application/x-moz-file", file, 0);
      e.dataTransfer.setData("text/uri-list", url);
      e.dataTransfer.setData("text/plain", url);
      e.dataTransfer.effectAllowed = "copyMove";
      const thumb = node.querySelector(".thumb");
      if (thumb) {
        e.dataTransfer.setDragImage(thumb, 28, 28);
      }
      node.dataset.dragging = "true";
    } catch (err) {
      e.preventDefault();
    }
  },

  contextMenu(d, x, y) {
    if (!Shell?.showMenuFromContent) {
      return;
    }
    const state = stateOf(d);
    const I = ICONS;
    const items = [];
    if (state === "done") {
      items.push({ label: "Открыть", icon: [I.open], run: () => this.open(d) });
      items.push({ label: "Показать в Finder", icon: [I.folder], run: () => d.showContainingDirectory() });
    }
    if (state === "active") {
      items.push({ label: "Пауза", icon: [I.pause], run: () => d.cancel() });
    }
    if (state === "paused") {
      items.push({ label: "Продолжить", icon: [I.play], run: () => d.start() });
    }
    if (state === "failed" || state === "canceled") {
      items.push({ label: "Повторить", icon: [I.retry], run: () => this.retry(d) });
    }
    if (state === "missing") {
      items.push({ label: "Скачать снова", icon: [I.download], run: () => this.redownload(d) });
    }
    items.push({ label: "Копировать ссылку", icon: [I.link], run: () => this.copyLink(d) });
    items.push({ label: "Открыть страницу источника", icon: [I.open], disabled: !/^https?:/.test(d.source.referrerInfo?.originalReferrer?.spec || ""), run: () => Shell.openUrl(d.source.referrerInfo.originalReferrer.spec) });
    items.push({ separator: true });
    items.push({ label: "Убрать из списка", icon: [I.close], hint: "⌫", run: () => this.removeFromList(d) });
    if (state === "done") {
      items.push({ label: "Удалить файл с диска", icon: [I.trash], danger: true, run: () => this.deleteFile(d) });
    }
    Shell.showMenuFromContent(window, items, x, y);
  },

  toast(text, undo) {
    const box = $("toasts");
    const node = el("div", { class: "toast", role: "status" }, [
      el("span", { text }),
      undo ? el("button", { type: "button", text: "Отменить", onclick: () => { undo(); node.remove(); } }) : null,
    ]);
    box.append(node);
    while (box.children.length > 3) {
      box.firstChild.remove();
    }
    setTimeout(() => node.remove(), undo ? 6000 : 3000);
  },

  bind() {
    $("search").addEventListener("input", e => {
      this.query = e.target.value;
      this.render();
    });
    $("filters").addEventListener("click", e => {
      const chip = e.target.closest(".chip");
      if (!chip) {
        return;
      }
      this.filter = chip.dataset.filter;
      for (const c of $("filters").children) {
        c.setAttribute("aria-pressed", String(c === chip));
      }
      this.render();
    });
    for (const [id, view] of [["view-list", "list"], ["view-grid", "grid"]]) {
      $(id).addEventListener("click", () => {
        this.view = view;
        $("page").dataset.view = view;
        $("view-list").setAttribute("aria-pressed", String(view === "list"));
        $("view-grid").setAttribute("aria-pressed", String(view === "grid"));
        try {
          localStorage.setItem("tabora.downloads.view", view);
        } catch (e) {
          Services.prefs.setStringPref("tabora.downloads.view", view);
        }
      });
    }
    $("view-list").setAttribute("aria-pressed", String(this.view === "list"));
    $("view-grid").setAttribute("aria-pressed", String(this.view === "grid"));
    $("open-folder").addEventListener("click", () => this.openFolder());
    $("clear-done").addEventListener("click", async () => {
      const gone = [...this.downloads.keys()].filter(d => d.succeeded || d.error || d.canceled);
      await this.list.removeFinished();
      this.toast(`Убрано: ${gone.length}`, async () => {
        for (const d of gone) {
          await this.list.add(d);
        }
      });
    });
    $("pause-all").addEventListener("click", () => [...this.downloads.keys()].filter(d => stateOf(d) === "active").forEach(d => d.cancel()));
    $("resume-all").addEventListener("click", () => [...this.downloads.keys()].filter(d => stateOf(d) === "paused").forEach(d => d.start()));
    document.addEventListener("keydown", e => {
      const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        $("search").focus();
      } else if (e.key === "Escape" && typing) {
        e.target.value = "";
        this.query = "";
        this.render();
        e.target.blur();
      }
    });
    // Перетаскивание на страницу: ссылку — скачать
    document.addEventListener("dragover", e => {
      if (e.dataTransfer.types.includes("text/uri-list") && !e.dataTransfer.types.includes("application/x-moz-file")) {
        e.preventDefault();
      }
    });
    document.addEventListener("drop", async e => {
      const url = e.dataTransfer.getData("text/uri-list").split("\n")[0]?.trim();
      if (!url || !/^https?:/.test(url) || e.dataTransfer.types.includes("application/x-moz-file")) {
        return;
      }
      e.preventDefault();
      try {
        const dir = await Downloads.getPreferredDownloadsDirectory();
        const name = decodeURIComponent(new URL(url).pathname.split("/").pop()) || "download";
        const d = await Downloads.createDownload({ source: url, target: PathUtils.join(dir, name) });
        await this.list.add(d);
        d.start().catch(() => {});
      } catch (err) {
        this.toast("Не удалось начать загрузку");
      }
    });
  },
};

App.init();
window.App = App;
