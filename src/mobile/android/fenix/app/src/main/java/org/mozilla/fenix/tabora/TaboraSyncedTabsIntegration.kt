/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.content.Context
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mozilla.components.browser.storage.sync.Tab as SyncTab
import mozilla.components.browser.storage.sync.TabEntry
import mozilla.components.support.base.feature.LifecycleAwareFeature
import org.mozilla.fenix.R
import org.mozilla.fenix.tabstray.redux.action.TabsTrayAction
import org.mozilla.fenix.tabstray.redux.store.TabsTrayStore
import org.mozilla.fenix.tabstray.syncedtabs.SyncButtonBinding
import org.mozilla.fenix.tabstray.syncedtabs.SyncedTabsListItem

/**
 * Страница «вкладки других устройств» в списке вкладок: показывает вкладки устройств аккаунта
 * Tabora. Данные приходят от модуля аккаунта через [TaboraAccount]; пока список вкладок открыт,
 * страница следит за переменами — вход, выход, новые вкладки.
 *
 * @param store Состояние списка вкладок.
 * @param context Контекст для надписей.
 * @param account Аккаунт Tabora.
 * @param lifecycleOwner Владелец экрана: с его закрытием наблюдение прекращается.
 * @param onOpenAccount Открыть экран «Аккаунт Tabora» (синхронизация вкладок выключена).
 */
class TaboraSyncedTabsIntegration(
    private val store: TabsTrayStore,
    private val context: Context,
    private val account: TaboraAccount,
    private val lifecycleOwner: LifecycleOwner,
    private val onOpenAccount: () -> Unit,
) : LifecycleAwareFeature {

    private var job: Job? = null
    private val syncButtonBinding = SyncButtonBinding(store) { refresh() }

    override fun start() {
        job =
            lifecycleOwner.lifecycleScope.launch {
                account.state.collect { state ->
                    store.dispatch(TabsTrayAction.UpdateSyncSignedIn(state.signedIn))
                    store.dispatch(TabsTrayAction.UpdateSyncedTabs(state.toListItems()))
                    store.dispatch(TabsTrayAction.SyncCompleted)
                }
            }
        syncButtonBinding.start()
        account.syncNow()
    }

    override fun stop() {
        job?.cancel()
        syncButtonBinding.stop()
    }

    private fun refresh() {
        account.syncNow()
        // Ответ модуля — сообщение о состоянии; если перемен нет, оно не придёт, и кнопку
        // останавливаем сами.
        lifecycleOwner.lifecycleScope.launch {
            delay(SPIN_MS)
            store.dispatch(TabsTrayAction.SyncCompleted)
        }
    }

    private fun TaboraAccount.State.toListItems(): List<SyncedTabsListItem> =
        when {
            !signedIn -> emptyList()
            !tabsOn ->
                listOf(
                    SyncedTabsListItem.Error(
                        errorText = context.getString(R.string.tabora_synced_tabs_off),
                        errorButton =
                            SyncedTabsListItem.ErrorButton(
                                buttonText = context.getString(R.string.tabora_account_title),
                                onClick = onOpenAccount,
                            ),
                    )
                )
            devices.isEmpty() -> listOf(SyncedTabsListItem.Error(context.getString(R.string.tabora_synced_tabs_empty)))
            else ->
                devices.map { device ->
                    SyncedTabsListItem.DeviceSection(
                        displayName = device.name,
                        tabs =
                            device.tabs.map { tab ->
                                SyncedTabsListItem.Tab(
                                    displayTitle = tab.title.ifEmpty { tab.url },
                                    displayURL = readableUrl(tab.url),
                                    action = SyncedTabsListItem.Tab.Action.None,
                                    tab =
                                        SyncTab(
                                            history = listOf(TabEntry(tab.title, tab.url, null)),
                                            active = 0,
                                            lastUsed = 0L,
                                            inactive = false,
                                        ),
                                )
                            },
                    )
                }
        }

    private companion object {
        const val SPIN_MS = 2500L
    }
}

private val NON_ASCII_ESCAPES = Regex("(?:%[89A-Fa-f][0-9A-Fa-f])+")

private fun Char.isLetterDigitOrMark(): Boolean =
    Character.isLetterOrDigit(this) ||
        Character.getType(this).let {
            it == Character.NON_SPACING_MARK.toInt() || it == Character.COMBINING_SPACING_MARK.toInt()
        }

/**
 * An address as people read it: percent-escapes of non-ASCII letters are decoded ("%D0%91" becomes
 * "Б"). ASCII escapes and anything that does not decode to plain letters, digits or marks stay as
 * written, so a decoded address never gains a slash, a space or an invisible character.
 */
private fun readableUrl(url: String): String =
    NON_ASCII_ESCAPES.replace(url) { match ->
        val escapes = match.value
        val bytes = ByteArray(escapes.length / 3) { i -> escapes.substring(i * 3 + 1, i * 3 + 3).toInt(16).toByte() }
        try {
            val text =
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString()
            if (text.all { it.isLetterDigitOrMark() }) text else escapes
        } catch (e: CharacterCodingException) {
            escapes
        }
    }
