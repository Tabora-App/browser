/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import mozilla.components.browser.state.action.TabListAction
import mozilla.components.browser.state.selector.getNormalOrPrivateTabs
import org.mozilla.fenix.R
import org.mozilla.fenix.components.Components
import org.mozilla.fenix.ext.components

private fun colorOf(name: String): Color = Color(spaceColorArgb(name))

/** The page of normal tabs with the row of spaces above it. */
@Composable
fun TaboraSpacesColumn(content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        TaboraSpacesRow()
        Box(modifier = Modifier.weight(1f)) { content() }
    }
}

/**
 * The row of spaces. A tap moves to the space and shows its tabs; a long press on a space other
 * than "Personal" opens its menu (edit, move, delete); the last chip creates a space.
 */
@Composable
fun TaboraSpacesRow() {
    val components = LocalContext.current.components
    val spaces = components.core.taboraSpaces
    val state by spaces.state.collectAsState()
    var menuFor by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<TaboraSpaces.Space?>(null) }
    var deleting by remember { mutableStateOf<TaboraSpaces.Space?>(null) }
    // the chip of the current space is kept in view: it may be far to the right
    val listState = rememberLazyListState()
    val currentIndex = state.spaces.indexOfFirst { it.id == state.currentId }
    LaunchedEffect(currentIndex, state.spaces.size) {
        if (currentIndex >= 0) {
            listState.animateScrollToItem(currentIndex)
        }
    }

    LazyRow(
        state = listState,
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp),
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(state.spaces, key = { _, space -> space.id }) { index, space ->
            val own = space.id != TaboraSpaces.PERSONAL
            Box {
                SpaceChip(
                    space = space,
                    selected = space.id == state.currentId,
                    onClick = { switchTo(components, space) },
                    onLongClick = if (own) ({ menuFor = space.id }) else null,
                )
                DropdownMenu(expanded = menuFor == space.id, onDismissRequest = { menuFor = null }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.tabora_space_edit)) },
                        onClick = {
                            menuFor = null
                            editing = space
                        },
                    )
                    // index 0 is "Personal", which always stays first
                    if (index > 1) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.tabora_space_move_left)) },
                            onClick = {
                                menuFor = null
                                spaces.move(space.id, -1)
                            },
                        )
                    }
                    if (index < state.spaces.lastIndex) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.tabora_space_move_right)) },
                            onClick = {
                                menuFor = null
                                spaces.move(space.id, 1)
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.tabora_space_delete)) },
                        onClick = {
                            menuFor = null
                            deleting = space
                        },
                    )
                }
            }
        }
        item(key = "tabora-space-add") { AddChip(onClick = { creating = true }) }
    }

    if (creating) {
        SpaceEditor(
            space = null,
            onDismiss = { creating = false },
            onSave = { name, icon, color ->
                creating = false
                spaces.create(name, icon, color)?.let { switchTo(components, it) }
            },
        )
    }
    editing?.let { space ->
        SpaceEditor(
            space = space,
            onDismiss = { editing = null },
            onSave = { name, icon, color ->
                editing = null
                spaces.update(space.id, name, icon, color)
            },
        )
    }
    deleting?.let { space ->
        DeleteSpaceDialog(
            space = space,
            tabs = tabsOf(components, space).size,
            onDismiss = { deleting = null },
            onConfirm = {
                deleting = null
                deleteSpace(components, space)
            },
        )
    }
}

private fun tabsOf(components: Components, space: TaboraSpaces.Space) =
    components.core.store.state
        .getNormalOrPrivateTabs(private = false)
        .filter { components.core.taboraSpaces.spaceOf(it).id == space.id }

/** Move to a space: its most recently used tab is selected; an empty space shows the home screen. */
private fun switchTo(components: Components, space: TaboraSpaces.Space) {
    components.core.taboraSpaces.select(space.id)
    val last = tabsOf(components, space).maxByOrNull { it.lastAccess }
    if (last != null) {
        components.core.store.dispatch(TabListAction.SelectTabAction(last.id))
    } else {
        components.core.taboraAccount.showHome()
    }
}

