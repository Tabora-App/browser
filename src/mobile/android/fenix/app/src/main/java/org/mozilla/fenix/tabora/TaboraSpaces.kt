/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.content.Context
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import mozilla.components.browser.state.action.BrowserAction
import mozilla.components.browser.state.action.TabListAction
import mozilla.components.browser.state.selector.findTab
import mozilla.components.browser.state.selector.getNormalOrPrivateTabs
import mozilla.components.browser.state.selector.selectedTab
import mozilla.components.browser.state.state.BrowserState
import mozilla.components.browser.state.state.TabSessionState
import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Store
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.fenix.R
import org.mozilla.fenix.tabstray.data.TabData

/**
 * Пространства в приложении: у каждого свои вкладки и свои данные сайтов (входы, cookies), как у
 * пространств браузера на компьютере. Движок умеет держать данные сайтов вкладки отдельно —
 * вкладке задаётся «контекст»; здесь список пространств, текущее пространство и правила:
 *
 *  - «Личное» есть всегда и живёт без контекста: в нём все вкладки, открытые до появления
 *    пространств;
 *  - новая вкладка открывается в текущем пространстве, вкладка из ссылки — в пространстве вкладки,
 *    из которой её открыли (см. [TaboraSpacesMiddleware]);
 *  - текущим становится пространство выбранной вкладки: открыл вкладку другого пространства —
 *    оказался в нём;
 *  - приватные вкладки к пространствам не относятся.
 *
 * Список общий с остальными устройствами аккаунта: его приносит и уносит модуль аккаунта
 * (web/src/phone/spaces.js). Номер пространства в аккаунте и контекст на телефоне — разные вещи:
 * контекст у каждого устройства свой и с пространством не расстаётся, даже когда номер меняется.
 */
class TaboraSpaces(private val context: Context) {
    /** Пространство: [contextId] пуст у «Личного». */
    data class Space(
        val id: String,
        val name: String,
        val icon: String,
        val color: String,
        val contextId: String?,
    )

    /** Список пространств («Личное» первым) и текущее. */
    data class State(val spaces: List<Space>, val currentId: String) {
        val current: Space
            get() = spaces.firstOrNull { it.id == currentId } ?: spaces.first()
    }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val mutableState = MutableStateFlow(read())

    val state: StateFlow<State> = mutableState

    init {
        instance = this
    }

    /** Контекст текущего пространства: с ним открываются новые вкладки. */
    val currentContextId: String?
        get() = state.value.current.contextId

    /** Пространство вкладки; вкладка с неизвестным контекстом считается личной. */
    fun spaceOf(tab: TabSessionState): Space {
        val spaces = state.value.spaces
        return spaces.firstOrNull { it.contextId != null && it.contextId == tab.contextId } ?: spaces.first()
    }

    /** Видна ли вкладка в текущем пространстве (приватные видны всегда). */
    fun shows(tab: TabSessionState): Boolean = tab.content.private || spaceOf(tab).id == state.value.current.id

    /** Перейти в пространство. */
    fun select(id: String) {
        val now = state.value
        if (now.currentId != id && now.spaces.any { it.id == id }) {
            prefs.edit().putString(KEY_CURRENT, id).apply()
            mutableState.value = now.copy(currentId = id)
        }
    }

    /** Выбрана вкладка: текущим становится её пространство. */
    fun follow(tab: TabSessionState?) {
        if (tab != null && !tab.content.private) {
            select(spaceOf(tab).id)
        }
    }

    /** Вкладки для списка вкладок: обычные — только текущего пространства. */
    fun tabData(browser: Flow<BrowserState>): Flow<TabData> =
        combine(browser, state) { browserState, _ ->
            TabData(selectedTabId = browserState.selectedTabId, tabs = browserState.tabs.filter { shows(it) })
        }

    /* ---- список для модуля аккаунта ---- */

    /** Пространства, кроме «Личного», в том виде, в каком они лежат в аккаунте. */
    fun list(): JSONArray {
        val out = JSONArray()
        state.value.spaces.drop(1).forEachIndexed { index, space ->
            out.put(
                JSONObject()
                    .put("id", space.id)
                    .put("n", space.name)
                    .put("i", space.icon)
                    .put("col", space.color)
                    .put("o", index + 1)
            )
        }
        return out
    }

