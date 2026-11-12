import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Сокет для почтовых протоколов (IMAP, SMTP): TCP с TLS сразу (порты 993, 465) или с переходом
 * на TLS командой STARTTLS (143, 587). Сертификат сервера проверяет NSS, как для сайтов:
 * исключений нет, при ошибке сертификата соединение не устанавливается.
 * Данные — «байтовые строки» (один символ = один байт): так их отдаёт поток, и так удобно
 * разбирать протоколы с литералами заданной длины. */

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const READ_TIMEOUT_MS = 90_000;

/** Ошибка сети с текстом для пользователя. */
export function netError(e, host) {
  const code = typeof e === "number" ? e : e?.result;
  const name = (() => {
    for (const k of ["NS_ERROR_UNKNOWN_HOST", "NS_ERROR_CONNECTION_REFUSED", "NS_ERROR_NET_TIMEOUT", "NS_ERROR_NET_RESET", "NS_ERROR_OFFLINE", "NS_ERROR_NET_INTERRUPT", "NS_BASE_STREAM_CLOSED", "NS_ERROR_PROXY_CONNECTION_REFUSED"]) {
      if (Cr[k] === code) {
        return k;
      }
    }
    return "";
  })();
  let tls = false;
  try {
    const cls = Cc["@mozilla.org/nss_errors_service;1"].getService(Ci.nsINSSErrorsService).getErrorClass(code);
    tls = cls === Ci.nsINSSErrorsService.ERROR_CLASS_BAD_CERT || cls === Ci.nsINSSErrorsService.ERROR_CLASS_SSL_PROTOCOL;
    if (cls === Ci.nsINSSErrorsService.ERROR_CLASS_BAD_CERT) {
      return Object.assign(new Error(tt`Сертификат сервера ${host} не прошёл проверку: соединение не установлено`), { code: "bad-cert" });
    }
  } catch (x) {}
  const text =
    tls ? tt`Не удалось установить защищённое соединение с ${host}`
    : name === "NS_ERROR_UNKNOWN_HOST" ? tt`Сервер ${host} не найден: проверьте адрес`
    : name === "NS_ERROR_CONNECTION_REFUSED" || name === "NS_ERROR_PROXY_CONNECTION_REFUSED" ? tt`Сервер ${host} не принимает соединения на этом порту`
    : name === "NS_ERROR_NET_TIMEOUT" ? tt`Сервер ${host} не ответил вовремя`
    : name === "NS_ERROR_OFFLINE" ? tt`Нет соединения с интернетом`
    : name ? tt`Соединение с ${host} оборвалось`
    : tt`Не удалось соединиться с ${host}`;
  return Object.assign(new Error(text), { code: tls ? "tls" : "network", detail: String(e?.message || e || "") });
}

