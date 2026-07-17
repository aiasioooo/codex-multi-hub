/* Nacchan Control Club — Kawaii Overdrive behaviors (additive).
 * Boot splash, boops, sounds, toasts, tilt, motes,
 * station clock, footer, easter eggs, relay petting.
 * Every feature degrades silently. */
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(pointer: fine)").matches;
const $cute = (sel) => document.querySelector(sel);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const store = {
  get: (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

/* ================= boot splash =================
 * Markup lives in index.html so it paints instantly; we only decorate & dismiss. */
const splash = $cute("#boot-splash") || document.createElement("div");
if (!splash.id) { splash.id = "boot-splash"; document.body.prepend(splash); }
if (!reduceMotion && !splash.querySelector(".splash-heart")) {
  for (let i = 0; i < 9; i += 1) {
    const heart = document.createElement("i");
    heart.className = "splash-heart";
    heart.textContent = pick(["♡", "✦", "♡"]);
    heart.style.left = `${6 + Math.random() * 88}%`;
    heart.style.bottom = "-4vh";
    heart.style.fontSize = `${10 + Math.random() * 14}px`;
    heart.style.animationDelay = `${Math.random() * 2.6}s`;
    splash.append(heart);
  }
}
const dismissSplash = () => {
  splash.classList.add("done");
  setTimeout(() => splash.remove(), 700);
};
window.addEventListener("load", () => setTimeout(dismissSplash, 360));
setTimeout(dismissSplash, 1800); // failsafe
splash.addEventListener("pointerdown", dismissSplash);

/* ================= sound engine (off by default) ================= */
let audioCtx = null;
let soundOn = store.get("hub-sound", false);
function audio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
function tone(freq, { at = 0, dur = 0.12, type = "sine", vol = 0.1, slide = 0 } = {}) {
  if (!soundOn) return;
  const ctx = audio();
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}
const sfx = {
  boop: () => { tone(660, { dur: 0.09, vol: 0.12, slide: 330 }); tone(990, { at: 0.06, dur: 0.12, vol: 0.09 }); },
  toast: () => tone(880, { dur: 0.1, type: "triangle", vol: 0.07 }),
  pet: () => { tone(262, { dur: 0.16, type: "triangle", vol: 0.1, slide: 130 }); tone(392, { at: 0.09, dur: 0.14, vol: 0.07 }); },
  party: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.07, dur: 0.14, type: "triangle", vol: 0.1 })),
  toggle: () => tone(740, { dur: 0.07, vol: 0.08 }),
};

/* ================= toasts ================= */
const toastStack = document.createElement("div");
toastStack.id = "toast-stack";
document.body.append(toastStack);
const toastQueue = [];
let toastCount = 0;
function toast({ who = "hub", title, sub = "", accent = "mint", glyph = null, key = null }) {
  if (key) {
    const visible = Array.from(toastStack.children).find((el) => el.dataset.toastKey === key);
    if (visible) {
      const titleEl = visible.querySelector("b");
      const subEl = visible.querySelector("small");
      if (titleEl) titleEl.textContent = title;
      if (subEl) subEl.textContent = sub;
      return;
    }
    const queued = toastQueue.find((item) => item.key === key);
    if (queued) {
      Object.assign(queued, { who, title, sub, accent, glyph });
      return;
    }
  }
  if (toastQueue.length >= 2) toastQueue.shift();
  toastQueue.push({ who, title, sub, accent, glyph, key });
  flushToasts();
}
function flushToasts() {
  while (toastQueue.length && toastCount < 2) {
    const item = toastQueue.shift();
    toastCount += 1;
    const el = document.createElement("div");
    el.className = "cute-toast";
    if (item.key) el.dataset.toastKey = item.key;
    el.style.setProperty("--toast-accent", `var(--${item.accent}, var(--mint))`);
    el.innerHTML = `<span class="toast-avatar">${item.glyph || item.who[0].toUpperCase()}</span><p><b>${item.title}</b>${item.sub ? `<small>${item.sub}</small>` : ""}</p>`;
    toastStack.append(el);
    sfx.toast();
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => { el.remove(); toastCount -= 1; flushToasts(); }, 380);
    }, 4300);
  }
}

