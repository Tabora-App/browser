/* Проверка браузера до загрузки приложения. Обычный скрипт без новых возможностей языка: он обязан
   выполниться и там, где само приложение не запустится. Веб-версии нужны: шифрование в браузере
   (WebCrypto), модули и рабочие потоки, современные регулярные выражения. Это Chrome 90+,
   Firefox 90+, Safari и iOS 16.4+. Если чего-то нет, человек видит понятное объяснение, а не
   пустую страницу. */
(function () {
  var ok = true;
  try {
    ok = !!(window.crypto && window.crypto.subtle && window.Worker && window.Promise && window.fetch && window.TextEncoder && "noModule" in document.createElement("script"));
    new RegExp("(?<!a)b", "u");
    new RegExp("\\p{L}", "u");
  } catch (e) {
    ok = false;
  }
  if (!ok || !window.isSecureContext) {
    var app = document.getElementById("app");
    var box = document.createElement("div");
    box.className = "compat";
    // объяснение — на языке человека (выбор в приложении или язык браузера); иначе по-английски
    var texts = {
      en: ["A secure connection is needed", "This browser is too old", "Tabora Mail only works at an address that starts with https:// — otherwise the browser will not encrypt your data.", "Tabora Mail decrypts your data right in the browser, and this browser cannot do that. Update it (Chrome, Firefox and Safari 16.4 or newer will do) or open the page in another browser."],
      ru: ["Нужно защищённое соединение", "Этот браузер слишком старый", "Веб-версия Tabora работает только по адресу, начинающемуся с https://: иначе браузер не даёт шифровать данные.", "Веб-версия Tabora расшифровывает данные прямо в браузере, и этому браузеру для этого не хватает возможностей. Обновите его (подойдут Chrome, Firefox и Safari 16.4 или новее) или откройте страницу в другом браузере."],
      uk: ["Потрібне захищене з’єднання", "Цей браузер надто старий", "Вебверсія Tabora працює лише за адресою, що починається з https://: інакше браузер не дає шифрувати дані.", "Вебверсія Tabora розшифровує дані просто в браузері, а цьому браузеру для цього бракує можливостей. Оновіть його (підійдуть Chrome, Firefox і Safari 16.4 або новіші) чи відкрийте сторінку в іншому браузері."],
      es: ["Se necesita una conexión segura", "Este navegador es demasiado antiguo", "El correo de Tabora solo funciona en una dirección que empieza por https://; de lo contrario, el navegador no permite cifrar los datos.", "El correo de Tabora descifra tus datos en el propio navegador, y a este navegador le faltan funciones para hacerlo. Actualízalo (sirven Chrome, Firefox y Safari 16.4 o posterior) o abre la página en otro navegador."]
    };
    var lang = "";
    try {
      lang = window.localStorage.getItem("tabora.lang") || "";
    } catch (e) {}
    lang = (lang || navigator.language || "en").toLowerCase().split("-")[0];
    var text = texts[lang] || texts.en;
    var h1 = document.createElement("h1");
    h1.textContent = window.isSecureContext === false ? text[0] : text[1];
    var p = document.createElement("p");
    p.textContent = window.isSecureContext === false ? text[2] : text[3];
    box.appendChild(h1);
    box.appendChild(p);
    app.textContent = "";
    app.appendChild(box);
    window.__taboraUnsupported = true;
  }
})();
