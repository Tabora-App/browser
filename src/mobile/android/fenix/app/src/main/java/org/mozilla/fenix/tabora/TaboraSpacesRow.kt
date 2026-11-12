/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import mozilla.components.browser.state.action.TabListAction
import mozilla.components.browser.state.selector.getNormalOrPrivateTabs
import org.mozilla.fenix.ext.components

/** Цвета пространств — те же названия и оттенки, что у пространств на компьютере. */
private val SPACE_COLORS =
    mapOf(
        "blue" to Color(0xFF37ADFF),
        "turquoise" to Color(0xFF00C79A),
        "green" to Color(0xFF51CD00),
        "yellow" to Color(0xFFFFCB00),
        "orange" to Color(0xFFFF9F00),
        "red" to Color(0xFFFF613D),
        "pink" to Color(0xFFFF4BDA),
        "purple" to Color(0xFFAF51F5),
        "toolbar" to Color(0xFF8F8F9D),
    )

/**
 * Страница обычных вкладок с переключателем пространств над ней. Пока пространство одно («Личное»),
 * переключателя нет и страница выглядит как раньше.
 */
@Composable
fun TaboraSpacesColumn(content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        TaboraSpacesRow()
        Box(modifier = Modifier.weight(1f)) { content() }
    }
}

/** Ряд пространств: нажатие переводит в пространство и показывает его вкладки. */
@Composable
fun TaboraSpacesRow() {
    val components = LocalContext.current.components
    val spaces = components.core.taboraSpaces
    val state by spaces.state.collectAsState()
    if (state.spaces.size < 2) {
        return
    }
    LazyRow(
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp),
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(state.spaces, key = { it.id }) { space ->
            SpaceChip(
                space = space,
                selected = space.id == state.currentId,
                onClick = {
                    spaces.select(space.id)
                    // в пространстве есть вкладки — выбирается последняя открытая; пусто — домашний экран
                    val last =
                        components.core.store.state
                            .getNormalOrPrivateTabs(private = false)
                            .filter { spaces.spaceOf(it).id == space.id }
                            .maxByOrNull { it.lastAccess }
                    if (last != null) {
                        components.core.store.dispatch(TabListAction.SelectTabAction(last.id))
                    } else {
                        components.core.taboraAccount.showHome()
                    }
                },
            )
        }
    }
}

@Composable
private fun SpaceChip(space: TaboraSpaces.Space, selected: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier =
            Modifier.heightIn(min = 40.dp)
                .clip(CircleShape)
                .background(if (selected) scheme.secondaryContainer else Color.Transparent)
                .border(1.dp, if (selected) Color.Transparent else scheme.outlineVariant, CircleShape)
                .clickable(role = Role.Tab, onClick = onClick)
                .semantics { this.selected = selected }
                .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(modifier = Modifier.size(10.dp).clip(CircleShape).background(SPACE_COLORS[space.color] ?: scheme.outline))
        Text(
            text = space.name,
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) scheme.onSecondaryContainer else scheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