/** Close the tabs of a space, delete it and erase the site data that was kept for it. */
private fun deleteSpace(components: Components, space: TaboraSpaces.Space) {
    val tabs = tabsOf(components, space).map { it.id }
    if (tabs.isNotEmpty()) {
        components.useCases.tabsUseCases.removeTabs(tabs)
    }
    components.core.taboraSpaces.delete(space.id)?.let { contextId ->
        components.core.geckoRuntime.storageController.clearDataForSessionContext(contextId)
    }
}

@Composable
private fun SpaceChip(space: TaboraSpaces.Space, selected: Boolean, onClick: () -> Unit, onLongClick: (() -> Unit)?) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier =
            Modifier.heightIn(min = 40.dp)
                .clip(CircleShape)
                .background(if (selected) scheme.secondaryContainer else Color.Transparent)
                .border(1.dp, if (selected) Color.Transparent else scheme.outlineVariant, CircleShape)
                .combinedClickable(role = Role.Tab, onClick = onClick, onLongClick = onLongClick)
                .semantics { this.selected = selected }
                .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            imageVector = spaceIcon(space.icon),
            contentDescription = null,
            tint = colorOf(space.color),
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = space.name,
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) scheme.onSecondaryContainer else scheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AddChip(onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val label = stringResource(R.string.tabora_space_add)
    Box(
        modifier =
            Modifier.size(40.dp)
                .clip(CircleShape)
                .border(1.dp, scheme.outlineVariant, CircleShape)
                .clickable(role = Role.Button, onClick = onClick)
                .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Text(text = "+", style = MaterialTheme.typography.titleMedium, color = scheme.onSurfaceVariant)
    }
}

/** Name, color and icon of a space: [space] is null for a new one. */
@Composable
private fun SpaceEditor(space: TaboraSpaces.Space?, onDismiss: () -> Unit, onSave: (String, String, String) -> Unit) {
    var name by remember { mutableStateOf(space?.name.orEmpty()) }
    var color by remember { mutableStateOf(space?.color ?: "blue") }
    var icon by remember { mutableStateOf(space?.icon ?: "circle") }
    val scheme = MaterialTheme.colorScheme
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (space == null) R.string.tabora_space_add else R.string.tabora_space_edit_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(NAME_LIMIT) },
                    label = { Text(stringResource(R.string.tabora_space_name)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    TaboraSpaces.COLORS.forEach { item ->
                        Box(
                            modifier =
                                Modifier.size(32.dp)
                                    .clip(CircleShape)
                                    .border(2.dp, if (item == color) scheme.onSurface else Color.Transparent, CircleShape)
                                    .padding(5.dp)
                                    .clip(CircleShape)
                                    .background(colorOf(item))
                                    .clickable(role = Role.RadioButton) { color = item }
                                    .semantics { selected = item == color },
                        )
                    }
                }
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    TaboraSpaces.ICONS.forEach { item ->
                        Box(
                            modifier =
                                Modifier.size(40.dp)
                                    .clip(CircleShape)
                                    .background(if (item == icon) scheme.secondaryContainer else Color.Transparent)
                                    .clickable(role = Role.RadioButton) { icon = item }
                                    .semantics { selected = item == icon },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = spaceIcon(item),
                                contentDescription = null,
                                tint = if (item == icon) colorOf(color) else scheme.onSurfaceVariant,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = { onSave(name, icon, color) }) {
                Text(stringResource(R.string.tabora_space_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.tabora_space_cancel)) } },
    )
}

@Composable
private fun DeleteSpaceDialog(space: TaboraSpaces.Space, tabs: Int, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val resources = LocalContext.current.resources
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.tabora_space_delete_title, space.name)) },
        text = {
            Text(
                if (tabs > 0) {
                    resources.getQuantityString(R.plurals.tabora_space_delete_tabs, tabs, tabs)
                } else {
                    stringResource(R.string.tabora_space_delete_text)
                }
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text(stringResource(R.string.tabora_space_delete)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.tabora_space_cancel)) } },
    )
}

private const val NAME_LIMIT = 60
