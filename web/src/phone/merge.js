/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Слияние набора данных телефона с сервером — для данных, у которых на телефоне своё хранилище
 * (пароли сайтов). Правила те же, что в браузере на компьютере (sync/Sync.sys.mjs, _collection):
 * ошибка слияния не должна стоить данных.
 *
 * «Тень» — что о каждой записи известно с последней сверки: [версия на сервере, отпечаток
 * содержимого]. Отпечаток "" — запись удалена, "!" — пришла, но в хранилище не легла.
 *
 *  - чужое удаление применяется, только если запись здесь не менялась с последней сверки;
 *    изменённая остаётся и уходит на сервер заново;
 *  - если запись изменили и здесь, и там — остаётся более поздняя (src.newer);
 *  - запись, пропавшая здесь, удаляется и на сервере — но если разом пропало много записей
 *    (20 и больше трети набора), удаления не отправляются, пока человек не решит, что с ними делать;
 *  - в тень после применения идёт то, что получилось в хранилище: мелкая нормализация не должна
 *    вернуться на сервер как «изменение». */

import { hex, sha256, utf8 } from "../core/bytes.js";

const MASS_MIN = 20; // столько пропавших записей набора разом уже подозрительно…
const MASS_SHARE = 0.3; // …если это больше такой доли набора
const BATCH = 100;

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  }
  return value;
}

/** Отпечаток содержимого записи: по тем полям, которые источник считает содержимым. */
export async function fingerprint(src, data) {
  return hex(await sha256(utf8(JSON.stringify(stable(src.hashable(data)))))).slice(0, 32);
}

/**
 * Один проход слияния набора.
 * @param {{ sync: import("../core/sync.js").SyncClient, name: string,
 *   src: { list(): Promise<Map<string, object>>, apply(changes: object[], ctx: object): Promise<{ dirty?: string[] } | void>, hashable(d: object): object, newer?(a: object, b: object): boolean },
 *   state: { shadow: Record<string, [number, string]>, hold: object | null, allow?: boolean } }} deps
 * @returns {Promise<{ clean: boolean, applied: number, pushed: number }>} clean: false — нужен ещё проход
 */
export async function mergeCollection({ sync, name, src, state }) {
  const shadow = state.shadow;

  // --- что на сервере новее тени ---
  const incoming = new Map();
  for (const { id, rev, data } of sync.list(name)) {
    const s = shadow[id];
    if (!s || s[0] < rev) {
      incoming.set(id, { rev, data });
    }
  }
  for (const [id, rev] of sync.tombstones(name)) {
    const s = shadow[id];
    if (s && s[0] < rev) {
      incoming.set(id, { rev, deleted: true });
    }
  }

  // --- применить чужое ---
  let local = await src.list();
  const hashAll = async map => new Map(await Promise.all([...map].map(async ([id, d]) => [id, await fingerprint(src, d)])));
  let hashes = await hashAll(local);
  const apply = [];
  const applied = new Map(); // номер → { rev, hash } пришедшей записи
  for (const [id, r] of incoming) {
    const s = shadow[id];
    const has = local.has(id);
    const hL = hashes.get(id);
    if (r.deleted) {
      if (has && s && s[1] && s[1] === hL) {
        apply.push({ id, data: null });
        applied.set(id, { rev: r.rev, hash: "" });
      } else {
        // здесь записи нет — или она изменена после последней сверки и остаётся (уйдёт на сервер заново)
        shadow[id] = [r.rev, ""];
      }
      continue;
    }
    const hR = await fingerprint(src, r.data);
    if (has && hL === hR) {
      shadow[id] = [r.rev, hR];
      continue;
    }
    const changedHere = has && (!s || s[1] !== hL);
    if (changedHere && src.newer?.(local.get(id), r.data)) {
      shadow[id] = [r.rev, hR]; // побеждает здешняя: её отпечаток отличается от тени, она уйдёт на сервер
      continue;
    }
    apply.push({ id, data: r.data });
    applied.set(id, { rev: r.rev, hash: hR });
  }
  if (apply.length) {
    const fresh = new Set(Object.keys(shadow).filter(id => shadow[id][1]));
    const out = (await src.apply(apply, { synced: id => fresh.has(id) })) || {};
    const dirty = new Set(out.dirty || []);
    local = await src.list();
    hashes = await hashAll(local);
    for (const [id, r] of applied) {
      if (!r.hash) {
        shadow[id] = [r.rev, ""];
      } else if (!local.has(id)) {
        shadow[id] = [r.rev, "!"]; // запись не легла: не считаем её удалённой здесь и повторим позже
      } else {
        shadow[id] = [r.rev, dirty.has(id) ? r.hash : hashes.get(id)];
      }
    }
  }

  // --- отправить своё ---
  const push = [];
  for (const [id, data] of local) {
    const s = shadow[id];
    const h = hashes.get(id);
    if (!s || s[1] !== h) {
      push.push({ id, data, h });
    }
  }
  const live = Object.keys(shadow).filter(id => shadow[id][1] && shadow[id][1] !== "!");
  const gone = live.filter(id => !local.has(id));
  if (gone.length >= MASS_MIN && gone.length > live.length * MASS_SHARE && !state.allow) {
    state.hold = { missing: gone.length, of: live.length, at: Date.now() };
  } else {
    state.hold = null;
    state.allow = false;
    gone.forEach(id => push.push({ id, data: null }));
  }

  let clean = true;
  let pushed = 0;
  for (let i = 0; i < push.length; i += BATCH) {
    const batch = push.slice(i, i + BATCH);
    try {
      await sync.write(batch.map(p => ({ c: name, id: p.id, data: p.data })));
    } catch (e) {
      if (e.code !== "conflict") {
        throw e;
      }
      clean = false; // запись изменили на сервере, пока мы шли: следующий проход прочитает её
    }
    const conflicted = new Set();
    // что из пачки сервер принял, видно по версиям у клиента: принятое получило новую версию
    for (const p of batch) {
      if (p.data === null) {
        const rev = sync.tombstones(name).find(([id]) => id === p.id)?.[1] || 0;
        if (sync.revOf(name, p.id)) {
          conflicted.add(p.id); // на сервере запись успели изменить: она вернётся следующим проходом
        } else if (rev) {
          shadow[p.id] = [rev, ""];
          pushed++;
        } else {
          delete shadow[p.id]; // на сервере записи нет вовсе: удалять нечего
        }
      } else {
        const rev = sync.revOf(name, p.id);
        const stored = sync.get(name, p.id);
        if (rev && stored && (await fingerprint(src, stored)) === p.h) {
          shadow[p.id] = [rev, p.h];
          pushed++;
        } else {
          conflicted.add(p.id);
        }
      }
    }
    if (conflicted.size) {
      clean = false;
    }
  }
  return { clean, applied: apply.length, pushed };
}
