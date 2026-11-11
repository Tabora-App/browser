// Под Node рабочих потоков браузера нет: операции OpenPGP выполняются напрямую.
import { API } from "../../../web/src/core/pgp-ops.js";
import { setPgpEngine } from "../../../web/src/core/pgp.js";

setPgpEngine(API);
