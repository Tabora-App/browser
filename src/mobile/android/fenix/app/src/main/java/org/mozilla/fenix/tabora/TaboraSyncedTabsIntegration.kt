/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.content.Context
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
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
                                    displayURL = tab.url,
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