    /**
     * Перемены из аккаунта разом: [changes] — список `{ id, data: { n, i, col, o } | null, from? }`.
     * `data: null` — пространство удалено; с открытыми вкладками оно не удаляется (вкладки остались
     * бы без пространства). `from` — прежний номер того же пространства, заведённого здесь до
     * сверки: номер меняется, контекст и вкладки остаются. Порядок — как на остальных устройствах:
     * пришедшие встают на свои места, остальные держат прежний.
     */
    fun apply(changes: JSONArray, inUse: (String) -> Boolean) {
        val now = state.value
        val saved = now.spaces.drop(1).toMutableList()
        val orders = HashMap<String, Double>()
        var current = now.currentId
        for (n in 0 until changes.length()) {
            val change = changes.optJSONObject(n) ?: continue
            val id = change.optString("id")
            if (id == PERSONAL || !ID.matches(id)) {
                continue
            }
            val data = change.optJSONObject("data")
            if (data == null) {
                val at = saved.indexOfFirst { it.id == id }
                if (at >= 0 && !saved[at].contextId.orEmpty().let { it.isNotEmpty() && inUse(it) }) {
                    saved.removeAt(at)
                    if (current == id) {
                        current = PERSONAL
                    }
                }
                continue
            }
            val name = data.optString("n").trim().take(MAX_NAME)
            if (name.isEmpty()) {
                continue
            }
            val from = change.optString("from")
            val at = saved.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: saved.indexOfFirst { from.isNotEmpty() && it.id == from }
            val space =
                Space(
                    id = id,
                    name = name,
                    icon = data.optString("i").takeIf { it in ICONS } ?: DEFAULT_ICON,
                    color = data.optString("col").takeIf { it in COLORS } ?: DEFAULT_COLOR,
                    contextId = if (at >= 0) saved[at].contextId else newContextId(),
                )
            if (at >= 0) {
                if (current == saved[at].id) {
                    current = id
                }
                saved[at] = space
            } else {
                saved.add(space)
            }
            data.optDouble("o").takeIf { !it.isNaN() }?.let { orders[id] = it }
        }
        val ordered = saved.mapIndexed { index, space -> space to (orders[space.id] ?: (index + HALF)) }.sortedBy { it.second }
        write(ordered.map { it.first }, current)
    }

    /* ---- хранение ---- */

    private fun personal() =
        Space(PERSONAL, context.getString(R.string.tabora_space_personal), "fingerprint", "yellow", null)

    private fun read(): State {
        val spaces = mutableListOf(personal())
        runCatching {
            val saved = JSONArray(prefs.getString(KEY_LIST, "[]"))
            for (i in 0 until saved.length()) {
                val item = saved.getJSONObject(i)
                val id = item.optString("id")
                val contextId = item.optString("ctx")
                if (ID.matches(id) && id != PERSONAL && contextId.isNotEmpty() && spaces.none { it.id == id }) {
                    spaces.add(Space(id, item.optString("n"), item.optString("i"), item.optString("col"), contextId))
                }
            }
        }
        val current = prefs.getString(KEY_CURRENT, PERSONAL) ?: PERSONAL
        return State(spaces, if (spaces.any { it.id == current }) current else PERSONAL)
    }

    private fun write(saved: List<Space>, current: String) {
        val list = JSONArray()
        saved.forEach {
            list.put(
                JSONObject().put("id", it.id).put("ctx", it.contextId).put("n", it.name).put("i", it.icon).put("col", it.color)
            )
        }
        prefs.edit().putString(KEY_LIST, list.toString()).putString(KEY_CURRENT, current).apply()
        mutableState.value = State(listOf(personal()) + saved, current)
    }

    private fun newContextId(): String {
        val abc = "abcdefghijklmnopqrstuvwxyz0123456789"
        val random = java.security.SecureRandom()
        return "tabora-space-" + (1..CONTEXT_CHARS).map { abc[random.nextInt(abc.length)] }.joinToString("")
    }