/* ================= boop jar + hearts ================= */
let boops = store.get("hub-boops", 0);
const jar = document.createElement("button");
jar.id = "boop-jar";
jar.className = "cute-chip";
jar.type = "button";
jar.title = "Operator boops collected on this device";
jar.setAttribute("aria-label", `${boops} operator boops collected`);
jar.innerHTML = `<i class="chip-heart">♡</i><b id="boop-count">${boops}</b><span class="jar-label">boops</span>`;
const soundToggle = document.createElement("button");
soundToggle.id = "sound-toggle";
soundToggle.className = `cute-chip${soundOn ? " on" : ""}`;
soundToggle.type = "button";
soundToggle.title = "Toggle tiny cute sounds";
soundToggle.innerHTML = `<i class="chip-note">♪</i><span class="jar-label">sound</span>`;
const topbarStatus = $cute(".topbar-status");
if (topbarStatus) topbarStatus.prepend(soundToggle, jar);
soundToggle.addEventListener("click", () => {
  soundOn = !soundOn;
  store.set("hub-sound", soundOn);
  soundToggle.classList.toggle("on", soundOn);
  if (soundOn) { sfx.toggle(); toast({ who: "hub", title: "tiny sounds on ♪", sub: "the relay hums politely", accent: "lemon", glyph: "♪" }); }
});
jar.addEventListener("click", () => {
  toast({ key: "boop-summary", who: "hub", title: `${boops} boops collected`, sub: boops >= 50 ? "the jar is basically full of love" : "boop an operator to add more", accent: "pink", glyph: "♡" });
});

const heartColors = ["#ff8eac", "#ffd1e0", "#fff09a", "#b8ffe4", "#e1d8ff", "#ffffff"];
function spawnHearts(x, y, count = 5, glyphs = ["♡", "♥", "✦"]) {
  if (reduceMotion) return;
  for (let i = 0; i < count; i += 1) {
    const heart = document.createElement("i");
    heart.className = "boop-heart";
    heart.textContent = pick(glyphs);
    heart.style.left = `${x + (Math.random() - 0.5) * 30}px`;
    heart.style.top = `${y + (Math.random() - 0.5) * 16}px`;
    heart.style.color = pick(heartColors);
    heart.style.fontSize = `${11 + Math.random() * 12}px`;
    heart.style.setProperty("--dx", `${(Math.random() - 0.5) * 130}px`);
    heart.style.setProperty("--dy", `${-30 - Math.random() * 60}px`);
    heart.style.setProperty("--rot", `${(Math.random() - 0.5) * 70}deg`);
    heart.style.animationDelay = `${i * 0.045}s`;
    document.body.append(heart);
    setTimeout(() => heart.remove(), 1400 + i * 50);
  }
}
const milestones = { 10: "10 boops — the jar is warming up ♡", 25: "25 boops! the relay giggled.", 50: "50 boops. certified menace of affection.", 100: "100 BOOPS. the station salutes you ✦", 250: "250. the jar needs a bigger shelf." };
function registerBoop(name, x, y) {
  boops += 1;
  store.set("hub-boops", boops);
  const counter = $cute("#boop-count");
  if (counter) counter.textContent = boops;
  jar.setAttribute("aria-label", `${boops} operator boops collected`);
  jar.classList.remove("bump");
  void jar.offsetWidth;
  jar.classList.add("bump");
  spawnHearts(x, y, 4);
  sfx.boop();
  if (milestones[boops]) toast({ who: name, title: milestones[boops], sub: `boop jar: ${boops} ♡`, accent: name === "aiasio" ? "violet" : "mint" });
}

/* ================= confetti storm ================= */
function confettiStorm(count = 42) {
  if (reduceMotion) return;
  for (let i = 0; i < count; i += 1) {
    const bit = document.createElement("i");
    bit.className = "confetti-heart";
    bit.textContent = pick(["♡", "♥", "✦", "❋", "☆"]);
    bit.style.left = `${Math.random() * 100}vw`;
    bit.style.color = pick(heartColors);
    bit.style.fontSize = `${12 + Math.random() * 16}px`;
    bit.style.setProperty("--sway", `${(Math.random() - 0.5) * 220}px`);
    bit.style.setProperty("--spin", `${300 + Math.random() * 640}deg`);
    bit.style.setProperty("--dur", `${2.2 + Math.random() * 2.2}s`);
    bit.style.animationDelay = `${Math.random() * 0.9}s`;
    document.body.append(bit);
    setTimeout(() => bit.remove(), 5600);
  }
}
function overdrive(reason) {
  confettiStorm(46);
  sfx.party();
  toast({ who: "hub", title: "NACCHAN OVERDRIVE ♡", sub: reason, accent: "pink", glyph: "✦" });
}

