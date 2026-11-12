/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabora

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.navigation.findNavController
import java.lang.ref.WeakReference
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
import kotlinx.coroutines.withContext
import mozilla.appservices.places.BookmarkRoot
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.EngineSession
import mozilla.components.concept.engine.webextension.MessageHandler
import mozilla.components.concept.engine.webextension.Port
import mozilla.components.concept.engine.webextension.WebExtensionRuntime
import mozilla.components.concept.storage.BookmarkInfo
import mozilla.components.concept.storage.BookmarkNode
import mozilla.components.concept.storage.BookmarkNodeType
import mozilla.components.concept.storage.BookmarksStorage
import mozilla.components.concept.storage.LoginEntry
import mozilla.components.concept.storage.LoginsStorage
import mozilla.components.feature.qr.QrScanActivity
import mozilla.components.lib.dataprotect.SecureAbove22Preferences
import mozilla.components.lib.state.ext.flow
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.webextensions.BuiltInWebExtensionController
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.fenix.NavGraphDirections
import org.mozilla.fenix.R

/**
 * Аккаунт Tabora в приложении. Вход, ключи и синхронизация живут во встроенном модуле
 * (assets/extensions/tabora, собирается из web/src/phone): это тот же код, что у веб-версии и
 * браузера на компьютере. Здесь — его связь с приложением:
 *
 *  - вход и копия данных синхронизации хранятся у приложения, зашифрованные ключом из хранилища
 *    ключей Android;
 *  - модулю передаётся список открытых вкладок (без приватных);
 *  - от модуля приходит состояние: кто вошёл, вкладки других устройств аккаунта, сколько кодов входа;
 *  - по просьбе модуля приложение спрашивает у человека отпечаток, лицо или код блокировки (перед
 *    показом и вставкой кодов входа), открывает экраны модуля и сканер QR-кодов (вход по коду с
 *    другого устройства);
 *  - модуль читает и меняет хранилища паролей и закладок приложения, чтобы слить их с данными
 *    аккаунта.
 *
 * Сообщения описаны в web/src/phone/bridge.js.
 */
