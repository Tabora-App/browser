/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Общее для разделов: раскладка «список — подробности», состояние ключей аккаунта и данных. */

import { clear, h, icon } from "../lib/dom.js";
import { busy, errorText, field, formError, modal, toast } from "../lib/ui.js";

/** Раскладка раздела: список слева, подробности справа; на телефоне — по очереди. */
export function split({ single = false } = {}) {
  const list = h("section", { class: "split-list" });
  const detail = h("section", { class: "split-detail" });
  const el = h("div", { class: `split${single ? " single" : ""}` }, list, single ? null : detail);
  return {
    el, list, detail,
    open() { el.dataset.detail = "open"; },
    close() { delete el.dataset.detail; },
  };
}

/** Кнопка «Назад» в шапке подробностей (видна на телефоне). */
export function backButton(onclick) {
  return h("button", { class: "icon-btn back", "aria-label": "Назад", onclick }, icon("back", 20));
}

/** Окно: вернуть доступ к ключам аккаунта ключом восстановления или прежним паролем. */
export function unlockKeysDialog(ctx) {
  const { account } = ctx;
  const canRecovery = account.keys.canRecovery;
  const canOld = account.keys.reason === "wrong-wrap";
  let mode = canRecovery ? "recovery" : "old";
  const recovery = field("Ключ восстановления", { mono: true, placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", autofocus: true });
  const old = field("Прежний пароль", { type: "password", autocomplete: "off", hint: "Тот, что был до сброса по письму." });
  const pass = field("Нынешний пароль", { type: "password", autocomplete: "current-password", hint: "Чтобы в следующий раз всё открылось одним паролем." });
  const error = formError();
  const tabs = h("div", { class: "chips" });
  const body = h("div", { class: "modal-form" });
  const draw = () => {
    clear(tabs, canRecovery && canOld ? [
      h("button", { class: "chip", "aria-pressed": String(mode === "recovery"), onclick: () => { mode = "recovery"; draw(); } }, "Ключ восстановления"),
      h("button", { class: "chip", "aria-pressed": String(mode === "old"), onclick: () => { mode = "old"; draw(); } }, "Прежний пароль"),
    ] : []);
    clear(body, mode === "recovery" ? recovery.el : old.el, pass.el, error.el);
  };
  draw();
  const submit = h("button", { class: "btn primary" }, "Открыть");
  const m = modal({ title: "Вернуть доступ к данным", content: [h("p", { class: "modal-text" }, "Пароли, коды и зашифрованные письма защищены ключом аккаунта. Его копия на сервере привязана к прежнему паролю."), tabs, body], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
  submit.addEventListener("click", async () => {
    error.set("");
    if (!pass.value) {
      error.set("Введите нынешний пароль");
      return;
    }
    try {
      await busy(submit, async step => {
        account.onStep = step;
        if (mode === "recovery") {
          await account.unlockWithRecovery(recovery.value, pass.value);
        } else {
          await account.unlockWithOldPassword(old.value, pass.value);
        }
      }, "Открываем");
      m.close();
      toast("Доступ к данным возвращён");
    } catch (e) {
      error.set(e.code === "wrong-wrap" ? (mode === "recovery" ? "Этот ключ восстановления не подходит" : "Прежний пароль не подходит") : e.code === "bad-credentials" ? "Нынешний пароль введён неверно" : errorText(e));
    } finally {
      account.onStep = null;
    }
  });
}

/**
 * Что мешает показать защищённые данные. null — ничего: ключи открыты. Иначе узел с объяснением
 * и действием. what — о чём раздел («пароли», «коды входа»…), для текста.
 */
export function keysGate(ctx, what) {
  const { account } = ctx;
  const k = account.keys;
  if (k.state === "ok") {
    return null;
  }
  if (k.state === "offline") {
    const retry = h("button", { class: "btn" }, "Повторить");
    retry.addEventListener("click", () => busy(retry, () => account.refreshKeys(), "Проверяем"));
    return h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("sync", 26, 1.6)), h("h3", {}, "Нет связи с сервером"), h("p", {}, `Чтобы открыть ${what}, нужно свериться с сервером Tabora. Проверьте интернет.`), retry);
  }
  if (k.reason === "wrong-wrap" || k.canRecovery) {
    return h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("lock", 26, 1.6)), h("h3", {}, "Данные закрыты ключом аккаунта"),
      h("p", {}, k.reason === "wrong-wrap" ? `Пароль аккаунта сбрасывали, а ${what} защищены ключом, который привязан к прежнему паролю. Введите ключ восстановления или прежний пароль — один раз.` : `Чтобы открыть ${what} здесь, введите ключ восстановления — один раз.`),
      h("button", { class: "btn primary", onclick: () => unlockKeysDialog(ctx) }, "Вернуть доступ"));
  }
  return h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("lock", 26, 1.6)), h("h3", {}, "Ключ аккаунта ещё не готов"),
    h("p", {}, `Ключ, которым защищены ${what}, пока есть только в Tabora на вашем компьютере. Откройте там «Почта» → «Шифрование» и нажмите «Сохранить копию», затем обновите эту страницу.`),
    h("button", { class: "btn", onclick: () => location.reload() }, "Обновить страницу"));
}

/**
 * Состояние данных синхронизации для раздела: null — данные загружены; иначе узел (загрузка,
 * ошибка). Раздел вызывает его при каждой перерисовке.
 */
export function syncGate(ctx, what) {
  const { sync } = ctx;
  const gate = keysGate(ctx, what);
  if (gate) {
    return gate;
  }
  if (sync.loaded) {
    return null;
  }
  if (sync.status === "key") {
    return h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("warning", 26, 1.6)), h("h3", {}, "Данные зашифрованы другим ключом"), h("p", {}, "Ключ аккаунта меняли, а данные на сервере остались от прежнего. Откройте Tabora на компьютере: он обновит их сам."));
  }
  if (sync.status === "offline" || sync.status === "error") {
    const retry = h("button", { class: "btn" }, "Повторить");
    retry.addEventListener("click", () => busy(retry, () => sync.refresh().catch(() => {}), "Загружаем"));
    return h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("sync", 26, 1.6)), h("h3", {}, "Не удалось загрузить данные"), h("p", {}, sync.status === "offline" ? "Нет связи с сервером. Проверьте интернет." : sync.error), retry);
  }
  return h("div", { class: "skeleton", "aria-label": "Загрузка" }, h("i"), h("i"), h("i"), h("i"), h("i"));
}

/** Перерисовывать раздел, когда меняются данные или ключи. Возвращает функцию отписки. */
export function watch(ctx, fn) {
  const off1 = ctx.sync.subscribe(fn);
  const off2 = ctx.account.subscribe(what => what === "keys" && fn());
  return () => {
    off1();
    off2();
  };
}

/** Сохранить изменение и сообщить об исходе: конфликт с другим устройством — не ошибка, а повод перечитать. */
export async function save(ctx, fn, done = "") {
  try {
    await fn();
    if (done) {
      toast(done);
    }
    return true;
  } catch (e) {
    toast(errorText(e), { tone: "bad", ms: 5000 });
    return false;
  }
}
