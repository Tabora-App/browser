// Общие помощники проверок.
let passed = 0;
let failedCount = 0;

export function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failedCount++;
    console.log(`FAIL ${name}\n     получено: ${JSON.stringify(got)}\n     ожидалось: ${JSON.stringify(want)}`);
  }
  return ok;
}

export async function rejects(fn) {
  try {
    await fn();
    return "";
  } catch (e) {
    return e.code || e.message || String(e);
  }
}

/** Код приложения (RFC 6238) для проверок второго шага входа. */
export async function totp(secretB32, shift = 0) {
  const { createHmac } = await import("node:crypto");
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretB32.replace(/\s+|=+$/g, "").toUpperCase()) {
    bits += abc.indexOf(ch).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + shift));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

export function summary() {
  console.log(`\nитог: ${passed} из ${passed + failedCount}`);
  process.exitCode = failedCount ? 1 : 0;
}