class TaboraAccount(
    private val context: Context,
    private val scope: CoroutineScope,
    private val logins: () -> LoginsStorage,
    private val bookmarks: () -> BookmarksStorage,
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
        val codesOn: Boolean = true,
        val codes: Int = 0,
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
    private var host: WeakReference<FragmentActivity>? = null
    private var lastAuthAt = 0L

    /** Состояние аккаунта для интерфейса приложения. */
    val state: StateFlow<State> = mutableState

    @Volatile private var baseUrl: String? = null

    /** Адрес экрана внутри модуля; null, пока модуль не установлен. */
    fun pageUrl(page: String): String? =
        baseUrl?.let { base ->
            when (page) {
                PAGE_CODES -> "${base}codes.html"
                PAGE_MAIL -> "${base}mail.html"
                else -> "${base}index.html"
            }
        }

    /** Установить модуль в движок и начать передавать ему вкладки. Вызывается один раз при запуске. */
    fun install(runtime: WebExtensionRuntime, store: BrowserStore) {
        controller.registerBackgroundMessageHandler(handler)
        controller.install(
            runtime,
            onSuccess = { extension -> baseUrl = extension.getMetadata()?.baseUrl },
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

    /** Экран приложения, поверх которого показываются запрос отпечатка и экраны модуля. */
    fun attach(activity: FragmentActivity) {
        host = WeakReference(activity)
        // человек вернулся в приложение: сверить сейчас (в том числе пароли, сохранённые с прошлого раза)
        syncNow()
    }

    /** Экран закрыт: запросы к нему больше не идут. */
    fun detach(activity: FragmentActivity) {
        if (host?.get() === activity) {
            host = null
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
                when (json.optString("type")) {
                    "state" -> {
                        val next = json.toState()
                        val previous = mutableState.value
                        mutableState.value = next
                        if (next.signedIn != previous.signedIn || next.email != previous.email) {
                            meta.edit().putBoolean(KEY_SIGNED_IN, next.signedIn).putString(KEY_EMAIL, next.email).apply()
                        }
                    }
                    "auth" -> {
                        val rid = json.optInt("rid")
                        authenticate { ok -> port.postMessage(JSONObject().put("type", "reply").put("rid", rid).put("ok", ok)) }
                    }
                    "open" -> openPage(json.optString("page"))
                    "qr-scan" -> {
                        val rid = json.optInt("rid")
                        scanQr { text, denied ->
                            port.postMessage(
                                JSONObject().put("type", "reply").put("rid", rid).put("text", text ?: "").put("denied", denied)
                            )
                        }
                    }
                    "logins-list", "logins-add", "logins-update", "logins-delete" -> {
                        val rid = json.optInt("rid")
                        scope.launch(Dispatchers.Main) {
                            val reply =
                                runCatching { withContext(Dispatchers.IO) { loginsRequest(json) } }
                                    .getOrElse { JSONObject().put("error", it.message ?: it.javaClass.simpleName) }
                            port.postMessage(reply.put("type", "reply").put("rid", rid))
                        }
                    }
                    "marks-tree", "marks-add", "marks-update", "marks-order", "marks-delete" -> {
                        val rid = json.optInt("rid")
                        scope.launch(Dispatchers.Main) {
                            val reply =
                                runCatching { withContext(Dispatchers.IO) { marksRequest(json) } }
                                    .getOrElse { JSONObject().put("error", it.message ?: it.javaClass.simpleName) }
                            port.postMessage(reply.put("type", "reply").put("rid", rid))
                        }
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
                        "data-load" -> JSONObject().put("value", dataKey(json)?.let { secure.getString(it) } ?: JSONObject.NULL)
                        "data-save" -> {
                            val key = dataKey(json)
                            key?.let { secure.putString(it, json.optString("value")) }
                            JSONObject().put("ok", key != null)
                        }
                        "data-clear" -> {
                            dataKey(json)?.let { secure.remove(it) }
                            JSONObject().put("ok", true)
                        }
                        else -> JSONObject()
                    }
                return reply.toString()
            }
        }

    /** Просьба модуля к хранилищу паролей приложения: список, добавление, правка, удаление. */
    private suspend fun loginsRequest(json: JSONObject): JSONObject {
        val storage = logins()
        return when (json.optString("type")) {
            "logins-list" -> {
                val list = JSONArray()
                storage.list().forEach { login ->
                    list.put(
                        JSONObject()
                            .put("guid", login.guid)
                            .put("origin", login.origin)
                            .put("formActionOrigin", login.formActionOrigin ?: JSONObject.NULL)
                            .put("httpRealm", login.httpRealm ?: JSONObject.NULL)
                            .put("username", login.username)
                            .put("password", login.password)
                            .put("usernameField", login.usernameField)
                            .put("passwordField", login.passwordField)
                            .put("created", login.timeCreated)
                            .put("changed", login.timePasswordChanged)
                    )
                }
                JSONObject().put("logins", list)
            }
            "logins-add" -> JSONObject().put("ok", true).put("guid", storage.add(json.getJSONObject("entry").toLoginEntry()).guid)
            "logins-update" -> {
                storage.update(json.getString("guid"), json.getJSONObject("entry").toLoginEntry())
                JSONObject().put("ok", true)
            }
            "logins-delete" -> JSONObject().put("ok", storage.delete(json.getString("guid")))
            else -> JSONObject()
        }
    }

    private fun JSONObject.toLoginEntry(): LoginEntry {
        fun text(key: String): String? = if (isNull(key)) null else getString(key)
        return LoginEntry(
            origin = getString("origin"),
            formActionOrigin = text("formActionOrigin"),
            httpRealm = text("httpRealm"),
            usernameField = optString("usernameField"),
            passwordField = optString("passwordField"),
            username = optString("username"),
            password = getString("password"),
        )
    }

    /** Имя записи с копией данных в защищённом хранилище; чужие имена не принимаются. */
    private fun dataKey(json: JSONObject): String? =
        json.optString("name").takeIf { DATA_NAME.matches(it) }?.let { "data_$it" }

    /**
     * Просьба модуля к хранилищу закладок приложения: дерево четырёх корней, добавление, правка,
     * порядок детей папки, удаление. Номер новой закладке даёт хранилище; модуль ведёт таблицу
     * соответствия номерам записей аккаунта.
     */
    private suspend fun marksRequest(json: JSONObject): JSONObject {
        val storage = bookmarks()
        return when (json.optString("type")) {
            "marks-tree" -> {
                val nodes = JSONArray()
                MARK_ROOTS.forEach { root ->
                    storage.getTree(root, recursive = true).getOrThrow()?.let { putMark(nodes, it, null) }
                }
                JSONObject().put("nodes", nodes)
            }
            "marks-add" -> {
                val parent = json.getString("parent")
                val guid =
                    when (json.getInt("kind")) {
                        MARK_ITEM -> storage.addItem(parent, json.getString("url"), json.optString("title"), null)
                        MARK_FOLDER -> storage.addFolder(parent, json.optString("title"), null)
                        else -> storage.addSeparator(parent, null)
                    }.getOrThrow()
                JSONObject().put("ok", true).put("guid", guid)
            }
            "marks-update" -> {
                val info =
                    BookmarkInfo(
                        parentGuid = json.textOrNull("parent"),
                        position = null,
                        title = json.textOrNull("title"),
                        url = json.textOrNull("url"),
                    )
                storage.updateNode(json.getString("guid"), info).getOrThrow()
                JSONObject().put("ok", true)
            }
            "marks-order" -> {
                val order = json.getJSONArray("order")
                for (i in 0 until order.length()) {
                    storage.updateNode(order.getString(i), BookmarkInfo(null, i.toUInt(), null, null)).getOrThrow()
                }
                JSONObject().put("ok", true)
            }
            "marks-delete" -> {
                storage.deleteNode(json.getString("guid")).getOrThrow()
                JSONObject().put("ok", true)
            }
            else -> JSONObject()
        }
    }

    private fun putMark(nodes: JSONArray, node: BookmarkNode, parent: String?) {
        val kind =
            when (node.type) {
                BookmarkNodeType.ITEM -> MARK_ITEM
                BookmarkNodeType.FOLDER -> MARK_FOLDER
                BookmarkNodeType.SEPARATOR -> MARK_SEPARATOR
            }
        val item =
            JSONObject()
                .put("g", node.guid)
                .put("p", parent ?: JSONObject.NULL)
                .put("k", kind)
                .put("n", node.title ?: "")
                .put("c", node.dateAdded)
                .put("t", node.lastModified)
        if (kind == MARK_ITEM) {
            item.put("u", node.url ?: "")
        }
        if (kind == MARK_FOLDER) {
            val children = JSONArray()
            node.children?.forEach { children.put(it.guid) }
            item.put("ch", children)
        }
        nodes.put(item)
        node.children?.forEach { putMark(nodes, it, node.guid) }
    }

    private fun JSONObject.textOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null

    /**
     * Подтверждение, что телефон в руках владельца: отпечаток, лицо или код блокировки. Недавнее
     * подтверждение помнится несколько минут. Если блокировки экрана на телефоне нет вовсе,
     * подтверждать нечем — как и в сохранённых паролях приложения, доступ открыт.
     */
    private fun authenticate(onResult: (Boolean) -> Unit) {
        val now = SystemClock.elapsedRealtime()
        if (lastAuthAt != 0L && now - lastAuthAt < AUTH_GRACE_MS) {
            onResult(true)
            return
        }
        val activity = host?.get()
        if (activity == null || activity.isFinishing || !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            onResult(false)
            return
        }
        if (activity.getSystemService(KeyguardManager::class.java)?.isDeviceSecure != true) {
            lastAuthAt = now
            onResult(true)
            return
        }
        val authenticators =
            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        if (BiometricManager.from(activity).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            onResult(false)
            return
        }
        var answered = false
        val callback =
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (!answered) {
                        answered = true
                        lastAuthAt = SystemClock.elapsedRealtime()
                        onResult(true)
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (!answered) {
                        answered = true
                        onResult(false)
                    }
                }
            }
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
            .authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle(activity.getString(R.string.tabora_codes_auth_title))
                    .setSubtitle(activity.getString(R.string.tabora_codes_auth_text))
                    .setAllowedAuthenticators(authenticators)
                    .build()
            )
    }

    /**
     * Сканер QR-кодов: вход по коду, который показывает другое устройство аккаунта. Отдаёт считанный
     * текст (null — сканер закрыли); denied — человек не дал приложению доступ к камере. Что делать
     * с текстом, решает модуль: приложение его не разбирает.
     */
    private fun scanQr(onResult: (text: String?, denied: Boolean) -> Unit) {
        val activity = host?.get()
        if (activity == null || activity.isFinishing || !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            onResult(null, false)
            return
        }
        val registry = activity.activityResultRegistry
        val id = SystemClock.elapsedRealtimeNanos()
        val scan = {
            var launcher: ActivityResultLauncher<Intent>? = null
            val opened =
                registry.register("tabora-qr-scan-$id", ActivityResultContracts.StartActivityForResult()) { result ->
                    launcher?.unregister()
                    val text =
                        if (result.resultCode == Activity.RESULT_OK) {
                            result.data?.getStringExtra(QrScanActivity.EXTRA_SCAN_RESULT_DATA)
                        } else {
                            null
                        }
                    onResult(text, false)
                }
            launcher = opened
            runCatching { opened.launch(QrScanActivity.newIntent(activity, R.string.tabora_pair_scan_hint)) }
                .onFailure {
                    logger.error("сканер QR-кодов не открыт", it)
                    opened.unregister()
                    onResult(null, false)
                }
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            scan()
            return
        }
        var asking: ActivityResultLauncher<String>? = null
        val ask =
            registry.register("tabora-qr-camera-$id", ActivityResultContracts.RequestPermission()) { granted ->
                asking?.unregister()
                if (granted) {
                    scan()
                } else {
                    onResult(null, true)
                }
            }
        asking = ask
        ask.launch(Manifest.permission.CAMERA)
    }

    /** Открыть экран модуля: «Аккаунт Tabora», «Коды входа» или «Почта». */
    fun openPage(page: String) {
        val activity = host?.get() ?: return
        if (page != PAGE_ACCOUNT && page != PAGE_CODES && page != PAGE_MAIL) {
            return
        }
        runCatching {
            activity.findNavController(R.id.container).navigate(NavGraphDirections.actionGlobalTaboraAccountFragment(page))
        }.onFailure { logger.error("экран модуля не открыт", it) }
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
            codesOn = optBoolean("codesOn", true),
            codes = optInt("codes", 0).coerceIn(0, MAX_CODES),
            status = optString("status", "idle"),
            devices = devices,
        )
    }

    private fun String.isWebUrl() =
        length <= MAX_URL && (startsWith("https://", ignoreCase = true) || startsWith("http://", ignoreCase = true))

    companion object {
        /** Экран «Аккаунт Tabora». */
        const val PAGE_ACCOUNT = "account"

        /** Экран «Коды входа». */
        const val PAGE_CODES = "codes"

        /** Экран «Почта». */
        const val PAGE_MAIL = "mail"

        /** Адрес ярлыка почты на домашнем экране: вместо веб-почты он открывает почту в приложении. */
        const val MAIL_SHORTCUT_URL = "https://app.tabora.app"
        private val DATA_NAME = Regex("^[a-z]{1,16}$")
        private const val MARK_ITEM = 1
        private const val MARK_FOLDER = 2
        private const val MARK_SEPARATOR = 3

        /** Корни закладок, общие для телефона и компьютера: меню, панель, «Другие», телефон. */
        private val MARK_ROOTS =
            listOf(BookmarkRoot.Menu.id, BookmarkRoot.Toolbar.id, BookmarkRoot.Unfiled.id, BookmarkRoot.Mobile.id)
        private const val AUTH_GRACE_MS = 5 * 60 * 1000L
        private const val MAX_CODES = 5000
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
