/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Отправка письма по SMTP с входом (порт 465 — TLS сразу, 587 — STARTTLS). Одно соединение
 * на одно письмо. Письмо считается отправленным только после ответа 250 на его текст. */

import { MailSocket } from "chrome://tabora/content/mail/net/Socket.sys.mjs";
import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";

function fail(text, code = "smtp", extra = {}) {
  return Object.assign(new Error(text), { code, ...extra });
}

function utf8Bytes(s) {
  const u = new TextEncoder().encode(String(s));
  let out = "";
  for (let i = 0; i < u.length; i += 8192) {
    out += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  }
  return out;
}

/** Ответ сервера: { code, lines } (многострочный «250-…» собирается целиком). */
async function reply(sock, timeoutMs) {
  const lines = [];
  for (;;) {
    const line = await sock.readLine(timeoutMs);
    const m = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!m) {
      throw fail(tt`Сервер отправки ответил не по протоколу SMTP: проверьте адрес и порт`);
    }
    lines.push(m[3]);
    if (m[2] === " ") {
      return { code: Number(m[1]), lines, text: lines.join(" ") };
    }
  }
}

async function command(sock, line, expect, timeoutMs) {
  await sock.write(`${line}\r\n`);
  const r = await reply(sock, timeoutMs);
  if (expect && !expect.includes(r.code)) {
    throw fail(tt`Сервер отправки отклонил команду: ${r.text}`, "smtp", { status: r.code, server: r.text });
  }
  return r;
}

/**
 * server: { host, port, security }; auth: { login, password };
 * message: { from: адрес, to: [адреса], raw: байтовая строка письма }.
 */
export async function smtpSend(server, auth, message) {
  const security = server.security || (Number(server.port) === 465 ? "tls" : "starttls");
  const sock = await MailSocket.connect(server.host, Number(server.port), { security });
  try {
    const greeting = await reply(sock);
    if (greeting.code !== 220) {
      throw fail(tt`Сервер отправки ${server.host} не готов: ${greeting.text}`);
    }
    let ehlo = await command(sock, "EHLO [127.0.0.1]", [250]);
    if (security === "starttls") {
      if (!ehlo.lines.some(l => /^STARTTLS\b/i.test(l))) {
        throw fail(tt`Сервер ${server.host} не предлагает защищённое соединение на этом порту`, "tls");
      }
      await command(sock, "STARTTLS", [220]);
      sock.startTLS();
      ehlo = await command(sock, "EHLO [127.0.0.1]", [250]);
    }
    const methods = (ehlo.lines.find(l => /^AUTH[ =]/i.test(l)) || "").toUpperCase().split(/[ =]+/).slice(1);
    let auth235;
    if (methods.includes("PLAIN") || !methods.length) {
      auth235 = await command(sock, `AUTH PLAIN ${btoa(`\0${utf8Bytes(auth.login)}\0${utf8Bytes(auth.password)}`)}`, null);
    } else if (methods.includes("LOGIN")) {
      await command(sock, "AUTH LOGIN", [334]);
      await command(sock, btoa(utf8Bytes(auth.login)), [334]);
      auth235 = await command(sock, btoa(utf8Bytes(auth.password)), null);
    } else {
      throw fail(tt`Сервер отправки не принимает вход по паролю`, "auth");
    }
    if (auth235.code !== 235) {
      throw fail(tt`Сервер отправки не принял логин или пароль`, "auth", { server: auth235.text });
    }
    await command(sock, `MAIL FROM:<${message.from}>`, [250]);
    for (const rcpt of message.to) {
      const r = await command(sock, `RCPT TO:<${rcpt}>`, null);
      if (r.code !== 250 && r.code !== 251) {
        throw fail(tt`Сервер не принял адрес ${rcpt}: ${r.text}`, "rcpt", { status: r.code, server: r.text });
      }
    }
    await command(sock, "DATA", [354]);
    // строки, начинающиеся с точки, удваивают её; концы строк — только CRLF
    const body = message.raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await sock.write(body.endsWith("\r\n") ? body : `${body}\r\n`);
    const done = await command(sock, ".", null, 300_000);
    if (done.code !== 250) {
      throw fail(tt`Сервер не принял письмо: ${done.text}`, "smtp", { status: done.code, server: done.text });
    }
    try {
      await command(sock, "QUIT", null, 5000);
    } catch (e) {}
    return { ok: true, server: done.text };
  } finally {
    sock.close();
  }
}
