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
    var h1 = document.createElement("h1");
    h1.textContent = window.isSecureContext === false ? "Нужно защищённое соединение" : "Этот браузер слишком старый";
    var p = document.createElement("p");
    p.textContent = window.isSecureContext === false
      ? "Веб-версия Tabora работает только по адресу, начинающемуся с https://: иначе браузер не даёт шифровать данные."
      : "Веб-версия Tabora расшифровывает данные прямо в браузере, и этому браузеру для этого не хватает возможностей. Обновите его (подойдут Chrome, Firefox и Safari 16.4 или новее) или откройте страницу в другом.";
    box.appendChild(h1);
    box.appendChild(p);
    app.textContent = "";
    app.appendChild(box);
    window.__taboraUnsupported = true;
  }
})();
