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
 * Spaces in the app: each has its own tabs and its own site data (sign-ins, cookies), like the
 * spaces of the desktop browser. The engine can keep the site data of a tab apart: a tab is given
 * a "context". This class holds the list of spaces, the current space and the rules:
 *
 *  - "Personal" always exists and lives without a context: it holds every tab opened before
 *    spaces appeared;
 *  - a new tab opens in the current space, a tab opened from a link opens in the space of the tab
 *    it came from (see [TaboraSpacesMiddleware]);
 *  - the space of the selected tab becomes current: opening a tab of another space moves you
 *    there;
 *  - private tabs do not belong to spaces.
 *
 * The list is shared with the other devices of the account: the account module carries it to the
 * server and back (web/src/phone/spaces.js). The ID of a space in the account and the context on
 * the phone are different things: every device has its own context, and it stays with the space
 * even when the ID changes.
 */
class TaboraSpaces(private val context: Context) {
    /** A space; [contextId] is null for "Personal". */
    data class Space(
        val id: String,
        val name: String,
        val icon: String,
        val color: String,
        val contextId: String?,
    )

    /** The list of spaces ("Personal" first) and the current one. */
    data class State(val spaces: List<Space>, val currentId: String) {
        val current: Space
            get() = spaces.firstOrNull { it.id == currentId } ?: spaces.first()
    }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val mutableState = MutableStateFlow(read())

    val state: StateFlow<State> = mutableState

    /** Called after the person changed the list on this phone: the change goes to the account. */
    var onLocalChange: (() -> Unit)? = null

    init {
        instance = this
    }

    /** The context of the current space: new tabs open with it. */
    val currentContextId: String?
        get() = state.value.current.contextId

    /** The space of a tab; a tab with an unknown context counts as personal. */
    fun spaceOf(tab: TabSessionState): Space = spaceOfContext(tab.contextId)

    /** The space that owns a context; null and unknown contexts belong to "Personal". */
    fun spaceOfContext(contextId: String?): Space {
        val spaces = state.value.spaces
        return spaces.firstOrNull { it.contextId != null && it.contextId == contextId } ?: spaces.first()
    }

    /** Whether a tab is visible in the current space (private tabs always are). */
    fun shows(tab: TabSessionState): Boolean = tab.content.private || spaceOf(tab).id == state.value.current.id

    /** Move to a space. */
    fun select(id: String) {
        val now = state.value
        if (now.currentId != id && now.spaces.any { it.id == id }) {
            prefs.edit().putString(KEY_CURRENT, id).apply()
            mutableState.value = now.copy(currentId = id)
        }
    }

    /** A tab was selected: its space becomes current. */
    fun follow(tab: TabSessionState?) {
        if (tab != null && !tab.content.private) {
            select(spaceOf(tab).id)
        }
    }

    /** Tabs for the tab manager: normal tabs of the current space only. */
    fun tabData(browser: Flow<BrowserState>): Flow<TabData> =
        combine(browser, state) { browserState, _ ->
            TabData(selectedTabId = browserState.selectedTabId, tabs = browserState.tabs.filter { shows(it) })
        }

    /* ---- changes made on this phone ---- */

    /** Create a space. Returns it, or null if the name is empty. */
    fun create(name: String, icon: String, color: String): Space? {
        val clean = name.trim().take(MAX_NAME)
        if (clean.isEmpty()) {
            return null
        }
        val now = state.value
        val id = "space-" + System.currentTimeMillis().toString(ID_RADIX) + randomChars(ID_TAIL)
        val space =
            Space(
                id = id,
                name = clean,
                icon = icon.takeIf { it in ICONS } ?: DEFAULT_ICON,
                color = color.takeIf { it in COLORS } ?: DEFAULT_COLOR,
                contextId = newContextId(),
            )
        write(now.spaces.drop(1) + space, now.currentId)
        onLocalChange?.invoke()
        return space
    }

    /** Change the name, icon or color of a space. */
    fun update(id: String, name: String, icon: String, color: String) {
        val clean = name.trim().take(MAX_NAME)
        val now = state.value
        val saved = now.spaces.drop(1)
        if (clean.isEmpty() || saved.none { it.id == id }) {
            return
        }
        val next =
            saved.map { space ->
                if (space.id == id) {
                    space.copy(
                        name = clean,
                        icon = icon.takeIf { it in ICONS } ?: space.icon,
                        color = color.takeIf { it in COLORS } ?: space.color,
                    )
                } else {
                    space
                }
            }
        write(next, now.currentId)
        onLocalChange?.invoke()
    }

