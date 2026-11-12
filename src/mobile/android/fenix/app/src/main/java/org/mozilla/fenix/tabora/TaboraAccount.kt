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
import android.util.Base64
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.navigation.findNavController
import java.io.File
import java.lang.ref.WeakReference
import java.security.SecureRandom
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CompletableDeferred
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
import kotlinx.coroutines.withTimeoutOrNull
import mozilla.appservices.places.BookmarkRoot
import mozilla.components.browser.state.selector.selectedTab
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.EngineSession
import mozilla.components.concept.engine.webextension.MessageHandler
import mozilla.components.concept.engine.webextension.Port
import mozilla.components.concept.engine.webextension.WebExtensionRuntime
import mozilla.components.concept.storage.BookmarkInfo
import mozilla.components.concept.storage.BookmarkNode
import mozilla.components.concept.storage.BookmarkNodeType
import mozilla.components.concept.storage.BookmarksStorage
import mozilla.components.concept.storage.CreditCardNumber
import mozilla.components.concept.storage.CreditCardsAddressesStorage
import mozilla.components.concept.storage.HistoryStorage
import mozilla.components.concept.storage.LoginEntry
import mozilla.components.concept.storage.LoginsStorage
import mozilla.components.concept.storage.NewCreditCardFields
import mozilla.components.concept.storage.UpdatableAddressFields
import mozilla.components.concept.storage.UpdatableCreditCardFields
import mozilla.components.concept.storage.VisitType
import mozilla.components.concept.sync.Device as SyncDevice
import mozilla.components.concept.sync.DeviceCapability
import mozilla.components.concept.sync.DeviceType
import mozilla.components.feature.qr.QrScanActivity
import mozilla.components.lib.dataprotect.Keystore
import mozilla.components.lib.dataprotect.SecureAbove22Preferences
import mozilla.components.lib.state.ext.flow
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.utils.creditCardIIN
import mozilla.components.support.webextensions.BuiltInWebExtensionController
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.fenix.NavGraphDirections
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.components

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
 *    аккаунта, и приносит из аккаунта список пространств ([TaboraSpaces]).
 *
 * Сообщения описаны в web/src/phone/bridge.js.
 */
