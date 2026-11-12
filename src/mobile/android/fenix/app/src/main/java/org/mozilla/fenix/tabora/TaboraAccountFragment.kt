/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.navigation.fragment.findNavController
import org.mozilla.fenix.R
import org.mozilla.fenix.addons.AddonPopupBaseFragment
import org.mozilla.fenix.databinding.FragmentAddOnInternalSettingsBinding
import org.mozilla.fenix.e2e.SystemInsetsPaddedFragment
import org.mozilla.fenix.ext.requireComponents
import org.mozilla.fenix.ext.showToolbar

/**
 * Экран «Аккаунт Tabora»: вход и настройки синхронизации. Содержимое рисует встроенный модуль
 * аккаунта (страница index.html), приложение даёт ему место под своим заголовком — так же, как
 * страницам настроек расширений.
 */
class TaboraAccountFragment : AddonPopupBaseFragment(), SystemInsetsPaddedFragment {

    private var _binding: FragmentAddOnInternalSettingsBinding? = null
    private val binding
        get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View? {
        initializeSession()
        return inflater.inflate(R.layout.fragment_add_on_internal_settings, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        _binding = FragmentAddOnInternalSettingsBinding.bind(view)
        val url = requireComponents.core.taboraAccount.pageUrl
        val pageSession = engineSession
        if (url == null || pageSession == null) {
            findNavController().navigateUp()
            return
        }
        binding.addonSettingsEngineView.render(pageSession)
        pageSession.loadUrl(url)
    }

    override fun provideDynamicSnackbarContainer(): ConstraintLayout = binding.dynamicSnackbarContainer

    override fun onResume() {
        super.onResume()
        showToolbar(getString(R.string.tabora_account_title))
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