    /** Move a space one place left ([delta] = -1) or right (+1) in the list. */
    fun move(id: String, delta: Int) {
        val now = state.value
        val saved = now.spaces.drop(1).toMutableList()
        val from = saved.indexOfFirst { it.id == id }
        val to = from + delta
        if (from < 0 || to < 0 || to >= saved.size) {
            return
        }
        saved.add(to, saved.removeAt(from))
        write(saved, now.currentId)
        onLocalChange?.invoke()
    }

    /**
     * Delete a space; its tabs must be closed by now. Returns its context, so that the caller can
     * erase the site data kept under it, or null if there is no such space.
     */
    fun delete(id: String): String? {
        val now = state.value
        val space = now.spaces.drop(1).firstOrNull { it.id == id } ?: return null
        write(now.spaces.drop(1).filter { it.id != id }, if (now.currentId == id) PERSONAL else now.currentId)
        onLocalChange?.invoke()
        return space.contextId
    }

    /* ---- the list for the account module ---- */

    /** Spaces except "Personal", in the form they are kept in the account. */
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
     * Changes from the account, all at once: [changes] is a list of
     * `{ id, data: { n, i, col, o } | null, from? }`. `data: null` means the space was deleted; a
     * space with open tabs is not deleted (the tabs would be left without a space). `from` is the
     * previous ID of the same space, created here before the first sync: the ID changes, the
     * context and the tabs stay. The order is the same as on the other devices: spaces that came
     * take their places, the rest keep theirs.
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

    /* ---- storage ---- */

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

    private fun randomChars(count: Int): String {
        val abc = "abcdefghijklmnopqrstuvwxyz0123456789"
        val random = java.security.SecureRandom()
        return (1..count).map { abc[random.nextInt(abc.length)] }.joinToString("")
    }

    private fun newContextId(): String = "tabora-space-" + randomChars(CONTEXT_CHARS)

    companion object {
        /** The ID of "Personal": it exists on every device and is not written to the account. */
        const val PERSONAL = "personal"
        private const val PREFS = "tabora_spaces"
        private const val KEY_LIST = "list"
        private const val KEY_CURRENT = "current"
        private const val MAX_NAME = 60
        private const val CONTEXT_CHARS = 12
        private const val ID_RADIX = 36
        private const val ID_TAIL = 3
        private const val HALF = 0.5
        private const val DEFAULT_ICON = "circle"
        private const val DEFAULT_COLOR = "blue"
        private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

        /** Icons and colors of spaces: the same as on the desktop. */
        val ICONS =
            listOf(
                "fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation",
                "food", "fruit", "pet", "tree", "chill", "fence",
            )
        val COLORS = listOf("blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple", "toolbar")

        @Volatile private var instance: TaboraSpaces? = null

        /**
         * The tabs a person sees: normal tabs of the current space, all private tabs. For the tab
         * counter, swiping between tabs and "close all". Saving and restoring tabs need the full
         * list, which is why the common list of tabs is left alone.
         */
        fun visibleTabs(state: BrowserState, private: Boolean): List<TabSessionState> {
            val tabs = state.getNormalOrPrivateTabs(private)
            return if (private) tabs else tabs.filter { shows(it) }
        }

        /** Whether a tab is visible in the current space; until spaces start, every tab is. */
        fun shows(tab: TabSessionState): Boolean = instance?.shows(tab) ?: true

        /** The current space, or null until spaces start. */
        fun current(): Space? = instance?.state?.value?.current
    }
}

/**
 * The rules of spaces for tabs: which space a new tab opens in, and what happens to the current
 * space when tabs are selected and closed.
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
                // "Close all tabs" closes the tabs of the current space, not of every space
                val visible = TaboraSpaces.visibleTabs(store.state, private = false).map { it.id }
                removed(store, next, TabListAction.RemoveTabsAction(visible))
            }
            is TabListAction.RemoveTabAction, is TabListAction.RemoveTabsAction -> removed(store, next, action)
            else -> next(action)
        }
    }

    /** A new normal tab without a space gets the space of its parent or the current one. */
    private fun inSpace(state: BrowserState, action: TabListAction.AddTabAction): TabListAction.AddTabAction {
        val tab = action.tab
        if (tab.content.private || tab.contextId != null) {
            return action
        }
        val parent = tab.parentId?.let { state.findTab(it) }
        val contextId =
            when {
                parent != null -> parent.contextId
                // the tab already has an engine session without a context: too late to change it
                tab.engineState.engineSession != null -> null
                else -> spaces().currentContextId
            }
        return if (contextId == null) action else action.copy(tab = tab.copy(contextId = contextId))
    }

    /**
     * Tabs were closed. When the selected tab is closed, the engine selects a neighbour, which may
     * belong to another space. Then the most recently used tab of the same space is selected, and
     * if the space has no tabs left, the person stays in it on the home screen.
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
