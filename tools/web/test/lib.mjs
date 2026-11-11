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

export function summary() {
  console.log(`\nитог: ${passed} из ${passed + failedCount}`);
  process.exitCode = failedCount ? 1 : 0;
}