    companion object {
        /** Номер «Личного»: оно есть на каждом устройстве и в аккаунт не записывается. */
        const val PERSONAL = "personal"
        private const val PREFS = "tabora_spaces"
        private const val KEY_LIST = "list"
        private const val KEY_CURRENT = "current"
        private const val MAX_NAME = 60
        private const val CONTEXT_CHARS = 12
        private const val HALF = 0.5
        private const val DEFAULT_ICON = "circle"
        private const val DEFAULT_COLOR = "blue"
        private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

        /** Значки и цвета пространств — те же, что на компьютере. */
        val ICONS =
            listOf(
                "fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation",
                "food", "fruit", "pet", "tree", "chill", "fence",
            )
        val COLORS = listOf("blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple", "toolbar")

        @Volatile private var instance: TaboraSpaces? = null

        /**
         * Вкладки, которые видит человек: обычные — текущего пространства, приватные — все. Для
         * счётчика вкладок, перелистывания и «закрыть все»; хранению и восстановлению вкладок нужен
         * полный список, поэтому общий перечень вкладок не трогается.
         */
        fun visibleTabs(state: BrowserState, private: Boolean): List<TabSessionState> {
            val tabs = state.getNormalOrPrivateTabs(private)
            return if (private) tabs else tabs.filter { shows(it) }
        }

        /** Видна ли вкладка в текущем пространстве; пока пространства не запущены, видны все. */
        fun shows(tab: TabSessionState): Boolean = instance?.shows(tab) ?: true
    }
}

/**
 * Правила пространств для вкладок: в каком пространстве открывается новая вкладка, что происходит
 * с текущим пространством при выборе и закрытии вкладок.
 */
class TaboraSpacesMiddleware(
    private val spaces: () -> TaboraSpaces,
    private val showHome: () -> Unit,
) : Middleware<BrowserState, BrowserAction> {
    override fun invoke(
        store: Store<BrowserState, BrowserAction>,
        next: (BrowserAction) -> Unit,
        action: BrowserAction,
    ) {
        when (action) {
            is TabListAction.AddTabAction -> {
                next(inSpace(store.state, action))
                if (action.select) {
                    spaces().follow(store.state.selectedTab)
                }
            }
            is TabListAction.SelectTabAction, is TabListAction.RestoreAction -> {
                next(action)
                spaces().follow(store.state.selectedTab)
            }
            is TabListAction.RemoveAllNormalTabsAction -> {
                // «закрыть все вкладки» закрывает вкладки текущего пространства, а не всех
                val visible = TaboraSpaces.visibleTabs(store.state, private = false).map { it.id }
                removed(store, next, TabListAction.RemoveTabsAction(visible))
            }
            is TabListAction.RemoveTabAction, is TabListAction.RemoveTabsAction -> removed(store, next, action)
            else -> next(action)
        }
    }

    /** Новая обычная вкладка без пространства получает пространство родителя или текущее. */
    private fun inSpace(state: BrowserState, action: TabListAction.AddTabAction): TabListAction.AddTabAction {
        val tab = action.tab
        if (tab.content.private || tab.contextId != null) {
            return action
        }
        val parent = tab.parentId?.let { state.findTab(it) }
        val contextId =
            when {
                parent != null -> parent.contextId
                // у вкладки уже есть сеанс движка без контекста: менять его поздно
                tab.engineState.engineSession != null -> null
                else -> spaces().currentContextId
            }
        return if (contextId == null) action else action.copy(tab = tab.copy(contextId = contextId))
    }

    /**
     * Вкладки закрыты. Если закрыта выбранная, движок выбирает соседнюю — она может оказаться из
     * другого пространства. Тогда выбирается последняя открытая вкладка того же пространства, а если
     * в нём вкладок не осталось, человек остаётся в нём на домашнем экране.
     */
    private fun removed(store: Store<BrowserState, BrowserAction>, next: (BrowserAction) -> Unit, action: BrowserAction) {
        val before = store.state.selectedTab
        next(action)
        val after = store.state.selectedTab
        if (before == null || before.content.private || after?.id == before.id) {
            return
        }
        val space = spaces().spaceOf(before)
        if (after != null && !after.content.private && spaces().spaceOf(after).id == space.id) {
            return
        }
        val rest = store.state.getNormalOrPrivateTabs(private = false).filter { spaces().spaceOf(it).id == space.id }
        val last = rest.maxByOrNull { it.lastAccess }
        if (last != null) {
            store.dispatch(TabListAction.SelectTabAction(last.id))
        } else if (after != null) {
            showHome()
        }
    }
}
