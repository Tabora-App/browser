// Скрипты сайта tabora.app. Сцена three.js грузится отдельным фрагментом, только если
// в браузере есть WebGL; без него остаётся статичный знак из разметки.

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (e) {
    return false;
  }
}

async function startHero() {
  const host = document.querySelector("[data-hero-stage]");
  if (!host || !webglAvailable()) {
    return;
  }
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { mountHero } = await import("./hero.js");
  mountHero(host, { reducedMotion });
}

function copyButtons() {
  for (const btn of document.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.dataset.copy);
      const text = target?.textContent.trim() || "";
      const done = label => {
        btn.textContent = label;
        setTimeout(() => (btn.textContent = "Скопировать"), 1600);
      };
      try {
        await navigator.clipboard.writeText(text);
        done("Скопировано");
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        done("Выделено, скопируйте вручную");
      }
    });
  }
}

// Код 2FA в макете меняется каждые 30 секунд, как настоящий
function demoCode() {
  const el = document.querySelector("[data-demo-code]");
  const ring = document.querySelector("[data-demo-ring]");
  if (!el) {
    return;
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fresh = () => {
    const n = Math.floor(100000 + Math.random() * 900000);
    el.textContent = `${String(n).slice(0, 3)} ${String(n).slice(3)}`;
  };
  const tick = () => {
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (ring) {
      ring.style.setProperty("--left", String(left / 30));
      ring.dataset.seconds = String(left);
      ring.setAttribute("aria-label", `код сменится через ${left} с`);
    }
    if (left === 30) {
      fresh();
    }
  };
  fresh();
  tick();
  if (!reduced) {
    setInterval(tick, 1000);
  }
}

// Переключатели алиасов в макете почты: подпись строки следует за состоянием
function aliasSwitches() {
  for (const input of document.querySelectorAll("[data-alias]")) {
    const status = input.closest(".alias")?.querySelector("[data-status]");
    input.addEventListener("change", () => {
      if (status) {
        status.textContent = input.checked ? status.dataset.on : status.dataset.off;
      }
    });
  }
}

// Боковая панель разделов: подсвечивает раздел, который сейчас на экране
function railSpy() {
  const links = new Map();
  for (const a of document.querySelectorAll(".rail a[href^='#']")) {
    links.set(a.getAttribute("href").slice(1), a);
  }
  if (!links.size || !("IntersectionObserver" in window)) {
    return;
  }
  const io = new IntersectionObserver(
    entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          for (const a of links.values()) {
            a.removeAttribute("aria-current");
          }
          links.get(e.target.id)?.setAttribute("aria-current", "true");
        }
      }
    },
    { rootMargin: "-35% 0px -60% 0px" }
  );
  for (const id of links.keys()) {
    const section = document.getElementById(id);
    if (section) {
      io.observe(section);
    }
  }
}

copyButtons();
demoCode();
aliasSwitches();
railSpy();
startHero();