export class MailSocket {
  constructor(host, port, transport) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this._buf = "";
    this._want = null;
    this._error = null;
    this._writing = Promise.resolve();
    this.closed = false;
  }

  /** security: "tls" — TLS с первого байта; "starttls" — TLS после команды (startTLS()); "none" — без TLS.
   *
   * Почтовый сервер говорит первым, поэтому соединение считается установленным, когда пришли
   * первые байты его приветствия. Если за полторы секунды их нет, параллельно пробуется путь
   * только по IPv4: у части сетей IPv6 до сервера не доходит, и одиночная попытка ждала бы
   * тайм-аута десятки секунд. Побеждает соединение, первым получившее данные. */
  static connect(host, port, { security = "tls", connectTimeoutSec = 25 } = {}) {
    return new Promise((resolve, reject) => {
      const socks = [];
      let done = false;
      let pending = 0;
      let second = false;
      let firstError = null;
      let timer = null;
      const finish = (sock, error) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        for (const other of socks) {
          other._onReady = null;
          other._onFail = null;
          if (other !== sock) {
            other.close();
          }
        }
        if (sock) {
          resolve(sock);
        } else {
          reject(error);
        }
      };
      const attempt = flags => {
        pending++;
        const failed = error => {
          pending--;
          firstError ||= error;
          if (!second) {
            startSecond();
          } else if (!pending) {
            finish(null, firstError);
          }
        };
        try {
          const sock = MailSocket._open(host, port, security, connectTimeoutSec, flags);
          socks.push(sock);
          sock._onReady = () => finish(sock);
          sock._onFail = failed;
          sock._wait();
        } catch (e) {
          failed(netError(e, host));
        }
      };
      const startSecond = () => {
        if (second || done) {
          return;
        }
        second = true;
        clearTimeout(timer);
        attempt(Ci.nsISocketTransport.DISABLE_IPV6);
      };
      attempt(0);
      timer = setTimeout(startSecond, 1500);
    });
  }

  static _open(host, port, security, connectTimeoutSec, flags) {
    const types = security === "tls" ? ["ssl"] : security === "starttls" ? ["starttls"] : [];
    const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
    const transport = sts.createTransport(types, host, port, null, null);
    if (flags) {
      transport.connectionFlags = flags;
    }
    transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, connectTimeoutSec);
    transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, 600);
    const sock = new MailSocket(host, port, transport);
    sock._in = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    sock._out = transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
    sock._bin = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    sock._bin.setInputStream(sock._in);
    return sock;
  }

  _wait() {
    this._in.asyncWait(this, 0, 0, Services.tm.currentThread);
  }

  // nsIInputStreamCallback
  onInputStreamReady(stream) {
    try {
      const n = stream.available(); // бросает, если поток закрыт или соединение не удалось
      if (n > 0) {
        this._buf += this._bin.readBytes(n);
        const ready = this._onReady;
        if (ready) {
          this._onReady = null;
          ready();
        }
        this._pump();
      }
      if (!this.closed) {
        this._wait();
      }
    } catch (e) {
      this._fail(netError(e, this.host));
    }
  }

  _fail(error) {
    if (this._error) {
      return;
    }
    this._error = error;
    this.closed = true;
    const onFail = this._onFail;
    this._onFail = null;
    onFail?.(error);
    const w = this._want;
    this._want = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(error);
    }
    try {
      this.transport.close(Cr.NS_OK);
    } catch (e) {}
  }

  _pump() {
    while (this._want) {
      const value = this._want.take();
      if (value === undefined) {
        return;
      }
      const w = this._want;
      this._want = null;
      clearTimeout(w.timer);
      w.resolve(value);
    }
  }

  _read(take, timeoutMs) {
    if (this._want) {
      return Promise.reject(new Error(tt`MailSocket: чтение уже ожидается`));
    }
    const ready = take();
    if (ready !== undefined) {
      return Promise.resolve(ready);
    }
    if (this._error) {
      return Promise.reject(this._error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(Object.assign(new Error(tt`Сервер ${this.host} не ответил вовремя`), { code: "network" })), timeoutMs);
      this._want = { take, resolve, reject, timer };
    });
  }

  /** Строка без завершающего CRLF. */
  readLine(timeoutMs = READ_TIMEOUT_MS) {
    return this._read(() => {
      const i = this._buf.indexOf("\n");
      if (i < 0) {
        return undefined;
      }
      const line = this._buf.slice(0, i > 0 && this._buf[i - 1] === "\r" ? i - 1 : i);
      this._buf = this._buf.slice(i + 1);
      return line;
    }, timeoutMs);
  }

  /** Ровно n байт. */
  readExact(n, timeoutMs = READ_TIMEOUT_MS) {
    return this._read(() => {
      if (this._buf.length < n) {
        return undefined;
      }
      const s = this._buf.slice(0, n);
      this._buf = this._buf.slice(n);
      return s;
    }, timeoutMs);
  }

  /** Запись байтовой строки. Записи идут по очереди. */
  write(data) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (this._error) {
          reject(this._error);
          return;
        }
        try {
          const src = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
          if (src.setByteStringData) {
            src.setByteStringData(data);
          } else {
            src.setData(data, data.length);
          }
          const copier = Cc["@mozilla.org/network/async-stream-copier;1"].createInstance(Ci.nsIAsyncStreamCopier);
          copier.init(src, this._out, null, true, false, 65536, true, false);
          copier.asyncCopy(
            {
              onStartRequest() {},
              onStopRequest: (request, status) => {
                if (Components.isSuccessCode(status)) {
                  resolve();
                } else {
                  const err = netError(status, this.host);
                  this._fail(err);
                  reject(err);
                }
              },
            },
            null
          );
        } catch (e) {
          const err = netError(e, this.host);
          this._fail(err);
          reject(err);
        }
      });
    this._writing = this._writing.then(run, run);
    return this._writing;
  }

  /** Переход на TLS после согласия сервера (сокет открыт как "starttls"). */
  startTLS() {
    try {
      this.transport.tlsSocketControl.StartTLS();
    } catch (e) {
      throw netError(e, this.host);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._error ||= Object.assign(new Error(tt`Соединение закрыто`), { code: "closed" });
    const w = this._want;
    this._want = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(this._error);
    }
    try {
      this._in.close();
      this._out.close();
      this.transport.close(Cr.NS_OK);
    } catch (e) {}
  }
}
