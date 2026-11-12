/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.security.SecureRandom
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.EngineSession
import mozilla.components.concept.engine.webextension.MessageHandler
import mozilla.components.concept.engine.webextension.Port
import mozilla.components.concept.engine.webextension.WebExtensionRuntime
import mozilla.components.lib.dataprotect.SecureAbove22Preferences
import mozilla.components.lib.state.ext.flow
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.webextensions.BuiltInWebExtensionController
import org.json.JSONArray
import org.json.JSONObject

/**
 * Аккаунт Tabora в приложении. Вход, ключи и синхронизация живут во встроенном модуле
 * (assets/extensions/tabora, собирается из web/src/phone): это тот же код, что у веб-версии и
 * браузера на компьютере. Здесь — его связь с приложением:
 *
 *  - вход хранится у приложения, зашифрованный ключом из хранилища ключей Android;
 *  - модулю передаётся список открытых вкладок (без приватных);
 *  - от модуля приходит состояние: кто вошёл и вкладки других устройств аккаунта.
 *
 * Сообщения описаны в web/src/phone/bridge.js.
 */
class TaboraAccount(
    private val context: Context,
    private val scope: CoroutineScope,
) {
    /** Вкладка другого устройства. */
    data class Tab(val title: String, val url: String)

    /** Устройство аккаунта и его открытые вкладки. */
    data class Device(val id: String, val name: String, val tabs: List<Tab>)

    /** То, что модуль сообщил о себе в последний раз. */
    data class State(
        val signedIn: Boolean = false,
        val email: String = "",
        val tabsOn: Boolean = true,
        val status: String = "idle",
        val devices: List<Device> = emptyList(),
    )

    private val logger = Logger("TaboraAccount")
    private val controller = BuiltInWebExtensionController(EXTENSION_ID, EXTENSION_URL, PORT)
    private val secure by lazy { SecureAbove22Preferences(context, SECURE_PREFS) }
    private val meta by lazy { context.getSharedPreferences(META_PREFS, Context.MODE_PRIVATE) }
    // До первого сообщения модуля (он запускается секунду-другую) известно то, что было в прошлый
    // раз: вошедшему человеку список вкладок не должен предлагать войти.
    private val mutableState =
        MutableStateFlow(State(signedIn = meta.getBoolean(KEY_SIGNED_IN, false), email = meta.getString(KEY_EMAIL, "").orEmpty()))
    private var localTabs: List<Tab> = emptyList()

    /** Состояние аккаунта для интерфейса приложения. */
    val state: StateFlow<State> = mutableState

    /** Адрес экрана «Аккаунт Tabora» внутри модуля; null, пока модуль не установлен. */
    @Volatile
    var pageUrl: String? = null
        private set

    /** Установить модуль в движок и начать передавать ему вкладки. Вызывается один раз при запуске. */
    fun install(runtime: WebExtensionRuntime, store: BrowserStore) {
        controller.registerBackgroundMessageHandler(handler)
        controller.install(
            runtime,
            onSuccess = { extension ->
                pageUrl = extension.getMetadata()?.baseUrl?.let { "${it}index.html" }
            },
            onError = { logger.error("модуль аккаунта не установлен", it) },
        )
        scope.launch(Dispatchers.Main) {
            store.flow()
                .map { browser ->
                    browser.tabs.asSequence()
                        .filter { !it.content.private && it.content.url.isWebUrl() }
                        .take(MAX_TABS)
                        .map { Tab(it.content.title.take(MAX_TITLE), it.content.url) }
                        .toList()
                }
                .distinctUntilChanged()
                // страница грузится — адрес и заголовок меняются несколько раз подряд: ждём, пока успокоится
                .collectLatest { tabs ->
                    delay(TABS_QUIET_MS)
                    localTabs = tabs
                    sendTabs()
                }
        }
    }

    /** Попросить модуль свериться с сервером сейчас (открыли вкладки других устройств). */
    fun syncNow() {
        if (state.value.signedIn && controller.portConnected(null)) {
            controller.sendBackgroundMessage(JSONObject().put("type", "sync"))
        }
    }

    private fun sendTabs() {
        if (!controller.portConnected(null)) {
            return // модуль ещё запускается: список уйдёт, когда он откроет канал
        }
        val list = JSONArray()
        localTabs.forEach { list.put(JSONObject().put("t", it.title).put("u", it.url)) }
        controller.sendBackgroundMessage(JSONObject().put("type", "tabs").put("tabs", list))
    }

    private val handler =
        object : MessageHandler {
            override fun onPortConnected(port: Port) {
                logger.info("модуль аккаунта подключился")
                sendTabs()
            }

            override fun onPortMessage(message: Any, port: Port) {
                val json = message as? JSONObject ?: return
                if (json.optString("type") == "state") {
                    val next = json.toState()
                    val previous = mutableState.value
                    mutableState.value = next
                    if (next.signedIn != previous.signedIn || next.email != previous.email) {
                        meta.edit().putBoolean(KEY_SIGNED_IN, next.signedIn).putString(KEY_EMAIL, next.email).apply()
                    }
                }
            }

            // Ответ уходит строкой JSON: движок принимает в ответ на запрос только простые значения.
            override fun onMessage(message: Any, source: EngineSession?): Any {
                val json = message as? JSONObject ?: return "{}"
                val reply =
                    when (json.optString("type")) {
                        "store-load" ->
                            JSONObject()
                                .put("deviceId", deviceId())
                                .put("deviceName", deviceName())
                                .put("session", secure.getString(KEY_SESSION) ?: JSONObject.NULL)
                        "store-save" -> {
                            secure.putString(KEY_SESSION, json.optString("session"))
                            JSONObject().put("ok", true)
                        }
                        "store-clear" -> {
                            secure.remove(KEY_SESSION)
                            JSONObject().put("ok", true)
                        }
                        else -> JSONObject()
                    }
                return reply.toString()
            }
        }

    /** Номер телефона для сервера: случайный, постоянный, без сведений об устройстве. */
    private fun deviceId(): String {
        meta.getString(KEY_DEVICE, null)?.let {
            return it
        }
        val random = SecureRandom()
        val id = "and-" + (1..DEVICE_ID_LENGTH).map { ID_ALPHABET[random.nextInt(ID_ALPHABET.length)] }.joinToString("")
        meta.edit().putString(KEY_DEVICE, id).apply()
        return id
    }

    /** Имя телефона, как его назвал владелец в настройках системы; иначе — производитель и модель. */
    private fun deviceName(): String {
        val named =
            runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        val model = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".trim()
        return (named?.trim().takeUnless { it.isNullOrEmpty() } ?: model).take(MAX_DEVICE_NAME)
    }

    private fun JSONObject.toState(): State {
        val devices = mutableListOf<Device>()
        val list = optJSONArray("devices") ?: JSONArray()
        for (i in 0 until minOf(list.length(), MAX_DEVICES)) {
            val device = list.optJSONObject(i) ?: continue
            val tabs = mutableListOf<Tab>()
            val items = device.optJSONArray("tabs") ?: JSONArray()
            for (j in 0 until minOf(items.length(), MAX_TABS)) {
                val tab = items.optJSONObject(j) ?: continue
                val url = tab.optString("u")
                // список пришёл с сервера: открывать разрешаем только обычные адреса сайтов
                if (url.isWebUrl()) {
                    tabs += Tab(tab.optString("t").take(MAX_TITLE), url)
                }
            }
            if (tabs.isNotEmpty()) {
                devices += Device(device.optString("id"), device.optString("name").take(MAX_DEVICE_NAME), tabs)
            }
        }
        return State(
            signedIn = optBoolean("signedIn"),
            email = optString("email"),
            tabsOn = optBoolean("tabsOn", true),
            status = optString("status", "idle"),
            devices = devices,
        )
    }

    private fun String.isWebUrl() =
        length <= MAX_URL && (startsWith("https://", ignoreCase = true) || startsWith("http://", ignoreCase = true))

    companion object {
        private const val EXTENSION_ID = "account@tabora.app"
        private const val EXTENSION_URL = "resource://android/assets/extensions/tabora/"
        private const val PORT = "tabora"
        private const val SECURE_PREFS = "tabora_account"
        private const val META_PREFS = "tabora_account_meta"
        private const val KEY_SESSION = "session"
        private const val KEY_DEVICE = "device_id"
        private const val KEY_SIGNED_IN = "signed_in"
        private const val KEY_EMAIL = "email"
        private const val ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        private const val DEVICE_ID_LENGTH = 18
        private const val MAX_TABS = 200
        private const val MAX_DEVICES = 30
        private const val MAX_TITLE = 200
        private const val MAX_URL = 2048
        private const val MAX_DEVICE_NAME = 64
        private const val TABS_QUIET_MS = 1500L
    }
}
