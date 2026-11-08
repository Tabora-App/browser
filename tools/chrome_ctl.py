#!/usr/bin/env python3
"""Управление запущенным Tabora через Marionette: выполнить скрипт в контексте окна
и снять снимок окна (работает даже при заблокированном экране).

  tools/chrome_ctl.py --shot .build/shot.png
  tools/chrome_ctl.py --script 'Tabora.openCommandBar("зарег")' --shot .build/shot.png

Браузер должен быть запущен с флагом --marionette (tools/dev_inject.py --marionette
или build.py run --marionette). Порт по умолчанию 2828.
"""
from __future__ import annotations

import argparse
import base64
import json
import socket
import sys
import time


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, timeout=60):
        deadline = time.time() + timeout
        while True:
            try:
                self.sock = socket.create_connection((host, port), timeout=timeout)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        self.sock.settimeout(timeout)
        self._recv()  # приветствие
        self.msg_id = 0
        self.send("WebDriver:NewSession", {})
        self.send("Marionette:SetContext", {"value": "chrome"})

    def _recv(self):
        buf = b""
        while b":" not in buf:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("Marionette закрыл соединение")
            buf += chunk
        length = int(buf.split(b":")[0])
        data = b""
        while len(data) < length:
            chunk = self.sock.recv(length - len(data))
            if not chunk:
                raise ConnectionError("Marionette закрыл соединение")
            data += chunk
        return json.loads(data)

    def send(self, name, params):
        self.msg_id += 1
        body = json.dumps([0, self.msg_id, name, params])
        self.sock.sendall(f"{len(body)}:{body}".encode())
        while True:
            msg = self._recv()
            if msg[0] == 1 and msg[1] == self.msg_id:
                if msg[2]:
                    raise RuntimeError(f"{name}: {msg[2]}")
                return msg[3]

    def execute(self, script, args=None):
        return self.send("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]

    def type_text(self, text):
        actions = []
        for ch in text:
            actions += [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]
        self.send("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": actions}]})

    def screenshot(self, path):
        data = self.send("WebDriver:TakeScreenshot", {"full": False})["value"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))

    def close(self):
        try:
            self.send("WebDriver:DeleteSession", {})
        except Exception:
            pass
        self.sock.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2828)
    ap.add_argument("--script", action="append", default=[], help="JS в контексте окна браузера (можно несколько)")
    ap.add_argument("--type", help="набрать текст как с клавиатуры (после скриптов)")
    ap.add_argument("--wait", type=float, default=0.6, help="пауза после скриптов перед снимком, с")
    ap.add_argument("--shot", help="куда сохранить PNG окна")
    args = ap.parse_args()

    m = Marionette(port=args.port)
    try:
        for s in args.script:
            result = m.execute(s)
            if result is not None:
                print(json.dumps(result, ensure_ascii=False))
        if args.type:
            m.type_text(args.type)
        if args.shot:
            time.sleep(args.wait)
            m.screenshot(args.shot)
            print("снимок:", args.shot)
    finally:
        m.close()


if __name__ == "__main__":
    main()
