/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.content.Context
import android.content.res.Resources
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import androidx.core.graphics.PathParser
import mozilla.components.browser.state.state.SessionState
import mozilla.components.compose.browser.toolbar.concept.Action
import mozilla.components.compose.browser.toolbar.store.BrowserToolbarInteraction
import mozilla.components.concept.engine.HitResult
import mozilla.components.feature.contextmenu.ContextMenuCandidate
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.components

/** The icon of a space in its color, as a drawable for the address bar. */
private class SpaceBadgeDrawable(icon: String, color: Long) : Drawable() {
    private val outline: Path =
        spaceIconPath(icon).let { shape ->
            PathParser.createPathFromPathData(shape.data).apply {
                fillType = if (shape.evenOdd) Path.FillType.EVEN_ODD else Path.FillType.WINDING
            }
        }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color.toInt() }
    private val side = (BADGE_DP * Resources.getSystem().displayMetrics.density).toInt()

    override fun draw(canvas: Canvas) {
        // the outline fills two thirds of the button, like the other icons of the address bar
        val size = minOf(bounds.width(), bounds.height()) * ICON_SHARE
        val scale = size / SPACE_ICON_BOX
        canvas.save()
        canvas.translate(bounds.exactCenterX() - size / 2, bounds.exactCenterY() - size / 2)
        canvas.scale(scale, scale)
        canvas.drawPath(outline, paint)
        canvas.restore()
    }

    override fun getIntrinsicWidth(): Int = side

    override fun getIntrinsicHeight(): Int = side

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
    }

    // The address bar tints every icon with its own color. The badge keeps the color of the space:
    // that color is the point of it.
    override fun setColorFilter(colorFilter: ColorFilter?) = Unit

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

    private companion object {
        const val BADGE_DP = 24
        const val ICON_SHARE = 0.75f
    }
}

/**
 * The badge of the current space for the address bar: its icon in its color. "Personal" has no
 * badge, so a phone without spaces looks as before. [onClick] opens the tab manager, where spaces
 * are switched.
 */
fun spaceBadgeActions(context: Context, onClick: BrowserToolbarInteraction): List<Action> {
    val space = TaboraSpaces.current()?.takeIf { it.id != TaboraSpaces.PERSONAL } ?: return emptyList()
    return listOf(
        Action.ActionButton(
            drawable = SpaceBadgeDrawable(space.icon, spaceColorArgb(space.color)),
            shouldTint = false,
            contentDescription = context.getString(R.string.tabora_space_badge, space.name),
            onClick = onClick,
        )
    )
}

/**
 * Items of the link menu: "Open in the space ..." for every space other than the one the tab is
 * in. The link opens in a new tab of that space, and the person moves there.
 */
fun spaceContextMenuCandidates(context: Context): List<ContextMenuCandidate> {
    val components = context.components
    val spaces = components.core.taboraSpaces
    val link = { hit: HitResult ->
        when (hit) {
            is HitResult.UNKNOWN -> hit.src
            is HitResult.IMAGE_SRC -> hit.uri
            else -> ""
        }
    }
    return spaces.state.value.spaces.map { space ->
        ContextMenuCandidate(
            id = "tabora.space.${space.id}",
            label = context.getString(R.string.tabora_space_open_link, space.name),
            showFor = { tab: SessionState, hit: HitResult ->
                !tab.content.private &&
                    link(hit).startsWith("http") &&
                    spaces.state.value.spaces.any { it.id == space.id } &&
                    spaces.spaceOfContext(tab.contextId).id != space.id
            },
            action = { _: SessionState, hit: HitResult ->
                // a new tab without a parent opens in the current space: move there first
                spaces.select(space.id)
                components.useCases.tabsUseCases.addTab(url = link(hit), selectTab = true)
            },
        )
    }
}
