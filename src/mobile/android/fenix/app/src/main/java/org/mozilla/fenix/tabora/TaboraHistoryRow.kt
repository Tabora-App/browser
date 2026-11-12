/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.view.View
import androidx.core.view.isVisible
import org.mozilla.fenix.ext.components

/**
 * The "History from other devices" row of the app's history screen (layout
 * tabora_history_devices_nav_item). It stands under "Recently closed tabs", both above the list
 * and on the empty screen, and opens the module's screen with the pages opened on the computer
 * and on other devices of the Tabora account. The row is shown to those who are signed in and
 * have history sync turned on.
 */
object TaboraHistoryRow {
    private const val DISABLED_ALPHA = 0.7f

    /**
     * Show or hide the row and wire its tap.
     *
     * @param row The root view of the row.
     * @param visible Whether the place for the row is shown at all (top of the list, empty screen).
     * @param enabled False while history items are being selected.
     */
    fun bind(row: View, visible: Boolean, enabled: Boolean = true) {
        val account = row.context.components.core.taboraAccount
        val state = account.state.value
        row.isVisible = visible && state.signedIn && state.historyOn
        row.isEnabled = enabled
        row.alpha = if (enabled) 1f else DISABLED_ALPHA
        row.setOnClickListener { account.openPage(TaboraAccount.PAGE_HISTORY) }
    }
}