/* ================= boop wiring (delegated) ================= */
document.addEventListener("click", (event) => {
  const card = event.target.closest(".operator-card");
  if (card) {
    const name = card.classList.contains("operator-aiasio") ? "aiasio" : "zxc";
    registerBoop(name, event.clientX, event.clientY);
    return;
  }
  if (event.target.closest(".relay-stage")) {
    spawnHearts(event.clientX, event.clientY, 4, ["✦", "♡", "•"]);
    sfx.boop();
  }
});

/* ================= relay petting ================= */
const relayFace = $cute(".relay-face");
if (relayFace) {
  const faceGlyph = relayFace.querySelector("b");
  let petTimer = null;
  let pets = store.get("hub-pets", 0);
  relayFace.addEventListener("pointerdown", () => {
    clearTimeout(petTimer);
    petTimer = setTimeout(() => {
      pets += 1;
      store.set("hub-pets", pets);
      relayFace.classList.add("petted");
      if (faceGlyph) {
        const original = faceGlyph.textContent;
        faceGlyph.textContent = "＞ᴗ＜";
        setTimeout(() => { faceGlyph.textContent = original; }, 1300);
      }
      const rect = relayFace.getBoundingClientRect();
      spawnHearts(rect.left + rect.width / 2, rect.top + rect.height / 2, 8, ["♥", "♡"]);
      sfx.pet();
      if (pets % 5 === 0) toast({ who: "hub", title: `relay petted ${pets} times`, sub: "it is purring in binary", accent: "pink", glyph: "♡" });
      setTimeout(() => relayFace.classList.remove("petted"), 600);
    }, 550);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((type) => relayFace.addEventListener(type, () => clearTimeout(petTimer)));
}

/* ================= card tilt ================= */
if (finePointer && !reduceMotion && matchMedia("(min-width: 981px)").matches) {
  const tiltSelector = ".health-card, .task-column, .pulse-panel, .activity-panel";
  const auraSize = 52;
  let pendingPointer = null;
  let tiltFrame = null;
  const resetTilt = (card) => {
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
    card.style.setProperty("--card-lift", "0px");
  };
  const resetAllTilts = () => document.querySelectorAll(tiltSelector).forEach(resetTilt);
  const updateTilts = () => {
    tiltFrame = null;
    if (!pendingPointer) return;
    const { x, y } = pendingPointer;
    document.querySelectorAll(tiltSelector).forEach((card) => {
      const rect = card.getBoundingClientRect();
      const outsideX = Math.max(rect.left - x, 0, x - rect.right);
      const outsideY = Math.max(rect.top - y, 0, y - rect.bottom);
      const distance = Math.hypot(outsideX, outsideY);
      if (distance >= auraSize) {
        resetTilt(card);
        return;
      }
      const rawPresence = 1 - distance / auraSize;
      const presence = rawPresence * rawPresence * (3 - 2 * rawPresence);
      const nx = Math.max(-1, Math.min(1, (x - (rect.left + rect.width / 2)) / (rect.width / 2)));
      const ny = Math.max(-1, Math.min(1, (y - (rect.top + rect.height / 2)) / (rect.height / 2)));
      const large = card.matches(".pulse-panel, .activity-panel");
      const strength = large ? 0.36 : 0.75;
      const easedX = Math.sin(nx * Math.PI / 2) * strength * presence;
      const easedY = Math.sin(ny * Math.PI / 2) * strength * presence;
      const lift = -(large ? 1 : 2) * presence;
      card.style.setProperty("--ry", `${easedX.toFixed(2)}deg`);
      card.style.setProperty("--rx", `${(-easedY).toFixed(2)}deg`);
      card.style.setProperty("--card-lift", `${lift.toFixed(2)}px`);
    });
  };
  document.addEventListener("pointermove", (event) => {
    pendingPointer = { x: event.clientX, y: event.clientY };
    if (!tiltFrame) tiltFrame = requestAnimationFrame(updateTilts);
  }, { passive: true });
  document.addEventListener("pointerleave", () => { pendingPointer = null; resetAllTilts(); }, { passive: true });
  window.addEventListener("blur", () => { pendingPointer = null; resetAllTilts(); });
}

/* ================= control room motes ================= */
const room = $cute(".control-room");
if (room && !reduceMotion) {
  for (let i = 0; i < 4; i += 1) {
    const mote = document.createElement("i");
    mote.className = "room-mote";
    mote.textContent = pick(["✦", "♡", "·", "❋", "☆"]);
    mote.style.left = `${4 + Math.random() * 92}%`;
    mote.style.bottom = `${6 + Math.random() * 22}%`;
    mote.style.fontSize = `${7 + Math.random() * 9}px`;
    mote.style.setProperty("--dx", `${(Math.random() - 0.5) * 90}px`);
    mote.style.setProperty("--rise", `${120 + Math.random() * 190}px`);
    mote.style.setProperty("--rot", `${(Math.random() - 0.5) * 120}deg`);
    mote.style.setProperty("--dur", `${9 + Math.random() * 11}s`);
    mote.style.animationDelay = `${-Math.random() * 12}s`;
    room.append(mote);
  }
}

/* ================= whole-page hover sparkles ================= */
if (finePointer && !reduceMotion) {
  let lastPictureSparkle = 0;
  document.addEventListener("pointermove", (event) => {
    const now = performance.now();
    if (now - lastPictureSparkle < 52) return;
    lastPictureSparkle = now;
    const sparkle = document.createElement("i");
    sparkle.className = "trail-spark";
    sparkle.textContent = pick(["✦", "·", "♡", "·", "✧"]);
    sparkle.style.left = `${event.clientX}px`;
    sparkle.style.top = `${event.clientY}px`;
    sparkle.style.color = pick(heartColors);
    sparkle.style.fontSize = `${7 + Math.random() * 9}px`;
    sparkle.style.setProperty("--dx", `${(Math.random() - 0.5) * 26}px`);
    sparkle.style.setProperty("--dy", `${-18 - Math.random() * 26}px`);
    sparkle.style.setProperty("--rot", `${(Math.random() - 0.5) * 60}deg`);
    sparkle.style.setProperty("--sc", `${0.6 + Math.random() * 0.7}`);
    document.body.append(sparkle);
    setTimeout(() => sparkle.remove(), 950);
  }, { passive: true });
}

/* ================= station clock ================= */
const heroCopy = $cute(".hero-title > p");
if (heroCopy) {
  const clock = document.createElement("span");
  clock.id = "station-clock";
  heroCopy.insertAdjacentElement("afterend", clock);
  const tickClock = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const day = now.getHours() >= 6 && now.getHours() < 18;
    clock.innerHTML = `<i>${day ? "☀" : "☾"}</i> station time ${hh}:${mm} · ${day ? "day shift" : "night shift"}`;
  };
  tickClock();
  setInterval(tickClock, 20_000);
}

/* ================= footer ================= */
const footer = document.createElement("footer");
footer.id = "cute-footer";
footer.innerHTML = `<span>made with <i>♡</i> at nacchan station</span><span>observation only · control stays in codex</span><span>boops today: <b id="footer-boops">${boops}</b></span><span>relay status: <b id="footer-relay-status">checking</b></span>`;
document.querySelector("main")?.insertAdjacentElement("afterend", footer);
new MutationObserver(() => { const el = $cute("#footer-boops"); if (el) el.textContent = boops; })
  .observe(jar, { childList: true, subtree: true, characterData: true });
const updateFooterHealth = () => {
  const pill = $cute("#service-pill");
  const label = $cute("#footer-relay-status");
  if (!pill || !label) return;
  label.textContent = pill.classList.contains("healthy") ? "connected" :
    pill.classList.contains("warning") ? "degraded" :
    pill.textContent.trim().toLowerCase().includes("connecting") ? "checking" : "unavailable";
};
updateFooterHealth();
setInterval(updateFooterHealth, 3000);

/* ================= easter eggs ================= */
let keyBuffer = "";
document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea")) return;
  keyBuffer = (keyBuffer + event.key.toLowerCase()).slice(-5);
  if (keyBuffer.endsWith("nacc")) { keyBuffer = ""; overdrive("you typed the secret word"); }
});
let brandTaps = [];
$cute(".brand-badge")?.addEventListener("click", () => {
  const now = Date.now();
  brandTaps = brandTaps.filter((t) => now - t < 1800);
  brandTaps.push(now);
  if (brandTaps.length >= 5) { brandTaps = []; overdrive("five taps of approval"); }
});

/* ================= broken image safety net ================= */
document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement) event.target.classList.add("img-missing");
}, true);