class TaboraAccount(
    private val context: Context,
    private val scope: CoroutineScope,
    private val logins: () -> LoginsStorage,
    private val bookmarks: () -> BookmarksStorage,
    private val spaces: () -> TaboraSpaces,
    private val history: () -> HistoryStorage,
    private val autofill: () -> CreditCardsAddressesStorage,
) {
    /** Вкладка другого устройства. */
    data class Tab(val title: String, val url: String)

    /** Устройство аккаунта и его открытые вкладки. */
    data class Device(val id: String, val name: String, val tabs: List<Tab>)

    /** A device of the account a page can be sent to ("Share" → "Send to device"). */
    data class Target(val id: String, val name: String)

    /** То, что модуль сообщил о себе в последний раз. */
    data class State(
        val signedIn: Boolean = false,
        val email: String = "",
        val tabsOn: Boolean = true,
        val codesOn: Boolean = true,
        val codes: Int = 0,
        val status: String = "idle",
        val devices: List<Device> = emptyList(),
        val targets: List<Target> = emptyList(),
        val historyOn: Boolean = false,
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
    private var browserStore: BrowserStore? = null
    private var host: WeakReference<FragmentActivity>? = null
    private var lastAuthAt = 0L
    private val sends = ConcurrentHashMap<Int, CompletableDeferred<Boolean>>()
    private val sendSeq = AtomicInteger(0)

    /** Состояние аккаунта для интерфейса приложения. */
    val state: StateFlow<State> = mutableState

    @Volatile private var baseUrl: String? = null

    /** Адрес экрана внутри модуля; null, пока модуль не установлен. */
    fun pageUrl(page: String): String? =
        baseUrl?.let { base ->
            when (page) {
                PAGE_CODES -> "${base}codes.html"
                PAGE_HISTORY -> "${base}history.html"
                PAGE_MAIL -> "${base}mail.html"
                else -> "${base}index.html"
            }
        }

    /** Установить модуль в движок и начать передавать ему вкладки. Вызывается один раз при запуске. */
    fun install(runtime: WebExtensionRuntime, store: BrowserStore) {
        browserStore = store
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

    /**
     * The devices a page can be sent to, in the form the engine's share screens draw. Empty
     * without a sign-in. A phone's ID starts with its platform, a computer's does not.
     */
    fun sendDevices(): List<SyncDevice> =
        state.value.targets.map {
            val phone = it.id.startsWith("and-") || it.id.startsWith("ios-")
            SyncDevice(
                id = it.id,
                displayName = it.name,
                deviceType = if (phone) DeviceType.MOBILE else DeviceType.DESKTOP,
                isCurrentDevice = false,
                lastAccessTime = null,
                capabilities = listOf(DeviceCapability.SEND_TAB),
                subscriptionExpired = false,
                subscription = null,
            )
        }

    /**
     * Send pages to other devices of the account: each opens there on that device's next sync.
     * True once the pages are on the server; false when there is no connection (nothing is kept
     * for later then) or tab sync is turned off.
     */
    suspend fun sendTabs(to: List<String>, pages: List<Tab>): Boolean {
        val sites = pages.filter { it.url.isWebUrl() }
        if (!state.value.signedIn || to.isEmpty() || sites.isEmpty()) {
            return false
        }
        val rid = sendSeq.incrementAndGet()
        val done = CompletableDeferred<Boolean>()
        sends[rid] = done
        return try {
            val asked =
                withContext(Dispatchers.Main) {
                    if (!controller.portConnected(null)) {
                        false
                    } else {
                        val list = JSONArray()
                        sites.forEach { list.put(JSONObject().put("url", it.url).put("title", it.title.take(MAX_TITLE))) }
                        controller.sendBackgroundMessage(
                            JSONObject().put("type", "send-tab").put("rid", rid).put("to", JSONArray(to)).put("pages", list)
                        )
                        true
                    }
                }
            asked && (withTimeoutOrNull(SEND_TIMEOUT_MS) { done.await() } ?: false)
        } finally {
            sends.remove(rid)
        }
    }

    /**
     * A page another device of the account sent to this phone: a new tab in the current space.
     * It becomes the selected one unless a private tab is open now. False if it cannot be opened
     * (the module offers it again on the next sync).
     */
    private fun openSent(url: String, from: String): Boolean {
        if (!url.isWebUrl()) {
            return false
        }
        val private = browserStore?.state?.selectedTab?.content?.private == true
        return runCatching {
            context.components.useCases.tabsUseCases.addTab(url = url, selectTab = !private)
            val text =
                if (from.isNotEmpty()) {
                    context.getString(R.string.tabora_sent_tab_opened, from)
                } else {
                    context.getString(R.string.tabora_sent_tab_opened_unnamed)
                }
            Toast.makeText(context, text, Toast.LENGTH_LONG).show()
        }.onFailure { logger.error("sent tab is not opened", it) }.isSuccess
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
                    "open-url" -> openUrl(json.optString("url"))
                    "sent-open" -> {
                        val ok = openSent(json.optString("url"), json.optString("from").trim().take(MAX_DEVICE_NAME))
                        port.postMessage(JSONObject().put("type", "reply").put("rid", json.optInt("rid")).put("ok", ok))
                    }
                    "sent-result" -> sends[json.optInt("rid")]?.complete(json.optBoolean("ok"))
                    "addresses-list", "addresses-add", "addresses-update", "addresses-delete",
                    "cards-list", "cards-add", "cards-update", "cards-delete",
                    -> {
                        val rid = json.optInt("rid")
                        scope.launch(Dispatchers.Main) {
                            val reply =
                                runCatching { withContext(Dispatchers.IO) { autofillRequest(json) } }
                                    .getOrElse { JSONObject().put("error", it.message ?: it.javaClass.simpleName) }
                            port.postMessage(reply.put("type", "reply").put("rid", rid))
                        }
                    }
                    "history-list" -> {
                        val rid = json.optInt("rid")
                        scope.launch(Dispatchers.Main) {
                            val reply =
                                runCatching { withContext(Dispatchers.IO) { historyRequest(json) } }
                                    .getOrElse { JSONObject().put("error", it.message ?: it.javaClass.simpleName) }
                            port.postMessage(reply.put("type", "reply").put("rid", rid))
                        }
                    }
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
                    "spaces-list" ->
                        port.postMessage(
                            JSONObject().put("type", "reply").put("rid", json.optInt("rid")).put("spaces", spaces().list())
                        )
                    "spaces-apply" -> {
                        // пространство с открытыми вкладками не удаляется: вкладки остались бы без него
                        val open = browserStore?.state?.tabs?.mapNotNull { it.contextId }?.toSet().orEmpty()
                        spaces().apply(json.optJSONArray("changes") ?: JSONArray()) { it in open }
                        port.postMessage(
                            JSONObject().put("type", "reply").put("rid", json.optInt("rid")).put("ok", true).put("spaces", spaces().list())
                        )
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
                        "data-load" -> JSONObject().put("value", dataName(json)?.let { dataLoad(it) } ?: JSONObject.NULL)
                        "data-save" -> {
                            val name = dataName(json)
                            name?.let { dataSave(it, json.optString("value")) }
                            JSONObject().put("ok", name != null)
                        }
                        "data-clear" -> {
                            dataName(json)?.let { dataClear(it) }
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
    private fun dataName(json: JSONObject): String? = json.optString("name").takeIf { DATA_NAME.matches(it) }

    /*
     * The module's data kept by the app (the copy of sync data, the states of merges): a file per
     * name, encrypted. The copy of sync data takes megabytes once it holds the history of other
     * devices; preferences are one file rewritten whole on every change, so it does not belong
     * there. The files are encrypted with a random key that itself is kept encrypted by a key of
     * the Android Keystore: the Keystore is slow on large data, so it only guards the key. The
     * files are not included in backups; on another phone the data comes from the server again.
     * Writes go one after another on their own thread, and a read waits for the writes before it.
     */
    private val dataDir by lazy { File(context.noBackupFilesDir, DATA_DIR).apply { mkdirs() } }
    private val dataThread = Executors.newSingleThreadExecutor()
    private val dataCipherKey: SecretKey by lazy {
        val keystore = Keystore(DATA_KEY_LABEL)
        val kept =
            meta.getString(KEY_DATA_KEY, null)?.let { wrapped ->
                runCatching { keystore.decryptBytes(Base64.decode(wrapped, Base64.NO_WRAP)) }.getOrNull()
            }
        val raw =
            kept?.takeIf { it.size == DATA_KEY_BYTES }
                ?: ByteArray(DATA_KEY_BYTES).also {
                    SecureRandom().nextBytes(it)
                    val wrapped = Base64.encodeToString(keystore.encryptBytes(it), Base64.NO_WRAP)
                    meta.edit().putString(KEY_DATA_KEY, wrapped).commit()
                }
        SecretKeySpec(raw, "AES")
    }

    private fun dataFile(name: String) = File(dataDir, "$name.bin")

    private fun dataLoad(name: String): String? =
        runCatching {
            dataThread.submit(
                Callable {
                    val file = dataFile(name)
                    if (file.exists()) {
                        val sealed = file.readBytes()
                        val cipher = Cipher.getInstance(DATA_CIPHER)
                        cipher.init(Cipher.DECRYPT_MODE, dataCipherKey, GCMParameterSpec(DATA_TAG_BITS, sealed, 0, DATA_IV_BYTES))
                        String(cipher.doFinal(sealed, DATA_IV_BYTES, sealed.size - DATA_IV_BYTES), Charsets.UTF_8)
                    } else {
                        // earlier versions kept the data in preferences
                        secure.getString("data_$name")
                    }
                }
            ).get()
        }.onFailure { logger.error("module data is not read: $name", it) }.getOrNull()

    private fun dataSave(name: String, value: String) {
        dataThread.execute {
            runCatching {
                val iv = ByteArray(DATA_IV_BYTES).also { SecureRandom().nextBytes(it) }
                val cipher = Cipher.getInstance(DATA_CIPHER)
                cipher.init(Cipher.ENCRYPT_MODE, dataCipherKey, GCMParameterSpec(DATA_TAG_BITS, iv))
                val tmp = File(dataDir, "$name.tmp")
                tmp.outputStream().use {
                    it.write(iv)
                    it.write(cipher.doFinal(value.toByteArray(Charsets.UTF_8)))
                }
                val file = dataFile(name)
                if (!tmp.renameTo(file)) {
                    file.delete()
                    tmp.renameTo(file)
                }
                secure.remove("data_$name")
            }.onFailure { logger.error("module data is not saved: $name", it) }
        }
    }

    private fun dataClear(name: String) {
        dataThread.execute {
            runCatching {
                dataFile(name).delete()
                secure.remove("data_$name")
            }
        }
    }

    /**
     * The module's request to the app's autofill storage: addresses and bank cards, each with a
     * list, an addition, an edit and a deletion. The fields go under the names of the HTML
     * autocomplete attribute, the way the desktop browser keeps them. A card's number is
     * decrypted with the storage's key for the list (the module needs it to merge the card with
     * the account) and comes in plain for an addition; the security code is not stored at all.
     */
    private suspend fun autofillRequest(json: JSONObject): JSONObject {
        val storage = autofill()
        val guid = json.optString("guid")
        val f = json.optJSONObject("f") ?: JSONObject()
        return when (json.optString("type")) {
            "addresses-list" -> {
                val items = JSONArray()
                storage.getAllAddresses().forEach { a ->
                    val fields = JSONObject()
                    listOf(
                        "name" to a.name, "organization" to a.organization, "street-address" to a.streetAddress,
                        "address-level3" to a.addressLevel3, "address-level2" to a.addressLevel2,
                        "address-level1" to a.addressLevel1, "postal-code" to a.postalCode, "country" to a.country,
                        "tel" to a.tel, "email" to a.email,
                    ).forEach { (name, value) -> if (value.isNotEmpty()) fields.put(name, value) }
                    items.put(JSONObject().put("guid", a.guid).put("f", fields).put("c", a.timeCreated).put("m", a.timeLastModified))
                }
                JSONObject().put("items", items)
            }
            "addresses-add" -> JSONObject().put("guid", storage.addAddress(f.toAddressFields()).guid)
            "addresses-update" -> {
                storage.updateAddress(guid, f.toAddressFields())
                JSONObject().put("ok", true)
            }
            "addresses-delete" -> {
                storage.deleteAddress(guid)
                JSONObject().put("ok", true)
            }
            "cards-list" -> {
                val crypto = storage.getCreditCardCrypto()
                val key = crypto.getOrGenerateKey()
                val items = JSONArray()
                storage.getAllCreditCards().forEach { card ->
                    // a card whose number cannot be decrypted is left out: it cannot be merged
                    val number = crypto.decrypt(key, card.encryptedCardNumber)?.number ?: return@forEach
                    val fields = JSONObject().put("cc-number", number)
                    if (card.billingName.isNotEmpty()) fields.put("cc-name", card.billingName)
                    if (card.expiryMonth in 1..MONTHS) fields.put("cc-exp-month", card.expiryMonth)
                    if (card.expiryYear > 0) fields.put("cc-exp-year", card.expiryYear)
                    if (card.cardType.isNotEmpty()) fields.put("cc-type", card.cardType)
                    items.put(JSONObject().put("guid", card.guid).put("f", fields).put("c", card.timeCreated).put("m", card.timeLastModified))
                }
                JSONObject().put("items", items)
            }
            "cards-add" -> {
                val number = f.cardNumber()
                val added =
                    storage.addCreditCard(
                        NewCreditCardFields(
                            billingName = f.optString("cc-name").take(MAX_FIELD),
                            plaintextCardNumber = CreditCardNumber.Plaintext(number),
                            cardNumberLast4 = number.takeLast(LAST_DIGITS),
                            expiryMonth = f.optLong("cc-exp-month", 0L),
                            expiryYear = f.optLong("cc-exp-year", 0L),
                            cardType = number.creditCardIIN()?.creditCardIssuerNetwork?.name ?: "",
                        )
                    )
                JSONObject().put("guid", added.guid)
            }
            "cards-update" -> {
                val number = f.cardNumber()
                storage.updateCreditCard(
                    guid,
                    UpdatableCreditCardFields(
                        billingName = f.optString("cc-name").take(MAX_FIELD),
                        cardNumber = CreditCardNumber.Plaintext(number),
                        cardNumberLast4 = number.takeLast(LAST_DIGITS),
                        expiryMonth = f.optLong("cc-exp-month", 0L),
                        expiryYear = f.optLong("cc-exp-year", 0L),
                        cardType = number.creditCardIIN()?.creditCardIssuerNetwork?.name ?: "",
                    ),
                )
                JSONObject().put("ok", true)
            }
            "cards-delete" -> {
                storage.deleteCreditCard(guid)
                JSONObject().put("ok", true)
            }
            else -> JSONObject().put("error", "unknown request")
        }
    }

    private fun JSONObject.toAddressFields() =
        UpdatableAddressFields(
            name = optString("name").take(MAX_FIELD),
            organization = optString("organization").take(MAX_FIELD),
            streetAddress = optString("street-address").take(MAX_STREET),
            addressLevel3 = optString("address-level3").take(MAX_FIELD),
            addressLevel2 = optString("address-level2").take(MAX_FIELD),
            addressLevel1 = optString("address-level1").take(MAX_FIELD),
            postalCode = optString("postal-code").take(MAX_FIELD),
            country = optString("country").take(2),
            tel = optString("tel").take(MAX_FIELD),
            email = optString("email").take(MAX_FIELD),
        )

    /** A card number as the module sends it: digits only, 12 to 19 of them. */
    private fun JSONObject.cardNumber(): String {
        val number = optString("cc-number")
        require(CARD_NUMBER.matches(number)) { "not a card number" }
        return number
    }

    /**
     * The module asks for the phone's own visits since a moment: the pages a person opened, the
     * same ones the history screen shows. The latest [MAX_VISITS] are given.
     */
    private suspend fun historyRequest(json: JSONObject): JSONObject {
        val since = json.optLong("since", 0L).coerceAtLeast(0L)
        val visits =
            history().getDetailedVisits(since, excludeTypes = HISTORY_SKIP)
                .asSequence()
                .filter { !it.isRemote && it.url.isWebUrl() }
                .sortedByDescending { it.visitTime }
                .take(MAX_VISITS)
        val list = JSONArray()
        visits.forEach { list.put(JSONObject().put("u", it.url).put("t", it.title.orEmpty().take(MAX_TITLE)).put("at", it.visitTime)) }
        return JSONObject().put("visits", list)
    }

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

    /** Показать домашний экран: в пространстве закрыли последнюю вкладку или перешли в пустое. */
    fun showHome() {
        val activity = host?.get() ?: return
        runCatching { activity.findNavController(R.id.container).navigate(NavGraphDirections.actionGlobalHome()) }
            .onFailure { logger.error("домашний экран не открыт", it) }
    }

    /** Открыть экран модуля: «Аккаунт Tabora», «Коды входа» или «Почта». */
    fun openPage(page: String) {
        val activity = host?.get() ?: return
        if (page != PAGE_ACCOUNT && page != PAGE_CODES && page != PAGE_MAIL && page != PAGE_HISTORY) {
            return
        }
        runCatching {
            activity.findNavController(R.id.container).navigate(NavGraphDirections.actionGlobalTaboraAccountFragment(page))
        }.onFailure { logger.error("экран модуля не открыт", it) }
    }

    /**
     * Open a site from a screen of the module (a page from the history of other devices) in an
     * ordinary tab and show the browser. The tab is private if a private tab is open now.
     */
    private fun openUrl(url: String) {
        val activity = host?.get() ?: return
        if (!url.isWebUrl()) {
            return
        }
        val private = browserStore?.state?.selectedTab?.content?.private == true
        runCatching {
            context.components.useCases.tabsUseCases.addTab(url = url, selectTab = true, private = private)
            activity.findNavController(R.id.container).navigate(NavGraphDirections.actionGlobalBrowser())
        }.onFailure { logger.error("a page from history is not opened", it) }
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
        val targets = mutableListOf<Target>()
        val to = optJSONArray("targets") ?: JSONArray()
        for (i in 0 until minOf(to.length(), MAX_DEVICES)) {
            val target = to.optJSONObject(i) ?: continue
            val id = target.optString("id")
            if (DEVICE_ID.matches(id)) {
                targets += Target(id, target.optString("name").take(MAX_DEVICE_NAME))
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
            targets = targets,
            historyOn = optBoolean("historyOn", false),
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

        /** The "History from other devices" screen. */
        const val PAGE_HISTORY = "history"

        /** Адрес ярлыка почты на домашнем экране: вместо веб-почты он открывает почту в приложении. */
        const val MAIL_SHORTCUT_URL = "https://app.tabora.app"
        private val DATA_NAME = Regex("^[a-z]{1,16}$")
        private val DEVICE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private const val SEND_TIMEOUT_MS = 30_000L
        private val CARD_NUMBER = Regex("^[0-9]{12,19}$")
        private const val MAX_FIELD = 200
        private const val MAX_STREET = 500
        private const val LAST_DIGITS = 4
        private const val MONTHS = 12
        private const val MAX_VISITS = 20_000

        /** Visits that are not pages a person opened; the history screen leaves them out too. */
        private val HISTORY_SKIP =
            listOf(
                VisitType.DOWNLOAD,
                VisitType.REDIRECT_PERMANENT,
                VisitType.REDIRECT_TEMPORARY,
                VisitType.RELOAD,
                VisitType.EMBED,
                VisitType.FRAMED_LINK,
            )
        private const val DATA_DIR = "tabora"
        private const val DATA_KEY_LABEL = "tabora_account_data"
        private const val KEY_DATA_KEY = "data_key"
        private const val DATA_KEY_BYTES = 32
        private const val DATA_IV_BYTES = 12
        private const val DATA_TAG_BITS = 128
        private const val DATA_CIPHER = "AES/GCM/NoPadding"
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
