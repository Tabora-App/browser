/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Почта: папки, список переписок, письмо. Раскладка повторяет почту в браузере Tabora: папки,
 * список, письмо; на узком экране — по одной колонке. */

import { clear, h, icon } from "../lib/dom.js";
import { avatar, busy, debounce, emptyState, errorText, menu, shortDate, toast } from "../lib/ui.js";
import { openAliases } from "./mail-aliases.js";
import { openCompose } from "./mail-compose.js";
import { renderThread } from "./mail-reader.js";

const ROLE_ICON = { inbox: "inbox", drafts: "drafts", sent: "sent", archive: "archive", junk: "spam", trash: "trash" };
const VIEWS = [["all", "Все"], ["unread", "Непрочитанные"], ["starred", "Со звездой"], ["files", "С вложениями"]];
const PAGE = 40;

export function mountMail(el, ctx, rest) {
  const { mail, account } = ctx;
  let folderId = rest[0] || "";
  let threadId = rest[1] || "";
  let view = "all";
  let query = "";
  let items = [];
  let total = 0;
  let loading = false;
  let listError = "";
  let more = false;
  let listToken = 0;
  let threadToken = 0;
  let messages = null;
  let threadError = "";
  let alive = true;

  const folders = h("nav", { class: "mail-folders", "aria-label": "Папки" });
  const title = h("h1", {});
  const listBody = h("div", { class: "list mail-items", role: "listbox", "aria-label": "Письма" });
  const reader = h("section", { class: "mail-reader" });
  const search = h("input", { type: "search", placeholder: "Поиск по письмам", "aria-label": "Поиск по письмам", autocomplete: "off", spellcheck: "false" });
  const chips = h("div", { class: "chips" });
  const folderButton = h("button", { class: "icon-btn mail-folder-switch", "aria-label": "Папки" }, icon("list", 20));
  const refreshButton = h("button", { class: "icon-btn", "aria-label": "Обновить" }, icon("reload", 18));
  const composeFab = h("button", { class: "fab", onclick: () => compose() }, icon("edit", 20), "Написать");
  const listPane = h("section", { class: "mail-list" },
    h("header", { class: "pane-head" }, folderButton, title, refreshButton),
    h("div", { class: "pane-tools" }, h("label", { class: "search" }, icon("search", 17), search), chips),
    listBody, composeFab);
  const root = h("div", { class: "mail" }, folders, listPane, reader);
  clear(el, root);

  const folderName = () => (folderId === "starred" ? "Со звездой" : mail.boxById(folderId)?.name || "Почта");
  const currentRole = () => mail.boxById(folderId)?.role || "";
  const compose = (opts = {}) => openCompose(ctx, { ...opts, onSent: () => { reload({ quiet: true }); refreshFolders(); }, onDraft: () => { if (currentRole() === "drafts") { reload({ quiet: true }); } refreshFolders(); } });

  /* ---- папки ---- */

  function folderItems() {
    const boxes = mail.boxes || [];
    const out = [];
    for (const b of boxes) {
      out.push({ id: b.id, name: b.name, icon: ROLE_ICON[b.role] || "folder", count: b.role === "drafts" ? b.total : b.unread, quiet: b.role !== "inbox" });
      if (b.role === "inbox") {
        out.push({ id: "starred", name: "Со звездой", icon: "star", count: 0 });
      }
    }
    return out;
  }

  function drawFolders() {
    clear(folders,
      h("button", { class: "btn primary block mail-compose", onclick: () => compose() }, icon("edit", 17), "Написать"),
      h("div", { class: "mail-folder-list" }, folderItems().map(f => h("a", { class: `mail-folder${f.id === folderId ? " active" : ""}`, href: `#/mail/${encodeURIComponent(f.id)}`, "aria-current": f.id === folderId ? "page" : null },
        icon(f.icon, 17), h("span", {}, f.name), f.count ? h("span", { class: `badge${f.quiet ? " quiet" : ""}` }, f.count > 999 ? "999+" : String(f.count)) : null))),
      h("div", { class: "mail-folders-foot" },
        h("button", { class: "mail-folder", onclick: () => openAliases(ctx) }, icon("mask", 17), h("span", {}, "Алиасы")),
        h("div", { class: "mail-me" }, h("span", {}, account.email))));
    title.textContent = query ? "Поиск" : folderName();
    ctx.setBadge("mail", mail.box("inbox")?.unread || 0);
  }

  async function refreshFolders() {
    try {
      await mail.folders({ refresh: true });
      if (alive) {
        drawFolders();
      }
    } catch (e) {}
  }

  folderButton.addEventListener("click", () => menu(folderButton, [
    ...folderItems().map(f => ({ label: f.count ? `${f.name} · ${f.count}` : f.name, icon: f.icon, run: () => ctx.navigate(`mail/${encodeURIComponent(f.id)}`) })),
    null,
    { label: "Алиасы", icon: "mask", run: () => openAliases(ctx) },
  ]));

  /* ---- список ---- */

  function drawChips() {
    clear(chips, VIEWS.map(([id, label]) => h("button", { class: "chip", "aria-pressed": String(view === id), onclick: () => { if (view !== id) { view = id; drawChips(); reload(); } } }, label)));
  }

  function row(it) {
    const role = currentRole();
    const mine = role === "sent" || role === "drafts";
    const who = mine ? (it.to.length ? `Кому: ${it.to.map(t => t.name || t.email).join(", ")}` : "Без получателя") : it.from.name || it.from.email || "Неизвестный отправитель";
    const star = h("button", { class: `icon-btn msg-star${it.starred ? " on" : ""}`, "aria-label": it.starred ? "Снять звезду" : "Отметить звездой", "aria-pressed": String(it.starred) }, icon("star", 16));
    star.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      const next = !it.starred;
      it.starred = next;
      drawList();
      try {
        await mail.setStar(next ? [it.id] : it.ids, next);
      } catch (err) {
        it.starred = !next;
        drawList();
        toast(errorText(err), { tone: "bad" });
      }
    });
    return h("a", { class: `msg${it.unread ? " unread" : ""}`, href: `#/mail/${encodeURIComponent(folderId)}/${encodeURIComponent(it.threadId)}`, role: "option", "aria-selected": String(it.threadId === threadId), "data-thread": it.threadId },
      avatar(mine ? it.to[0]?.name || it.to[0]?.email || "?" : it.from.name || it.from.email || "?"),
      h("span", { class: "msg-main" },
        h("span", { class: "msg-top" }, h("b", { class: "msg-from" }, who), it.count > 1 ? h("span", { class: "msg-count" }, String(it.count)) : null, h("time", {}, shortDate(it.date))),
        h("span", { class: "msg-subject" }, it.draft && role !== "drafts" ? h("i", { class: "msg-draft" }, "Черновик · ") : null, it.subject),
        h("span", { class: "msg-preview" }, it.preview || " ")),
      h("span", { class: "msg-side" }, it.hasAttachment ? icon("clip", 15) : null, star));
  }

  function drawList() {
    title.textContent = query ? "Поиск" : folderName();
    if (loading && !items.length) {
      clear(listBody, h("div", { class: "skeleton", "aria-label": "Загрузка" }, h("i"), h("i"), h("i"), h("i"), h("i"), h("i")));
      return;
    }
    if (listError && !items.length) {
      const retry = h("button", { class: "btn" }, "Повторить");
      retry.addEventListener("click", () => busy(retry, () => reload(), "Загружаем"));
      clear(listBody, h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("sync", 26, 1.6)), h("h3", {}, "Почта не загрузилась"), h("p", {}, listError), retry));
      return;
    }
    if (!items.length) {
      const role = currentRole();
      clear(listBody, query
        ? emptyState({ iconName: "search", title: "Ничего не найдено", text: "Попробуйте другое слово: имя отправителя, часть темы или текста." })
        : view !== "all"
          ? emptyState({ iconName: "mail", title: "Таких писем нет", text: "Снимите отбор, чтобы увидеть все письма папки." })
          : emptyState({ iconName: ROLE_ICON[role] || "mail", title: role === "inbox" ? "Входящих пока нет" : "Здесь пусто", text: role === "inbox" ? `Письма на ${account.email} появятся здесь.` : "" }));
      return;
    }
    const nodes = items.map(row);
    if (more) {
      const next = h("button", { class: "btn ghost block mail-more" }, loading ? "Загружаем…" : `Показать ещё (осталось ${total - items.length})`);
      next.addEventListener("click", () => loadMore());
      nodes.push(next);
    }
    const top = listBody.scrollTop;
    clear(listBody, nodes);
    listBody.scrollTop = top;
  }

  async function reload({ quiet = false } = {}) {
    const token = ++listToken;
    if (!quiet) {
      items = [];
      listBody.scrollTop = 0;
    }
    loading = true;
    listError = "";
    drawList();
    try {
      await mail.folders();
      if (!folderId || (folderId !== "starred" && !mail.boxById(folderId))) {
        const inbox = mail.box("inbox") || mail.boxes[0];
        ctx.navigate(`mail/${encodeURIComponent(inbox.id)}`, { replace: true });
        return;
      }
      const r = await mail.list({ folderId, view, query, position: 0, limit: quiet ? Math.max(PAGE, items.length) : PAGE });
      if (token !== listToken || !alive) {
        return;
      }
      items = r.items;
      total = r.total;
      more = items.length < total;
    } catch (e) {
      if (token !== listToken || !alive) {
        return;
      }
      listError = errorText(e);
    } finally {
      if (token === listToken) {
        loading = false;
      }
    }
    if (alive && token === listToken) {
      drawFolders();
      drawList();
    }
  }

  async function loadMore() {
    if (loading || !more) {
      return;
    }
    const token = ++listToken;
    loading = true;
    drawList();
    try {
      const r = await mail.list({ folderId, view, query, position: items.length, limit: PAGE });
      if (token !== listToken || !alive) {
        return;
      }
      const have = new Set(items.map(i => i.threadId));
      items = items.concat(r.items.filter(i => !have.has(i.threadId)));
      total = r.total;
      more = items.length < total && r.items.length > 0;
    } catch (e) {
      toast(errorText(e), { tone: "bad" });
    } finally {
      loading = false;
    }
    drawList();
  }

  listBody.addEventListener("scroll", () => {
    if (more && !loading && listBody.scrollTop + listBody.clientHeight > listBody.scrollHeight - 400) {
      loadMore();
    }
  });
  search.addEventListener("input", debounce(() => {
    const q = search.value.trim();
    if (q !== query) {
      query = q;
      reload();
    }
  }, 350));
  refreshButton.addEventListener("click", () => busyIcon(refreshButton, async () => {
    await mail.folders({ refresh: true });
    await reload({ quiet: true });
    if (threadId) {
      openThread({ quiet: true });
    }
  }));

  async function busyIcon(btn, fn) {
    btn.classList.add("spinning");
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(errorText(e), { tone: "bad" });
    } finally {
      btn.classList.remove("spinning");
      btn.disabled = false;
    }
  }

  /* ---- письмо ---- */

  function drawReader() {
    if (!threadId) {
      delete root.dataset.open;
      clear(reader, emptyState({ iconName: "mail", title: "Выберите письмо", text: "Оно откроется здесь." }));
      return;
    }
    root.dataset.open = "thread";
    if (threadError) {
      clear(reader, h("header", { class: "detail-head" }, h("button", { class: "icon-btn back", "aria-label": "Назад", onclick: () => ctx.navigate(`mail/${encodeURIComponent(folderId)}`) }, icon("back", 20))), emptyState({ iconName: "warning", title: "Письмо не открылось", text: threadError }));
      return;
    }
    if (!messages) {
      clear(reader, h("div", { class: "loading" }, h("span", { class: "spinner" })));
      return;
    }
    renderThread(reader, { ctx, messages, folderId, back: () => ctx.navigate(`mail/${encodeURIComponent(folderId)}`), act, compose });
  }

  async function openThread({ quiet = false } = {}) {
    const token = ++threadToken;
    const id = threadId;
    if (!quiet) {
      messages = null;
      threadError = "";
      drawReader();
    }
    if (!id) {
      return;
    }
    try {
      await mail.folders();
      const list = await mail.thread(id);
      if (token !== threadToken || !alive) {
        return;
      }
      const trash = mail.box("trash")?.id;
      // удалённые письма переписки видны только из корзины
      const shown = folderId === trash ? list : list.filter(m => !m.mailboxIds.includes(trash));
      if (!shown.length) {
        throw Object.assign(new Error("Письмо удалено или перенесено на другом устройстве"), { code: "not-found" });
      }
      messages = shown;
      threadError = "";
      drawReader();
      // открытое письмо становится прочитанным
      const unread = shown.filter(m => m.unread && !m.draft).map(m => m.id);
      if (unread.length) {
        await mail.setSeen(unread, true).catch(() => {});
        const it = items.find(i => i.threadId === id);
        if (it) {
          it.unread = false;
          drawList();
        }
        refreshFolders();
      }
    } catch (e) {
      if (token !== threadToken || !alive) {
        return;
      }
      messages = null;
      threadError = errorText(e);
      drawReader();
    }
  }

  /** Действие над открытой перепиской: архив, корзина, спам, непрочитанное, перенос. */
  async function act(kind, arg) {
    if (!messages) {
      return;
    }
    const here = folderId === "starred" ? messages.map(m => m.id) : messages.filter(m => m.mailboxIds.includes(folderId)).map(m => m.id);
    const ids = here.length ? here : messages.map(m => m.id);
    const role = currentRole();
    const gone = () => {
      const i = items.findIndex(x => x.threadId === threadId);
      const next = items[i + 1] || items[i - 1];
      items = items.filter(x => x.threadId !== threadId);
      total = Math.max(0, total - 1);
      drawList();
      ctx.navigate(next && window.matchMedia("(min-width: 821px)").matches ? `mail/${encodeURIComponent(folderId)}/${encodeURIComponent(next.threadId)}` : `mail/${encodeURIComponent(folderId)}`, { replace: true });
      refreshFolders();
    };
    try {
      if (kind === "archive") {
        await mail.move(ids, "archive");
        toast("Перенесено в архив");
        gone();
      } else if (kind === "trash") {
        const forever = role === "trash" || role === "drafts";
        await mail.remove(ids, { forever });
        toast(forever ? "Удалено" : "Перенесено в корзину");
        gone();
      } else if (kind === "junk") {
        await mail.move(ids, role === "junk" ? "inbox" : "junk");
        toast(role === "junk" ? "Перенесено во входящие" : "Перенесено в спам");
        gone();
      } else if (kind === "move") {
        await mail.move(ids, arg);
        toast(`Перенесено: ${mail.boxById(arg)?.name || "папка"}`);
        gone();
      } else if (kind === "unread") {
        await mail.setSeen([messages[messages.length - 1].id], false);
        const it = items.find(i => i.threadId === threadId);
        if (it) {
          it.unread = true;
        }
        drawList();
        ctx.navigate(`mail/${encodeURIComponent(folderId)}`);
        refreshFolders();
      } else if (kind === "star") {
        const on = !messages.some(m => m.starred);
        await mail.setStar(on ? [messages[messages.length - 1].id] : messages.map(m => m.id), on);
        messages.forEach((m, i) => (m.starred = on && i === messages.length - 1));
        const it = items.find(i => i.threadId === threadId);
        if (it) {
          it.starred = on;
        }
        drawList();
        drawReader();
      } else if (kind === "reload") {
        await openThread({ quiet: true });
      }
    } catch (e) {
      toast(errorText(e), { tone: "bad", ms: 5000 });
    }
  }

  /* ---- новое в ящике ---- */

  const offMail = ctx.onMailChange(() => {
    drawFolders();
    if (!search.value && document.visibilityState === "visible") {
      reload({ quiet: true });
    }
  });

  const onKey = e => {
    if (e.target.closest("input, textarea, [contenteditable], select") || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".modal-backdrop, .compose")) {
      return;
    }
    if (e.key === "c" || e.key === "с") {
      e.preventDefault();
      compose();
    } else if (e.key === "/") {
      e.preventDefault();
      search.focus();
    } else if ((e.key === "j" || e.key === "k" || e.key === "о" || e.key === "л") && items.length) {
      e.preventDefault();
      const i = items.findIndex(x => x.threadId === threadId);
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "j" || e.key === "о" ? 1 : -1)))];
      if (next && next.threadId !== threadId) {
        ctx.navigate(`mail/${encodeURIComponent(folderId)}/${encodeURIComponent(next.threadId)}`);
      }
    } else if (messages && (e.key === "e" || e.key === "у")) {
      act("archive");
    } else if (messages && (e.key === "#" || e.key === "Delete")) {
      act("trash");
    }
  };
  document.addEventListener("keydown", onKey);

  drawChips();
  drawFolders();
  drawReader();
  reload().then(() => {
    if (threadId) {
      openThread();
    }
  });

  return {
    route(next) {
      const f = next[0] || "";
      const t = next[1] || "";
      if (f !== folderId) {
        folderId = f;
        threadId = t;
        view = "all";
        query = "";
        search.value = "";
        drawChips();
        drawFolders();
        reload();
        openThread();
        drawReader();
        return;
      }
      if (t !== threadId) {
        threadId = t;
        for (const a of listBody.querySelectorAll(".msg")) {
          a.setAttribute("aria-selected", String(a.dataset.thread === threadId));
        }
        if (threadId) {
          openThread();
        } else {
          messages = null;
          threadError = "";
          drawReader();
        }
      }
    },
    destroy() {
      alive = false;
      offMail();
      document.removeEventListener("keydown", onKey);
    },
  };
}

