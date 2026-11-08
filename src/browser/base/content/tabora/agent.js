/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Агент Tabora: разговор с моделью OpenAI в панели справа, потоковый ответ и
 * инструменты браузера (вкладки, пространства, страница, формы, почта, история,
 * закладки, загрузки, тема). Подключается из tabora.js через loadSubScript. */

Object.assign(Tabora, {
  AGENT_KEY_PREF: "tabora.agent.key",
  AGENT_MODEL_PREF: "tabora.agent.model",
  AGENT_MODELS: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
  AGENT_ENDPOINT: "https://api.openai.com/v1/chat/completions",
  agent: { history: [], busy: false, abort: null, seq: 0 },

  agentKey() {
    return Services.prefs.getStringPref(this.AGENT_KEY_PREF, "").trim();
  },

  agentModel() {
    return Services.prefs.getStringPref(this.AGENT_MODEL_PREF, "gpt-4.1-mini");
  },

  /* ---- Системная подсказка ------------------------------------------------- */

  agentSystemPrompt() {
    const tab = gBrowser.selectedTab;
    const url = tab.linkedBrowser?.currentURI?.spec || "";
    const space = this.activeSpace();
    const tabs = gBrowser.tabs.filter(t => !t.closing && !t.hidden).slice(0, 25).map(t => `#${t._tPos} ${t.selected ? "▶ " : ""}${(t.label || "").slice(0, 60)} — ${this.displayUrl(t.linkedBrowser?.currentURI?.spec || "")}`);
    const now = new Date();
    return [
      "Ты агент браузера Tabora. Отвечай по-русски, коротко и по делу, без лишних вступлений. Markdown допустим: абзацы, списки, **жирный**, `код`.",
      "У тебя есть инструменты браузера. Если задача требует действия, вызывай инструменты, а не описывай, что «мог бы» сделать. Перед опасными действиями (закрыть много вкладок, отправить форму, удалить историю) кратко подтверди у пользователя, если он не просил явно.",
      "Читай страницу через read_page, прежде чем делать саммари или отвечать по её содержимому. Для форм сначала вызови describe_forms, затем fill_form и click.",
      `Сейчас ${now.toLocaleString("ru-RU")}. Пространство: «${space?.name || "Личное"}». Активная вкладка: ${this.displayUrl(url)} — «${tab.label}».`,
      `Открытые вкладки:\n${tabs.join("\n")}`,
      "Адрес почты пользователя: " + (this._mail ? this.mail().ACCOUNT.address : "felix@tabora.app") + ". Алиасы вида site-xxxx@tabora.app создаются для регистраций.",
    ].join("\n\n");
  },

  /* ---- Инструменты ----------------------------------------------------------- */

  agentTools() {
    const P = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
    const str = (description, extra = {}) => ({ type: "string", description, ...extra });
    const tool = (name, description, parameters, run) => ({ type: "function", function: { name, description, parameters }, run });
    const space = () => this.activeSpace();
    const principal = () => Services.scriptSecurityManager.getSystemPrincipal();
    const tabById = id => {
      if (id === undefined || id === null || ["", "undefined", "null", "current", "active", "активная"].includes(String(id).trim().toLowerCase())) {
        return gBrowser.selectedTab;
      }
      const n = parseInt(String(id).replace(/[^\d]/g, ""), 10);
      return Number.isNaN(n) ? null : gBrowser.tabs.find(t => t._tPos === n && !t.closing) || null;
    };
    const pageActor = tab => (tab || gBrowser.selectedTab).linkedBrowser.browsingContext?.currentWindowGlobal?.getActor("TaboraMedia");
    const waitLoad = tab => new Promise(resolve => {
      const b = tab.linkedBrowser;
      if (!b.webProgress?.isLoadingDocument && b.currentURI?.spec !== "about:blank") {
        resolve();
        return;
      }
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        b.removeEventListener("load", done, true);
        setTimeout(resolve, 400);
      };
      timer = setTimeout(done, 12000);
      b.addEventListener("load", done, true);
    });

    return [
      tool("read_page", "Прочитать активную (или указанную) вкладку: заголовок, текст, заголовки разделов, ссылки, выделение пользователя.", P({ tab_id: str("Номер вкладки из списка. Не передавай параметр, чтобы читать активную вкладку"), limit: { type: "integer", description: "Максимум символов текста, по умолчанию 16000" } }), async ({ tab_id, limit }) => {
        const tab = tabById(tab_id);
        if (!tab) {
          return { error: "вкладка не найдена" };
        }
        if (tab.hasAttribute("pending")) {
          gBrowser.selectedTab = tab;
          await waitLoad(tab);
        }
        try {
          return await pageActor(tab).sendQuery("TaboraPage:Read", { limit: limit || 16000 });
        } catch (e) {
          return { error: "страницу нельзя прочитать: " + (e.message || e), url: tab.linkedBrowser.currentURI.spec, title: tab.label };
        }
      }),
      tool("list_tabs", "Список открытых вкладок во всех пространствах с номерами, адресами и состоянием.", P({}), async () => ({
        space: space()?.name,
        tabs: gBrowser.tabs.filter(t => !t.closing).map(t => ({ id: t._tPos, title: t.label, url: this.displayUrl(t.linkedBrowser?.currentURI?.spec || ""), selected: t.selected, pinned: t.pinned, sleeping: t.hasAttribute("pending"), space: this.activeSpaceFor(t)?.name || "Личное" })),
      })),
      tool("open_url", "Открыть адрес или поисковый запрос. new_tab=true открывает новую вкладку в текущем пространстве.", P({ url: str("Адрес (https://…) или поисковый запрос"), new_tab: { type: "boolean" } }, ["url"]), async ({ url, new_tab }) => {
        const target = this.looksLikeUrl(url) ? (/^[a-z]+:/i.test(url) ? url : `https://${url}`) : null;
        if (new_tab || !target) {
          if (!target) {
            this.go(url);
          } else {
            gBrowser.selectedTab = gBrowser.addTab(target, { userContextId: space()?.userContextId || 0, triggeringPrincipal: principal() });
          }
        } else {
          this.openUrl(target);
        }
        await waitLoad(gBrowser.selectedTab);
        return { ok: true, tab_id: gBrowser.selectedTab._tPos, url: gBrowser.selectedBrowser.currentURI.spec, title: gBrowser.selectedTab.label };
      }),
      tool("switch_tab", "Переключиться на вкладку по номеру.", P({ tab_id: str("Номер вкладки") }, ["tab_id"]), async ({ tab_id }) => {
        const tab = tabById(tab_id);
        if (!tab) {
          return { error: "вкладка не найдена" };
        }
        const sp = this.activeSpaceFor(tab);
        if (sp && sp.id !== this.activeSpaceId) {
          this.switchSpace(sp.id);
        }
        gBrowser.selectedTab = tab;
        return { ok: true, title: tab.label };
      }),
      tool("close_tabs", "Закрыть вкладки по номерам.", P({ tab_ids: { type: "array", items: { type: "string" } } }, ["tab_ids"]), async ({ tab_ids }) => {
        const tabs = tab_ids.map(tabById).filter(Boolean);
        if (tabs.length && tabs.length === gBrowser.tabs.filter(t => !t.closing).length) {
          BrowserCommands.openTab();
        }
        tabs.forEach(t => gBrowser.removeTab(t));
        return { closed: tabs.length };
      }),
      tool("sleep_tabs", "Усыпить (выгрузить из памяти) все вкладки кроме активной или указанные.", P({ tab_ids: { type: "array", items: { type: "string" }, description: "Пусто — все кроме активной" } }), async ({ tab_ids }) => {
        const tabs = tab_ids?.length ? tab_ids.map(tabById).filter(Boolean) : gBrowser.tabs.filter(t => !t.selected && !t.pinned && !t.closing && !t.hasAttribute("pending"));
        tabs.forEach(t => gBrowser.discardBrowser(t));
        this.updateMemory();
        return { slept: tabs.length };
      }),
      tool("spaces", "Пространства пользователя и действия с ними: list, switch, move_tab, create, rename.", P({ action: str("list | switch | move_tab | create | rename", { enum: ["list", "switch", "move_tab", "create", "rename"] }), space: str("Имя пространства"), tab_id: str("Для move_tab"), name: str("Новое имя для create/rename") }, ["action"]), async ({ action, space: name, tab_id, name: newName }) => {
        const find = n => this.spaces.find(s => s.name.toLowerCase() === String(n || "").toLowerCase());
        if (action === "list") {
          return this.spaces.map(s => ({ name: s.name, active: s.id === this.activeSpaceId, tabs: gBrowser.tabs.filter(t => !t.closing && !t.pinned && this.contextOf(t) === s.userContextId).length }));
        }
        if (action === "create") {
          this.addSpace();
          const created = this.spaces[this.spaces.length - 1];
          if (newName) {
            this.updateSpace(created, { name: newName });
          }
          return { ok: true, name: created.name };
        }
        const sp = find(name);
        if (!sp) {
          return { error: `пространство «${name}» не найдено`, available: this.spaces.map(s => s.name) };
        }
        if (action === "switch") {
          this.switchSpace(sp.id);
          return { ok: true };
        }
        if (action === "rename") {
          this.updateSpace(sp, { name: newName });
          return { ok: true };
        }
        const tab = tabById(tab_id);
        if (!tab) {
          return { error: "вкладка не найдена" };
        }
        this.moveTabQuiet(tab, sp);
        return { ok: true };
      }),
      tool("describe_forms", "Поля и кнопки на активной странице с номерами для fill_form и click.", P({}), async () => {
        try {
          return await pageActor().sendQuery("TaboraPage:Forms");
        } catch (e) {
          return { error: String(e.message || e) };
        }
      }),
      tool("fill_form", "Заполнить поля на активной странице. Поле задаётся id из describe_forms, либо label, либо CSS selector.", P({ fields: { type: "array", items: P({ id: { type: "integer" }, label: str(""), selector: str(""), value: str("Значение") }, ["value"]) } }, ["fields"]), async ({ fields }) => {
        try {
          return await pageActor().sendQuery("TaboraPage:Fill", { fields });
        } catch (e) {
          return { error: String(e.message || e) };
        }
      }),
      tool("click", "Нажать кнопку или ссылку на активной странице: по id из describe_forms, по тексту или CSS selector.", P({ id: { type: "integer" }, text: str(""), selector: str("") }), async args => {
        try {
          const res = await pageActor().sendQuery("TaboraPage:Click", args);
          await new Promise(r => setTimeout(r, 800));
          return { ...res, url: gBrowser.selectedBrowser.currentURI.spec };
        } catch (e) {
          return { error: String(e.message || e) };
        }
      }),
      tool("history_search", "Поиск по истории посещений.", P({ query: str("Текст запроса"), limit: { type: "integer" } }, ["query"]), async ({ query, limit }) => {
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        const q = PlacesUtils.history.getNewQuery();
        q.searchTerms = query;
        const o = PlacesUtils.history.getNewQueryOptions();
        o.sortingMode = o.SORT_BY_DATE_DESCENDING;
        o.resultType = o.RESULTS_AS_URI;
        o.maxResults = limit || 20;
        const root = PlacesUtils.history.executeQuery(q, o).root;
        root.containerOpen = true;
        const out = [];
        for (let i = 0; i < root.childCount; i++) {
          const n = root.getChild(i);
          out.push({ title: n.title, url: n.uri, when: new Date(n.time / 1000).toLocaleString("ru-RU") });
        }
        root.containerOpen = false;
        return out;
      }),
      tool("bookmarks", "Закладки: search по тексту или add для активной страницы.", P({ action: str("search | add", { enum: ["search", "add"] }), query: str("") }, ["action"]), async ({ action, query }) => {
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        if (action === "add") {
          const url = gBrowser.selectedBrowser.currentURI.spec;
          await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.toolbarGuid, url, title: gBrowser.selectedTab.label });
          return { ok: true, url };
        }
        const found = await PlacesUtils.bookmarks.search({ query: query || "" });
        return found.slice(0, 30).map(b => ({ title: b.title, url: b.url?.href }));
      }),
      tool("downloads", "Список последних загрузок с состоянием.", P({}), async () => {
        if (!this._dl) {
          await this.initDownloads();
        }
        const all = (await this._dl.list.getAll()).slice(-20).reverse();
        return all.map(d => ({ name: PathUtils.filename(d.target.path), state: !d.stopped ? "идёт" : d.succeeded ? "готово" : "ошибка", size: d.target.size || d.currentBytes, url: d.source.url }));
      }),
      tool("mail", "Почта Tabora: inbox (последние письма), find_code (свежий код подтверждения), compose (открыть окно письма с полями).", P({ action: str("inbox | find_code | compose", { enum: ["inbox", "find_code", "compose"] }), to: str(""), subject: str(""), body: str(""), site: str("Сайт, для которого ищем код") }, ["action"]), async ({ action, to, subject, body, site }) => {
        const { MailStore } = this.mail();
        await MailStore.ready();
        if (action === "compose") {
          this.openCompose({ to });
          const c = document.getElementById("tabora-compose");
          if (subject) {
            c.querySelector("#tabora-compose-subject, [name=subject]")?.setAttribute("value", subject);
            const subj = c.querySelector("#tabora-compose-subject, [name=subject]");
            if (subj) {
              subj.value = subject;
            }
          }
          if (body) {
            const ta = c.querySelector("textarea");
            if (ta) {
              ta.value = body;
            }
          }
          return { ok: true, note: "окно письма открыто, отправит пользователь" };
        }
        const msgs = MailStore.messages.filter(m => m.folder === "inbox").sort((a, b) => new Date(b.date) - new Date(a.date));
        if (action === "find_code") {
          const hit = msgs.find(m => m.code && (!site || (m.from?.email || "").includes(site) || (m.subject || "").toLowerCase().includes(site.toLowerCase())));
          return hit ? { code: hit.code, from: hit.from?.name, subject: hit.subject, when: hit.date } : { error: "код не найден" };
        }
        return msgs.slice(0, 15).map(m => ({ from: m.from?.name, subject: m.subject, unread: m.unread, code: m.code || undefined, when: m.date }));
      }),
      tool("set_theme", "Сменить тему браузера.", P({ theme: str("light | dark | system", { enum: ["light", "dark", "system"] }) }, ["theme"]), async ({ theme }) => {
        Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", { dark: 0, light: 1, system: 2 }[theme]);
        return { ok: true };
      }),
      tool("open_drawer", "Открыть раздел ящика: downloads, history, media, spaces, bookmarks; или mail для страницы почты.", P({ section: str("", { enum: ["downloads", "history", "media", "spaces", "bookmarks", "mail"] }) }, ["section"]), async ({ section }) => {
        if (section === "mail") {
          this.openMail();
        } else {
          this.openDrawer(section);
        }
        return { ok: true };
      }),
    ];
  },

  /* ---- Разговор ------------------------------------------------------------- */

  agentSend(raw) {
    const text = (raw || "").trim();
    if (!text) {
      return false;
    }
    this.toggleAgent(true);
    if (!this.agentKey()) {
      this.agentSay(text, "user");
      this.agentShowKeyCard();
      return true;
    }
    if (this.agent.busy) {
      this.agentStop();
    }
    this.agentSay(text, "user");
    this.agent.history.push({ role: "user", content: text });
    this.agentRun();
    return true;
  },

  async agentRun() {
    const a = this.agent;
    const seq = ++a.seq;
    a.busy = true;
    a.abort = new AbortController();
    this.agentStatus("Думает…", true);
    const tools = this.agentTools();
    const byName = Object.fromEntries(tools.map(t => [t.function.name, t]));
    const log = document.getElementById("tabora-agent-log");
    try {
      for (let round = 0; round < 8; round++) {
        const node = this.html("div", { class: "msg agent streaming" });
        log.append(node);
        log.scrollTop = log.scrollHeight;
        const { content, toolCalls } = await this.agentStream(
          [{ role: "system", content: this.agentSystemPrompt() }, ...a.history.slice(-40)],
          tools.map(({ run, ...t }) => t),
          a.abort.signal,
          partial => {
            node.textContent = partial;
            log.scrollTop = log.scrollHeight;
          }
        );
        if (seq !== a.seq) {
          return;
        }
        node.classList.remove("streaming");
        if (content) {
          node.replaceChildren(...this.agentMarkdown(content));
        } else {
          node.remove();
        }
        const message = { role: "assistant", content: content || null };
        if (toolCalls.length) {
          message.tool_calls = toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } }));
        }
        a.history.push(message);
        if (!toolCalls.length) {
          break;
        }
        for (const call of toolCalls) {
          const tool = byName[call.name];
          let args = {};
          try {
            args = JSON.parse(call.arguments || "{}");
          } catch (e) {}
          const chip = this.agentToolChip(call.name, args);
          this.agentStatus(`Выполняю: ${this.agentToolLabel(call.name, args)}`, true);
          let result;
          try {
            result = tool ? await tool.run(args) : { error: "неизвестный инструмент" };
          } catch (e) {
            result = { error: String(e.message || e) };
          }
          chip.setAttribute("done", result?.error ? "error" : "ok");
          if (result?.error) {
            chip.title = result.error;
          }
          a.history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 60000) });
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Tabora agent", e);
        this.agentSay(`Не получилось: ${e.message || e}`, "agent error");
      }
    } finally {
      if (seq === a.seq) {
        a.busy = false;
        a.abort = null;
        this.agentStatus("Готов к задачам", false);
        log.querySelector(".msg.streaming")?.classList.remove("streaming");
      }
    }
  },

  agentStop() {
    const a = this.agent;
    a.seq++;
    a.abort?.abort();
    a.busy = false;
    a.abort = null;
    this.agentStatus("Остановлено", false);
    document.querySelector("#tabora-agent-log .msg.streaming")?.classList.remove("streaming");
  },

  /** Потоковый запрос: собирает текст и вызовы инструментов из SSE-дельт. */
  async agentStream(messages, tools, signal, onPartial) {
    const res = await fetch(this.AGENT_ENDPOINT, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.agentKey()}` },
      body: JSON.stringify({ model: this.agentModel(), messages, tools, tool_choice: "auto", stream: true, temperature: 0.3 }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error?.message || "";
      } catch (e) {}
      throw new Error(`OpenAI ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const calls = [];
    const handle = json => {
      const delta = json.choices?.[0]?.delta;
      if (!delta) {
        return;
      }
      if (delta.content) {
        content += delta.content;
        onPartial(content);
      }
      for (const tc of delta.tool_calls || []) {
        const slot = (calls[tc.index] ||= { id: "", name: "", arguments: "" });
        if (tc.id) {
          slot.id = tc.id;
        }
        if (tc.function?.name) {
          slot.name += tc.function.name;
        }
        if (tc.function?.arguments) {
          slot.arguments += tc.function.arguments;
        }
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) {
          continue;
        }
        const data = s.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }
        try {
          handle(JSON.parse(data));
        } catch (e) {}
      }
    }
    return { content, toolCalls: calls.filter(c => c.name) };
  },

  /* ---- Отрисовка ------------------------------------------------------------- */

  agentSay(text, who) {
    const log = document.getElementById("tabora-agent-log");
    const node = this.html("div", { class: `msg ${who}` });
    if (who === "user") {
      node.textContent = text;
    } else {
      node.replaceChildren(...this.agentMarkdown(text));
    }
    log.append(node);
    log.scrollTop = log.scrollHeight;
    return node;
  },

  agentStatus(text, busy) {
    const where = document.getElementById("tabora-agent-where");
    if (where) {
      where.textContent = text;
    }
    document.getElementById("tabora-agent")?.toggleAttribute("busy", !!busy);
    const send = document.querySelector("#tabora-agent .send");
    if (send) {
      send.title = busy ? "Остановить" : "Отправить";
      send.replaceChildren(busy ? this.svg(["M7 7h10v10H7z"], 14, 2.2) : this.svg(["M5 12h14M13 6l6 6-6 6"], 16, 2.2));
    }
  },

  agentToolLabel(name, args) {
    const labels = {
      read_page: "читаю страницу",
      list_tabs: "смотрю вкладки",
      open_url: `открываю ${args.url ? String(args.url).replace(/^https?:\/\//, "").slice(0, 40) : "адрес"}`,
      switch_tab: "переключаю вкладку",
      close_tabs: `закрываю ${args.tab_ids?.length || ""} вкладок`,
      sleep_tabs: "усыпляю вкладки",
      spaces: `пространства: ${args.action}`,
      describe_forms: "изучаю форму",
      fill_form: `заполняю ${args.fields?.length || ""} полей`,
      click: `нажимаю ${args.text ? `«${args.text}»` : "кнопку"}`,
      history_search: `ищу в истории «${args.query || ""}»`,
      bookmarks: args.action === "add" ? "добавляю закладку" : "ищу в закладках",
      downloads: "смотрю загрузки",
      mail: { inbox: "смотрю входящие", find_code: "ищу код в почте", compose: "открываю письмо" }[args.action] || "почта",
      set_theme: "меняю тему",
      open_drawer: "открываю ящик",
    };
    return labels[name] || name;
  },

  agentToolChip(name, args) {
    const log = document.getElementById("tabora-agent-log");
    const chip = this.html("div", { class: "tool-chip" }, null, [
      this.html("span", { class: "spin" }),
      this.html("span", {}, this.agentToolLabel(name, args)),
    ]);
    log.append(chip);
    log.scrollTop = log.scrollHeight;
    return chip;
  },

  /** Markdown-лайт: абзацы, списки, код, жирный, ссылки. Без innerHTML. */
  agentMarkdown(text) {
    const out = [];
    const inline = s => {
      const nodes = [];
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
      let last = 0;
      let m;
      while ((m = re.exec(s))) {
        if (m.index > last) {
          nodes.push(document.createTextNode(s.slice(last, m.index)));
        }
        const tok = m[0];
        if (tok.startsWith("**")) {
          nodes.push(this.html("b", {}, tok.slice(2, -2)));
        } else if (tok.startsWith("`")) {
          nodes.push(this.html("code", {}, tok.slice(1, -1)));
        } else {
          const label = tok.slice(1, tok.indexOf("]("));
          const a = this.html("a", { href: m[2], class: "link" }, label);
          a.addEventListener("click", e => {
            e.preventDefault();
            this.openInSpace(m[2], true);
          });
          nodes.push(a);
        }
        last = m.index + tok.length;
      }
      if (last < s.length) {
        nodes.push(document.createTextNode(s.slice(last)));
      }
      return nodes;
    };
    const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split("\n");
      if (/^```/.test(lines[0])) {
        out.push(this.html("pre", {}, lines.slice(1).filter(l => !/^```/.test(l)).join("\n")));
      } else if (lines.every(l => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d/.test(lines[0]);
        out.push(this.html(ordered ? "ol" : "ul", {}, null, lines.map(l => this.html("li", {}, null, inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))))));
      } else if (/^#{1,3}\s/.test(lines[0])) {
        out.push(this.html("b", { class: "h" }, lines[0].replace(/^#+\s*/, "")));
        if (lines.length > 1) {
          out.push(this.html("p", {}, null, inline(lines.slice(1).join("\n"))));
        }
      } else {
        out.push(this.html("p", {}, null, inline(block)));
      }
    }
    return out;
  },

  agentShowKeyCard() {
    const log = document.getElementById("tabora-agent-log");
    if (log.querySelector(".key-card")) {
      return;
    }
    const input = this.html("input", { type: "password", placeholder: "sk-…", "aria-label": "Ключ OpenAI" });
    const save = this.html("button", { class: "primary", type: "button" }, "Подключить");
    const card = this.html("div", { class: "key-card" }, null, [
      this.html("b", {}, "Подключите OpenAI"),
      this.html("span", {}, "Вставьте API-ключ. Он хранится только в вашем профиле и уходит напрямую в OpenAI."),
      this.html("div", { class: "row" }, null, [input, save]),
    ]);
    const commit = () => {
      const v = input.value.trim();
      if (!/^sk-/.test(v)) {
        input.focus();
        return;
      }
      Services.prefs.setStringPref(this.AGENT_KEY_PREF, v);
      card.remove();
      this.notice("Агент подключён");
      const last = [...this.agent.history].reverse().find(m => m.role === "user");
      if (!last) {
        const lastUser = log.querySelector(".msg.user:last-of-type");
        if (lastUser) {
          this.agent.history.push({ role: "user", content: lastUser.textContent });
          this.agentRun();
        }
      }
    };
    save.addEventListener("click", commit);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        commit();
      }
      e.stopPropagation();
    });
    log.append(card);
    log.scrollTop = log.scrollHeight;
    input.focus();
  },

  agentMenuItems() {
    const model = this.agentModel();
    return [
      { label: "Модель", children: this.AGENT_MODELS.map(m => ({ label: m, checked: m === model, run: () => Services.prefs.setStringPref(this.AGENT_MODEL_PREF, m) })) },
      { label: this.agentKey() ? "Сменить ключ OpenAI…" : "Подключить OpenAI…", run: () => { Services.prefs.clearUserPref(this.AGENT_KEY_PREF); this.agentShowKeyCard(); } },
      { separator: true },
      { label: "Очистить разговор", run: () => this.agentClear() },
    ];
  },

  agentClear() {
    this.agentStop();
    this.agent.history = [];
    const log = document.getElementById("tabora-agent-log");
    log.replaceChildren(this.html("div", { class: "msg agent" }, "Чем помочь? Могу прочитать страницу и сделать саммари, разобрать вкладки по пространствам, найти код из письма, заполнить форму или открыть что угодно."));
    this.agentStatus("Готов к задачам", false);
  },
});
