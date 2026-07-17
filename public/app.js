const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const accountColor = { zxc: "mint", aiasio: "violet" };
const operatorProfiles = {
  zxc: { name: "Momo", initial: "M" },
  aiasio: { name: "Yuzu", initial: "Y" },
};
const operatorName = (instance) => operatorProfiles[instance]?.name || String(instance || "Hub");
const operatorInitial = (instance) => operatorProfiles[instance]?.initial || operatorName(instance).slice(0, 1).toUpperCase();
const operatorText = (value = "") => String(value)
  .replace(/\bzxc\b/gi, operatorProfiles.zxc.name)
  .replace(/\baiasio\b/gi, operatorProfiles.aiasio.name);
let state = null;
let service = null;
let activityFilter = "all";
let query = "";
const timelineNavigationEnabled = false;
const timelineMarksKey = "hub-timeline-marks-v1";
const timelineSeenKey = "hub-timeline-seen-v1";
const timelineUnreadKey = "hub-timeline-auto-unread-v1";
const timelineMarks = new Set((() => {
  try {
    const stored = JSON.parse(localStorage.getItem(timelineMarksKey) || "[]");
    return Array.isArray(stored) ? stored.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
})());
let timelineSeenAt = Number(localStorage.getItem(timelineSeenKey)) || 0;
let timelineAutoUnreadId = localStorage.getItem(timelineUnreadKey) || null;
let timelinePanelVisible = false;
let timelineUnreadChecked = false;
const renderSignatures = new Map();
let refreshInFlight = false;
let appliedHostCameraAction = null;
let hostCameraRestore = null;
let lastManualCameraAt = 0;
const quotaPresentations = new Map();
const visibleQuotaKeys = new Set();
const quotaRevealTimers = new Map();
const quotaSpinTimers = new Map();
const quotaRevealDelayMs = 650;
const quotaRevealDurationMs = 1_800;
const quotaSpinDurationMs = 5_400;
let quotaObserver = null;
const savedTheme = localStorage.getItem("hub-theme");
if (["anime", "vibrant"].includes(savedTheme)) document.body.dataset.theme = savedTheme;
const palettes = {
  original: { label: "Original" },
  dark: { label: "Midnight", themeColor: "#0b1020" },
  light: { label: "Daylight", themeColor: "#f7f2e9" },
  sakura: { label: "Sakura", themeColor: "#3a203c" },
  ocean: { label: "Ocean", themeColor: "#082b3c" },
};
const savedPalette = localStorage.getItem("hub-palette");
document.body.dataset.palette = palettes[savedPalette] ? savedPalette : "original";
const operatorQuips = {
  zxc: ["Behold: one suspiciously elegant shortcut. ♡", "I named the fix before I tested it.", "The relay blinked first. I win.", "Tiny mechanism, enormous reputation."],
  aiasio: ["I adjusted nothing. Observe the improvement. ✦", "The contingency was already decorative.", "I left one variable unattended. Deliberately.", "The relay and I have reached an understanding."],
};
const quipIndex = { zxc: 0, aiasio: 0 };
const manualQuipUntil = { zxc: 0, aiasio: 0 };

function relativeTime(value) {
  if (!value) return "never";
  const seconds = Math.round((new Date(value).valueOf() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function absoluteTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function shortPath(value) {
  if (!value) return "No workspace";
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(" / ");
}

function statusLabel(status) {
  const labels = { active: "Working", running: "Working", inProgress: "Working", idle: "Ready", notLoaded: "Sleeping", unknown: "Unknown" };
  return labels[status] || status;
}

function quotaWindowLabel(minutes) {
  const duration = Number(minutes);
  if (!Number.isFinite(duration) || duration <= 0) return "USAGE QUOTA";
  if (duration <= 360) return `${Math.round(duration / 60)}-HOUR QUOTA`;
  if (duration === 10_080) return "WEEKLY QUOTA";
  if (duration % 1_440 === 0) return `${Math.round(duration / 1_440)}-DAY QUOTA`;
  return `${duration}-MINUTE QUOTA`;
}

function quotaReading(quota, telemetry) {
  return {
    quota: quota ? { ...quota, secondary: undefined } : null,
    telemetry: telemetry ? { ...telemetry } : null,
  };
}

function quotaReadingSignature(reading) {
  const quota = reading.quota;
  const telemetry = reading.telemetry;
  return JSON.stringify({
    state: telemetry?.state || "stale",
    remainingPercent: quota?.remainingPercent ?? null,
    windowMinutes: quota?.windowMinutes ?? null,
    resetsAt: quota?.resetsAt ?? null,
    observedAt: telemetry?.observedAt || quota?.observedAt || null,
  });
}

function liveQuotaValue(reading) {
  if (reading.telemetry?.state !== "live") return null;
  const value = Number(reading.quota?.remainingPercent);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function resolveQuotaPresentation(key, quota, telemetry) {
  const incoming = quotaReading(quota, telemetry);
  const incomingSignature = quotaReadingSignature(incoming);
  let presentation = quotaPresentations.get(key);
  if (!presentation) {
    presentation = { displayed: incoming, displayedSignature: incomingSignature, pending: null, animating: false };
    quotaPresentations.set(key, presentation);
    return presentation.displayed;
  }

  const displayedValue = liveQuotaValue(presentation.displayed);
  const incomingValue = liveQuotaValue(incoming);
  const changedValue = displayedValue !== null && incomingValue !== null && Math.abs(displayedValue - incomingValue) >= 0.01;

  if (changedValue || presentation.animating) {
    if (presentation.animating && incomingSignature === presentation.animatingTargetSignature) {
      return presentation.displayed;
    }
    if (presentation.animating || incomingSignature !== presentation.displayedSignature) {
      presentation.pending = incoming;
    }
    return presentation.displayed;
  }

  presentation.pending = null;
  if (incomingSignature !== presentation.displayedSignature) {
    presentation.displayed = incoming;
    presentation.displayedSignature = incomingSignature;
  }
  return presentation.displayed;
}

function quotaMeter(name, quota, telemetry, index) {
  const key = `${name}:${quota?.windowMinutes ?? "unknown"}:${index}`;
  const presented = resolveQuotaPresentation(key, quota, telemetry);
  quota = presented.quota;
  telemetry = presented.telemetry;
  const telemetryState = telemetry?.state || "stale";
  const isLive = telemetryState === "live";
  if (!quota) {
    const note = telemetryState === "auth-required" ? "Sign-in required · no live telemetry" : "Waiting for live telemetry";
    return `<div class="energy is-stale" data-quota-key="${key}" data-quota-value="0"><div><span>ENERGY / USAGE QUOTA LEFT</span><b>—</b></div><div class="energy-track"><span class="energy-fill" aria-hidden="true"></span><progress max="100" value="0" aria-label="${operatorName(name)} quota unavailable">0%</progress><em></em><em></em><em></em></div><small class="energy-detail">${note}</small></div>`;
  }
  const value = Number(quota.remainingPercent);
  const remaining = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  const label = quotaWindowLabel(quota.windowMinutes);
  const checkedAt = telemetry?.observedAt || quota.observedAt;
  const checked = checkedAt ? ` · checked ${relativeTime(checkedAt)}` : "";
  if (!isLive) {
    const issue = telemetryState === "auth-required" ? "Sign-in required" : telemetryState === "unavailable" ? "Telemetry unavailable" : "Telemetry stale";
    return `<div class="energy is-stale" data-quota-key="${key}" data-quota-value="0"><div><span>ENERGY / ${label} LEFT</span><b>—</b></div><div class="energy-track"><span class="energy-fill" aria-hidden="true"></span><progress max="100" value="0" aria-label="${operatorName(name)} ${label.toLowerCase()} unavailable">0%</progress><em></em><em></em><em></em></div><small class="energy-detail">${issue} · last known ${Math.round(remaining)}% left${checked}</small></div>`;
  }
  const reset = quota.resetsAt ? `Refills ${relativeTime(quota.resetsAt)}` : "Reset time unavailable";
  return `<div class="energy" data-quota-key="${key}" data-quota-value="${remaining}"><div><span>ENERGY / ${label} LEFT</span><b><span class="energy-number">${Math.round(remaining)}%</span> <small>left</small></b></div><div class="energy-track"><span class="energy-fill" aria-hidden="true"></span><progress max="100" value="${remaining}" aria-label="${operatorName(name)} ${label.toLowerCase()} remaining">${remaining}%</progress><em></em><em></em><em></em></div><small class="energy-detail">${reset}${checked}</small></div>`;
}

function quotaDetail(reading) {
  const quota = reading.quota;
  const checkedAt = reading.telemetry?.observedAt || quota?.observedAt;
  const checked = checkedAt ? ` · checked ${relativeTime(checkedAt)}` : "";
  const reset = quota?.resetsAt ? `Refills ${relativeTime(quota.resetsAt)}` : "Reset time unavailable";
  return `${reset}${checked}`;
}

function quotaElement(key) {
  return [...document.querySelectorAll(".energy[data-quota-key]")].find((element) => element.dataset.quotaKey === key) || null;
}

function clearQuotaRevealTimer(key) {
  const timer = quotaRevealTimers.get(key);
  if (timer) clearTimeout(timer);
  quotaRevealTimers.delete(key);
}

function animateQuotaNumber(element, from, to, duration) {
  const startedAt = performance.now();
  const frame = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - ((1 - progress) ** 3);
    element.textContent = `${Math.round(from + ((to - from) * eased))}%`;
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function startQuotaSpin(key, meter) {
  const previousTimer = quotaSpinTimers.get(key);
  if (previousTimer) clearTimeout(previousTimer);
  meter.classList.remove("quota-spinning");
  void meter.offsetWidth;
  meter.classList.add("quota-spinning");
  quotaSpinTimers.set(key, setTimeout(() => {
    if (quotaElement(key) === meter) meter.classList.remove("quota-spinning");
    quotaSpinTimers.delete(key);
  }, quotaSpinDurationMs));
}

function scheduleQuotaReveal(key) {
  const presentation = quotaPresentations.get(key);
  if (!presentation?.pending || presentation.animating || quotaRevealTimers.has(key)) return;
  if (document.hidden || !visibleQuotaKeys.has(key)) return;
  quotaRevealTimers.set(key, setTimeout(() => {
    quotaRevealTimers.delete(key);
    if (!document.hidden && visibleQuotaKeys.has(key)) revealQuota(key);
  }, quotaRevealDelayMs));
}

function revealQuota(key) {
  const presentation = quotaPresentations.get(key);
  const meter = quotaElement(key);
  const target = presentation?.pending;
  const from = presentation ? liveQuotaValue(presentation.displayed) : null;
  const to = target ? liveQuotaValue(target) : null;
  if (!presentation || !meter || from === null || to === null || document.hidden || !visibleQuotaKeys.has(key)) return;

  presentation.pending = null;
  presentation.animating = true;
  presentation.animatingTargetSignature = quotaReadingSignature(target);
  const direction = to >= from ? "quota-refilling" : "quota-draining";
  meter.querySelector(".energy-detail").textContent = quotaDetail(target);
  const progress = meter.querySelector("progress");
  progress.value = to;
  progress.textContent = `${to}%`;
  progress.setAttribute("aria-valuenow", String(to));

  const fill = meter.querySelector(".energy-fill");
  const number = meter.querySelector(".energy-number");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    fill.style.width = `${to}%`;
    number.textContent = `${Math.round(to)}%`;
    presentation.displayed = target;
    presentation.displayedSignature = presentation.animatingTargetSignature;
    presentation.animating = false;
    presentation.animatingTargetSignature = null;
    return;
  }

  meter.classList.add("quota-revealing", direction);
  startQuotaSpin(key, meter);
  requestAnimationFrame(() => {
    fill.style.width = `${to}%`;
    animateQuotaNumber(number, from, to, quotaRevealDurationMs);
  });

  setTimeout(() => {
    presentation.displayed = target;
    presentation.displayedSignature = quotaReadingSignature(target);
    presentation.animating = false;
    presentation.animatingTargetSignature = null;
    meter.classList.remove("quota-revealing", "quota-refilling", "quota-draining");
    if (!presentation.pending) return;
    const pendingValue = liveQuotaValue(presentation.pending);
    if (pendingValue === null) {
      presentation.displayed = presentation.pending;
      presentation.displayedSignature = quotaReadingSignature(presentation.pending);
      presentation.pending = null;
      renderWhenChanged("health", healthRenderSnapshot(), renderHealth, true);
    } else if (Math.abs(pendingValue - to) < 0.01) {
      presentation.displayed = presentation.pending;
      presentation.displayedSignature = quotaReadingSignature(presentation.pending);
      meter.querySelector(".energy-detail").textContent = quotaDetail(presentation.pending);
      presentation.pending = null;
    } else {
      scheduleQuotaReveal(key);
    }
  }, quotaRevealDurationMs + 180);
}

function observeQuotaMeters() {
  if (!quotaObserver) {
    quotaObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const meter = entry.target.closest(".energy[data-quota-key]");
        const key = meter?.dataset.quotaKey;
        if (!key) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.55) {
          visibleQuotaKeys.add(key);
          scheduleQuotaReveal(key);
        } else {
          visibleQuotaKeys.delete(key);
          clearQuotaRevealTimer(key);
        }
      }
    }, { threshold: [0, 0.55, 1] });
  }
  quotaObserver.disconnect();
  visibleQuotaKeys.clear();
  document.querySelectorAll(".energy-track").forEach((track) => quotaObserver.observe(track));
}

function hydrateQuotaMeters() {
  document.querySelectorAll(".energy[data-quota-value]").forEach((meter) => {
    meter.classList.add("quota-hydrating");
    meter.querySelector(".energy-fill").style.width = `${meter.dataset.quotaValue}%`;
    requestAnimationFrame(() => meter.classList.remove("quota-hydrating"));
  });
}

function renderHealth() {
  const container = $("#health-grid");
  container.innerHTML = ["zxc", "aiasio"].map((name) => {
    const instance = state?.instances?.[name];
    if (!instance) return "";
    const rate = instance.rateLimit;
    const telemetry = instance.rateLimitTelemetry;
    const quotas = rate ? [rate, rate.secondary].filter(Boolean).sort((left, right) => Number(left.windowMinutes || Infinity) - Number(right.windowMinutes || Infinity)) : [];
    const lowestRemaining = quotas.length ? Math.min(...quotas.map((quota) => Number(quota.remainingPercent) || 0)) : 100;
    const authRequired = telemetry?.state === "auth-required";
    const connection = !instance.connected ? "offline" : authRequired ? "warning" : "online";
    const mood = !instance.connected ? "signal lost" : authRequired ? "waiting for sign-in" : instance.activeCount ? "focused" : lowestRemaining < 20 ? "needs a snack" : "feeling ready";
    return `<article class="health-card ${accountColor[name]}">
      <div class="health-top">
        <div class="account-id"><span class="account-avatar">${operatorInitial(name)}<i>✦</i></span><div><p>OPERATOR STATUS</p><h2>${operatorName(name)} <small>is ${mood}</small></h2></div></div>
        <span class="plan-badge"><i class="dot ${connection}"></i>${!instance.connected ? "OFFLINE" : authRequired ? "SIGN IN" : "ONLINE"}</span>
      </div>
      <div class="health-main">
        <div class="quota-stack">${(quotas.length ? quotas : [null]).map((quota, index) => quotaMeter(name, quota, telemetry, index)).join("")}</div>
        <dl class="crew-stats">
          <div><dt>Active</dt><dd>${instance.activeCount}</dd></div>
          <div><dt>Missions</dt><dd>${instance.taskCount}</dd></div>
          <div><dt>Mail</dt><dd>${instance.queuedCount}</dd></div>
        </dl>
      </div>
      <div class="quota-footer"><span>${escapeHtml(instance.intermediator?.available ? "♡ Dispatcher ready" : "Dispatcher unavailable")}</span><span>${escapeHtml(rate?.plan || "Codex")} plan</span></div>
    </article>`;
  }).join("");
  ["zxc", "aiasio"].forEach((name, index) => {
    const card = container.children[index];
    if (!card) return;
    card.dataset.hostTarget = `operator.${name}.card`;
    const quota = card.querySelector(".energy");
    if (quota) quota.dataset.hostTarget = `operator.${name}.quota`;
    const missions = card.querySelector(".crew-stats div:nth-child(2)");
    if (missions) missions.dataset.hostTarget = `operator.${name}.missions`;
  });
  hydrateQuotaMeters();
  observeQuotaMeters();
}

function taskRow(task, instance, index = 0) {
  const meta = [task.model, task.effort, task.workspace].filter(Boolean);
  return `<button class="task-row${task.host ? " host-task" : task.intermediary ? " intermediary" : ""}" data-instance="${instance}" data-thread="${task.id}">
    <span class="mission-number">${task.host ? "MC" : task.intermediary ? "HQ" : String(index + 1).padStart(2, "0")}</span>
    <span class="task-state ${task.active ? "active" : "idle"}">${task.intermediary ? "♡" : ""}</span>
    <span class="task-copy">
      <span class="task-title">${escapeHtml(operatorText(task.title))}</span>
      <span class="task-preview">${escapeHtml(operatorText(task.preview || "No prompt preview"))}</span>
      <span class="task-meta">${meta.map((item) => `<i>${escapeHtml(item)}</i>`).join("")}<time>${relativeTime(task.updatedAt)}</time></span>
    </span>
    <span class="task-status">${task.host ? (task.active ? "ON AIR" : "HOST") : task.intermediary ? "DISPATCHER" : statusLabel(task.status).toUpperCase()}</span>
    <span class="row-arrow">›</span>
  </button>`;
}

function renderTasks() {
  const needle = query.trim().toLowerCase();
  $("#task-columns").innerHTML = ["zxc", "aiasio"].map((name) => {
    const instance = state?.instances?.[name];
    const tasks = (instance?.tasks || []).filter((task) => !needle || `${task.title} ${task.preview} ${task.cwd} ${task.model}`.toLowerCase().includes(needle));
    return `<article class="task-column ${accountColor[name]}">
      <header><div><span class="mini-avatar">${operatorInitial(name)}</span><h3>${operatorName(name)}</h3></div><span>${tasks.length} visible</span></header>
      <div class="task-list">${tasks.length ? tasks.map((task, index) => taskRow(task, name, index)).join("") : `<div class="empty-state"><b>No missions found</b><span>${needle ? "Try another search spell." : "The board is sparkling clean."}</span></div>`}</div>
    </article>`;
  }).join("");
  ["zxc", "aiasio"].forEach((name, index) => {
    const column = $("#task-columns").children[index];
    if (column) column.dataset.hostTarget = `operator.${name}.missions`;
  });
  document.querySelectorAll(".task-row").forEach((button) => button.addEventListener("click", () => openInspector(button.dataset.instance, button.dataset.thread)));
}

function activityTime(item) {
  const value = new Date(item?.at || 0).valueOf();
  return Number.isFinite(value) ? value : 0;
}

function saveTimelineMarks() {
  localStorage.setItem(timelineMarksKey, JSON.stringify([...timelineMarks].slice(-40)));
}

function newestActivityTime() {
  return Math.max(0, ...(state?.activity || []).map(activityTime));
}

function markCurrentTimelineSeen() {
  const newest = newestActivityTime();
  if (!newest || newest <= timelineSeenAt) return;
  timelineSeenAt = newest;
  localStorage.setItem(timelineSeenKey, String(timelineSeenAt));
}

function updateTimelineUnread() {
  if (!timelineNavigationEnabled) return;
  const activities = state?.activity || [];
  if (!activities.length) return;
  const firstCheck = !timelineUnreadChecked;
  timelineUnreadChecked = true;
  const newest = newestActivityTime();
  if (!timelineSeenAt) {
    timelineSeenAt = newest;
    localStorage.setItem(timelineSeenKey, String(timelineSeenAt));
    return;
  }
  if (timelineAutoUnreadId && !activities.some((item) => item.id === timelineAutoUnreadId)) {
    timelineAutoUnreadId = null;
    localStorage.removeItem(timelineUnreadKey);
  }
  if (timelineAutoUnreadId) return;
  const unread = activities.filter((item) => activityTime(item) > timelineSeenAt);
  if (unread.length && (firstCheck || !timelinePanelVisible || document.hidden)) {
    timelineAutoUnreadId = unread.reduce((oldest, item) => activityTime(item) < activityTime(oldest) ? item : oldest).id;
    localStorage.setItem(timelineUnreadKey, timelineAutoUnreadId);
    return;
  }
  if (timelinePanelVisible && !document.hidden) markCurrentTimelineSeen();
}

function timelineMarkButton(item) {
  if (!timelineNavigationEnabled) return "";
  const marked = timelineMarks.has(item.id);
  return `<button class="timeline-mark-toggle${marked ? " active" : ""}" type="button" aria-pressed="${marked}" aria-label="${marked ? "Unmark" : "Mark"} this point on the timeline" title="${marked ? "Remove timeline mark" : "Mark this point"}"><span>${marked ? "♥" : "♡"}</span></button>`;
}

function timelineItemClasses(item) {
  if (!timelineNavigationEnabled) return "";
  return [
    timelineMarks.has(item.id) ? "timeline-marked" : "",
    timelineAutoUnreadId === item.id ? "timeline-auto-unread" : "",
  ].filter(Boolean).join(" ");
}

function visibleTimelineMarks() {
  return [...document.querySelectorAll("#activity-list .timeline-item")].filter((item) => item.classList.contains("timeline-marked") || item.classList.contains("timeline-auto-unread"));
}

function updateTimelineMarkControls() {
  if (!timelineNavigationEnabled) return;
  const nav = $("#timeline-mark-nav");
  const unread = $("#timeline-unread-jump");
  const visible = visibleTimelineMarks();
  nav.hidden = visible.length === 0;
  unread.hidden = !timelineAutoUnreadId;
  $("#timeline-toolbar").hidden = nav.hidden && unread.hidden;
  $("#timeline-mark-count").textContent = `♡ ${timelineMarks.size}${timelineAutoUnreadId ? " · ✦" : ""}`;
}

function consumeTimelineUnread(target) {
  if (!target || target.dataset.activityId !== timelineAutoUnreadId) return;
  timelineAutoUnreadId = null;
  localStorage.removeItem(timelineUnreadKey);
  markCurrentTimelineSeen();
  setTimeout(() => {
    target.classList.remove("timeline-auto-unread");
    updateTimelineMarkControls();
  }, 850);
}

function nudgeTimelineNavigator() {
  const nav = $("#timeline-mark-nav");
  nav.classList.remove("no-more-marks");
  requestAnimationFrame(() => nav.classList.add("no-more-marks"));
  setTimeout(() => nav.classList.remove("no-more-marks"), 430);
}

function jumpToTimelineMark(direction, activityId = null) {
  let marks = visibleTimelineMarks();
  let target = activityId ? marks.find((item) => item.dataset.activityId === activityId) : null;
  if (!target && activityId && activityFilter !== "all") {
    activityFilter = "all";
    document.querySelectorAll("#activity-filters button").forEach((button) => button.classList.toggle("active", button.dataset.filter === "all"));
    renderWhenChanged("activity", activityRenderSnapshot(), renderActivity, true);
    marks = visibleTimelineMarks();
    target = marks.find((item) => item.dataset.activityId === activityId);
  }
  if (!target && !activityId) {
    const viewportCenter = innerHeight * 0.48;
    const positioned = marks.map((item) => {
      const bounds = item.getBoundingClientRect();
      return { item, center: (bounds.top + bounds.bottom) / 2 };
    });
    const candidates = direction === "newer"
      ? positioned.filter(({ center }) => center < viewportCenter - 24).sort((a, b) => b.center - a.center)
      : positioned.filter(({ center }) => center > viewportCenter + 24).sort((a, b) => a.center - b.center);
    target = candidates[0]?.item || null;
  }
  if (!target) {
    nudgeTimelineNavigator();
    return;
  }
  target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  target.classList.remove("timeline-jump-target");
  requestAnimationFrame(() => target.classList.add("timeline-jump-target"));
  setTimeout(() => target.classList.remove("timeline-jump-target"), 1_500);
  consumeTimelineUnread(target);
}

function renderActivity() {
  const conversational = (item) => ["communication", "host-chat", "host-research"].includes(item.kind);
  const activities = (state?.activity || []).filter((item) => activityFilter === "all" || (activityFilter === "communication" ? conversational(item) : !conversational(item)));
  const furthestMarked = timelineNavigationEnabled
    ? activities.reduce((furthest, item, index) => (timelineMarks.has(item.id) || timelineAutoUnreadId === item.id) ? index : furthest, -1)
    : -1;
  const displayed = activities.slice(0, Math.max(28, furthestMarked + 1));
  $("#activity-list").innerHTML = displayed.length ? displayed.map((item) => {
    const instance = item.fromInstance || item.instance || "hub";
    const sources = (item.sources || []).map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(source.title || "Source")}</a>`).join("");
    const markerClasses = timelineItemClasses(item);
    const unreadAttribute = timelineNavigationEnabled && timelineAutoUnreadId === item.id ? ` data-auto-unread="true"` : "";
    if (item.kind === "host-chat") {
      const host = ["zxc", "aiasio"].includes(instance) ? instance : "zxc";
      const channel = item.hostMode === "exchange" ? `TO ${operatorName(item.toInstance || "CLUB").toUpperCase()}` : item.hostMode === "visual" ? "UI NOTE" : "CLUB MIC";
      const sigil = operatorInitial(host);
      const flourish = host === "zxc" ? "✦" : "⋯";
      return `<article class="timeline-item host-chat ${host} ${escapeHtml(item.tone || "")} ${markerClasses}" data-activity-id="${escapeHtml(item.id)}"${unreadAttribute}>
        <div class="host-chat-avatar" aria-hidden="true"><b>${sigil}</b><i></i></div>
        <div class="host-chat-card">
          <header><span><strong>${escapeHtml(operatorName(host))}</strong><small>${escapeHtml(channel)}</small></span><time title="${escapeHtml(absoluteTime(item.at))}">${relativeTime(item.at)}</time></header>
          <p>${escapeHtml(operatorText(item.summary || "…"))}</p>
          <footer><span>${escapeHtml(item.state || "said")}</span><div class="host-chat-tools">${timelineMarkButton(item)}<i aria-hidden="true">${flourish}</i></div></footer>
        </div>
      </article>`;
    }
    return `<article class="timeline-item ${escapeHtml(item.kind)} ${markerClasses}" data-activity-id="${escapeHtml(item.id)}"${unreadAttribute}>
      <div class="timeline-marker"><i></i></div>
      <div class="timeline-copy"><div><strong>${escapeHtml(operatorText(item.title))}</strong><time title="${escapeHtml(absoluteTime(item.at))}">${relativeTime(item.at)}</time></div><p>${escapeHtml(operatorText(item.summary || "Hub state updated"))}</p>${sources ? `<div class="research-sources">${sources}</div>` : ""}<span class="event-state ${escapeHtml(item.state)}">${escapeHtml(item.state || "observed")}</span></div>
      <div class="timeline-tools"><span class="event-account">${escapeHtml(operatorName(instance))}</span>${timelineMarkButton(item)}</div>
    </article>`;
  }).join("") : `<div class="empty-state"><b>No relay activity</b><span>Cross-account communication will appear here.</span></div>`;
  updateTimelineMarkControls();
}

function renderPulse() {
  const messages = state?.messages || [];
  const counts = messages.reduce((result, item) => ({ ...result, [item.state]: (result[item.state] || 0) + 1 }), {});
  $("#traffic-total").textContent = messages.length;
  const delivered = (counts.delivered || 0) + (counts.started || 0) + (counts.complete || 0);
  $("#traffic-track").style.width = `${messages.length ? Math.max(4, delivered / messages.length * 100) : 0}%`;
  $("#traffic-legend").innerHTML = [
    ["Delivered", delivered, "good"], ["Queued", counts.queued || 0, "wait"], ["Failed", counts.failed || 0, "bad"],
  ].map(([label, count, tone]) => `<span><i class="${tone}"></i><b>${count}</b>${label}</span>`).join("");
  if (service) {
    const standby = Object.entries(service.slots || {}).find(([name]) => name !== service.activeSlot)?.[1];
    $("#service-detail").innerHTML = `<span><i class="dot online"></i>Blue/green service</span><dl><div><dt>Active worker</dt><dd>${escapeHtml(service.activeSlot || "—")}</dd></div><div><dt>Standby</dt><dd>${escapeHtml(standby?.phase || "—")}</dd></div><div><dt>Generation</dt><dd>${service.generation || 0}</dd></div></dl>`;
  }
}

function replaySceneMotion(element, className) {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  clearTimeout(element.sceneMotionTimer);
  element.sceneMotionTimer = setTimeout(() => element.classList.remove(className), 700);
}

function updateSceneText(selector, value, className) {
  const element = $(selector);
  if (!element || element.textContent === value) return;
  element.textContent = value;
  replaySceneMotion(element, className);
}

function updateSceneHtml(selector, value, className) {
  const element = $(selector);
  if (!element || element.innerHTML === value) return;
  element.innerHTML = value;
  replaySceneMotion(element, className);
}

function sceneFallbackSpeech(name, mode) {
  const lines = {
    zxc: {
      offline: "Signal escaped. I'll build a smaller net. <span>×</span>",
      auth: "My badge staged a tiny rebellion. Sign-in, please. <span>×</span>",
      working: "Operation Tiny Thunder is perfectly under control. <span>✦</span>",
      tired: "Low power. The genius remains overclocked. <span>…</span>",
      idle: "I upgraded the quiet. You're welcome. <span>♡</span>",
    },
    aiasio: {
      offline: "The signal is absent. Its timing is interesting. <span>×</span>",
      auth: "The credentials have chosen silence. How deliberate. <span>×</span>",
      working: "The plan has begun. It thinks this was its idea. <span>✦</span>",
      tired: "Conserving energy. Not intentions. <span>…</span>",
      idle: "Nothing is happening. I arranged it carefully. <span>✦</span>",
    },
  };
  return lines[name][mode];
}

function renderScene() {
  for (const name of ["zxc", "aiasio"]) {
    const instance = state?.instances?.[name];
    const card = $(`#scene-${name}`);
    if (!instance || !card) continue;
    const remaining = instance.rateLimit?.remainingPercent ?? 100;
    const authRequired = instance.rateLimitTelemetry?.state === "auth-required";
    const mode = !instance.connected ? "offline" : authRequired ? "auth" : instance.activeCount ? "working" : remaining < 20 ? "tired" : "idle";
    card.dataset.mode = mode;
    const hostSpeech = (state?.hostActions || []).filter((action) => action.type === "speech" && action.instance === name).at(-1);
    if (["offline", "auth"].includes(mode)) manualQuipUntil[name] = 0;
    if (hostSpeech && !["offline", "auth"].includes(mode) && Date.now() >= manualQuipUntil[name]) updateSceneText(`#scene-${name}-speech`, hostSpeech.text, "speech-updated");
    updateSceneText(`#scene-${name}-status`, mode === "offline" ? "SIGNAL LOST" : mode === "auth" ? "SIGN-IN NEEDED" : instance.activeCount ? `${instance.activeCount} MISSION IN PROGRESS` : `${instance.taskCount} MISSIONS · READY`, "status-updated");
    if ((!hostSpeech || ["offline", "auth"].includes(mode)) && Date.now() >= manualQuipUntil[name]) {
      updateSceneHtml(`#scene-${name}-speech`, sceneFallbackSpeech(name, mode), "speech-updated");
    }
  }
  updateSceneText("#scene-packets", String((state?.messages || []).filter((message) => message.state === "queued").length), "packet-updated");
}

function renderService() {
  const instances = Object.values(state?.instances || {});
  const authRequired = instances.find((item) => item.rateLimitTelemetry?.state === "auth-required");
  const healthy = service?.ok && instances.every((item) => item.connected) && !authRequired;
  $("#service-pill").classList.toggle("healthy", Boolean(healthy));
  $("#service-pill").querySelector("span").textContent = service?.reloading ? "Switching workers" : authRequired ? `${operatorName(authRequired.name)} sign-in needed` : healthy ? "All systems calm" : "Attention needed";
  $("#last-sync").textContent = state?.now ? `Synced ${relativeTime(state.now)}` : "—";
}

function hostTargetElement(target) {
  return document.querySelector(`[data-host-target="${String(target || "").replace(/["\\]/g, "")}"]`);
}

function positionHostCallouts() {
  const placed = [];
  document.querySelectorAll(".host-callout").forEach((bubble) => {
    const target = hostTargetElement(bubble.dataset.target);
    if (!target) {
      bubble.hidden = true;
      return;
    }
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) {
      bubble.hidden = true;
      return;
    }
    bubble.hidden = false;
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const above = rect.top - height - 12;
    const below = rect.bottom + 12;
    const center = rect.left + rect.width / 2 - width / 2;
    const clampLeft = (left) => Math.min(innerWidth - width - 10, Math.max(10, left));
    const clampTop = (top) => Math.min(innerHeight - height - 8, Math.max(8, top));
    const candidates = [
      { left: center, top: above, below: false },
      { left: center, top: below, below: true },
      { left: center - width * .58, top: above, below: false },
      { left: center + width * .58, top: above, below: false },
      { left: center - width * .58, top: below, below: true },
      { left: center + width * .58, top: below, below: true },
      { left: center, top: above - height - 9, below: false },
      { left: center, top: below + height + 9, below: true },
    ].map((candidate) => ({ ...candidate, left: clampLeft(candidate.left), top: clampTop(candidate.top) }));
    const overlaps = (candidate) => placed.some((item) => !(
      candidate.left + width + 8 <= item.left || candidate.left >= item.right + 8 ||
      candidate.top + height + 8 <= item.top || candidate.top >= item.bottom + 8
    ));
    const chosen = candidates.find((candidate) => !overlaps(candidate)) || candidates[above >= 8 ? 0 : 1];
    bubble.style.left = `${chosen.left}px`;
    bubble.style.top = `${chosen.top}px`;
    bubble.style.setProperty("--callout-tail-x", `${Math.min(width - 18, Math.max(18, rect.left + rect.width / 2 - chosen.left))}px`);
    bubble.classList.toggle("below", chosen.below);
    placed.push({ left: chosen.left, top: chosen.top, right: chosen.left + width, bottom: chosen.top + height });
  });
}

function renderHostActions() {
  const actions = state?.hostActions || [];
  const session = state?.activeHostSession || null;
  const badge = $("#host-session-badge");
  badge.hidden = !session;
  if (session) badge.querySelector("span").textContent = `${session.kind.toUpperCase()} Â· ${session.turnsUsed}/${session.maxTurns} turns`;

  document.querySelectorAll(".host-highlight").forEach((element) => {
    element.classList.remove("host-highlight", "host-highlight-pulse", "host-highlight-outline", "host-highlight-spotlight", "host-highlight-sparkle");
    element.style.removeProperty("--host-accent");
  });
  for (const name of ["zxc", "aiasio"]) {
    const speech = actions.filter((action) => action.type === "speech" && action.instance === name).at(-1);
    const card = $(`#scene-${name}`);
    if (card) card.dataset.hostTone = speech?.tone || "";
  }
  actions.filter((action) => action.type === "highlight").forEach((action) => {
    const target = hostTargetElement(action.target);
    if (!target) return;
    target.classList.add("host-highlight", `host-highlight-${action.style || "glow"}`);
    target.style.setProperty("--host-accent", `var(--host-${action.color || action.instance})`);
  });

  const overlay = $("#host-overlay");
  overlay.innerHTML = actions.filter((action) => action.type === "callout").map((action) => `<aside class="host-callout ${escapeHtml(action.instance)} ${escapeHtml(action.style || "bubble")}" data-target="${escapeHtml(action.target)}" style="--host-accent:var(--host-${escapeHtml(action.color || action.instance)})"><span>${escapeHtml(operatorName(action.instance))}</span><p>${escapeHtml(operatorText(action.text))}</p></aside>`).join("");
  requestAnimationFrame(positionHostCallouts);

  const cameraAction = actions.filter((action) => action.type === "camera").at(-1);
  if (cameraAction && cameraAction.id !== appliedHostCameraAction && Date.now() - lastManualCameraAt > 30_000) {
    if (!appliedHostCameraAction) hostCameraRestore = cameraTarget;
    appliedHostCameraAction = cameraAction.id;
    applyCamera(cameraAction.target, { temporary: true });
  } else if (!cameraAction && appliedHostCameraAction) {
    const restore = hostCameraRestore || "hub";
    appliedHostCameraAction = null;
    hostCameraRestore = null;
    if (Date.now() - lastManualCameraAt > 30_000) applyCamera(restore, { temporary: true });
  }
}

function itemText(item) {
  if (item.text) return item.text;
  return (item.content || []).map((part) => part.text || "").filter(Boolean).join("\n");
}

async function openInspector(instance, threadId) {
  const inspector = $("#inspector");
  const backdrop = $("#drawer-backdrop");
  const task = state?.instances?.[instance]?.tasks?.find((item) => item.id === threadId);
  $("#inspector-instance").textContent = `${operatorName(instance)} · ${task?.status || "task"}`;
  $("#inspector-title").textContent = operatorText(task?.title || "Task");
  $("#inspector-body").innerHTML = `<div class="inspector-loading"><i></i><span>Reading task history…</span></div>`;
  backdrop.hidden = false;
  requestAnimationFrame(() => { inspector.classList.add("open"); backdrop.classList.add("visible"); inspector.setAttribute("aria-hidden", "false"); });
  try {
    const response = await fetch(`/api/threads/${instance}/${encodeURIComponent(threadId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    const detail = await response.json();
    renderInspector(detail, task);
  } catch (error) {
    $("#inspector-body").innerHTML = `<div class="empty-state error"><b>Could not inspect task</b><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function renderInspector(detail, summary) {
  const thread = detail.thread || {};
  const turns = thread.turns || [];
  const conversation = turns.flatMap((turn) => (turn.items || []).filter((item) => ["userMessage", "agentMessage"].includes(item.type)).map((item) => ({ role: item.type === "userMessage" ? "user" : "assistant", text: itemText(item), turn })));
  const errors = turns.filter((turn) => turn.error).map((turn) => turn.error?.message || JSON.stringify(turn.error));
  $("#inspector-body").innerHTML = `
    <section class="inspector-facts">
      <span><small>Model</small><b>${escapeHtml(thread.runtime?.model || summary?.model || "Not reported")}</b></span>
      <span><small>Effort</small><b>${escapeHtml(thread.runtime?.effort || summary?.effort || "—")}</b></span>
      <span><small>Updated</small><b>${relativeTime(summary?.updatedAt || thread.updatedAt)}</b></span>
    </section>
    <section class="path-card"><small>Workspace</small><code title="${escapeHtml(thread.cwd || "")}">${escapeHtml(thread.cwd || "No workspace reported")}</code></section>
    ${errors.length ? `<section class="error-card"><b>Latest error</b><p>${escapeHtml(errors[0])}</p></section>` : ""}
    <section class="conversation"><div class="subheading"><h3>Recent conversation</h3><span>${turns.length} turn${turns.length === 1 ? "" : "s"}</span></div>
      ${conversation.length ? conversation.slice(-30).map((message) => `<article class="message-bubble ${message.role}"><span>${message.role === "user" ? "You" : "Codex"}</span><p>${escapeHtml(message.text)}</p></article>`).join("") : `<div class="empty-state"><b>No readable messages</b><span>This may be an ephemeral or newly created task.</span></div>`}
    </section>
    <section class="hub-links"><div class="subheading"><h3>Hub involvement</h3><span>${detail.messages?.length || 0} messages</span></div>
      ${(detail.messages || []).slice(0, 8).map((message) => `<article><b>${escapeHtml(operatorName(message.fromInstance))} → ${escapeHtml(operatorName(message.toInstance))}</b><span>${escapeHtml(message.state)}</span><p>${escapeHtml(operatorText(message.reason || message.body))}</p></article>`).join("") || `<p class="quiet">No cross-account messages are attached to this task.</p>`}
    </section>`;
}

function closeInspector() {
  $("#inspector").classList.remove("open");
  $("#inspector").setAttribute("aria-hidden", "true");
  $("#drawer-backdrop").classList.remove("visible");
  setTimeout(() => { $("#drawer-backdrop").hidden = true; }, 250);
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const [stateResponse, serviceResponse] = await Promise.all([fetch("/api/state", { cache: "no-store" }), fetch("/api/service", { cache: "no-store" })]);
    if (stateResponse.status === 401) return location.assign("/login.html");
    if (!stateResponse.ok) throw new Error(`State HTTP ${stateResponse.status}`);
    state = await stateResponse.json();
    service = serviceResponse.ok ? await serviceResponse.json() : null;
    updateTimelineUnread();
    renderScene();
    renderWhenChanged("health", healthRenderSnapshot(), renderHealth);
    renderWhenChanged("tasks", taskRenderSnapshot(), renderTasks);
    renderWhenChanged("activity", activityRenderSnapshot(), renderActivity);
    renderWhenChanged("pulse", pulseRenderSnapshot(), renderPulse);
    renderWhenChanged("hosts", hostRenderSnapshot(), renderHostActions);
    renderService();
    positionHostCallouts();
  } catch (error) {
    $("#service-pill").classList.remove("healthy");
    $("#service-pill").querySelector("span").textContent = "Hub unreachable";
    console.error(error);
  } finally {
    refreshInFlight = false;
  }
}

function minuteBucket() {
  return Math.floor(Date.now() / 60_000);
}

function healthRenderSnapshot() {
  return {
    minute: minuteBucket(),
    instances: ["zxc", "aiasio"].map((name) => {
      const instance = state?.instances?.[name] || {};
      return {
        name,
        connected: instance.connected,
        activeCount: instance.activeCount,
        taskCount: instance.taskCount,
        queuedCount: instance.queuedCount,
        rateLimit: instance.rateLimit,
        rateLimitTelemetry: instance.rateLimitTelemetry,
        intermediatorAvailable: instance.intermediator?.available,
        host: instance.host,
      };
    }),
  };
}

function taskRenderSnapshot() {
  return {
    minute: minuteBucket(),
    query,
    tasks: ["zxc", "aiasio"].map((name) => [name, state?.instances?.[name]?.tasks || []]),
  };
}

function activityRenderSnapshot() {
  return { minute: minuteBucket(), activityFilter, marks: [...timelineMarks], unread: timelineAutoUnreadId, activity: state?.activity || [] };
}

function pulseRenderSnapshot() {
  return { messages: state?.messages || [], service };
}

function hostRenderSnapshot() {
  return { actions: state?.hostActions || [], session: state?.activeHostSession || null };
}

function renderWhenChanged(key, snapshot, renderer, force = false) {
  const signature = JSON.stringify(snapshot);
  if (!force && renderSignatures.get(key) === signature) return;
  renderSignatures.set(key, signature);
  renderer();
}

$("#task-search").addEventListener("input", (event) => {
  query = event.target.value;
  renderWhenChanged("tasks", taskRenderSnapshot(), renderTasks, true);
});
$("#activity-filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  activityFilter = button.dataset.filter;
  document.querySelectorAll("#activity-filters button").forEach((item) => item.classList.toggle("active", item === button));
  renderWhenChanged("activity", activityRenderSnapshot(), renderActivity, true);
});
if (timelineNavigationEnabled) {
  $("#activity-list").addEventListener("click", (event) => {
    const button = event.target.closest(".timeline-mark-toggle");
    if (!button) return;
    const item = button.closest(".timeline-item");
    const activityId = item?.dataset.activityId;
    if (!activityId) return;
    if (timelineMarks.has(activityId)) timelineMarks.delete(activityId);
    else timelineMarks.add(activityId);
    saveTimelineMarks();
    item.classList.toggle("timeline-marked", timelineMarks.has(activityId));
    button.classList.toggle("active", timelineMarks.has(activityId));
    button.setAttribute("aria-pressed", String(timelineMarks.has(activityId)));
    button.setAttribute("aria-label", `${timelineMarks.has(activityId) ? "Unmark" : "Mark"} this point on the timeline`);
    button.title = timelineMarks.has(activityId) ? "Remove timeline mark" : "Mark this point";
    button.querySelector("span").textContent = timelineMarks.has(activityId) ? "♥" : "♡";
    updateTimelineMarkControls();
  });
  $("#timeline-mark-nav").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mark-jump]");
    if (button) jumpToTimelineMark(button.dataset.markJump);
  });
  $("#timeline-unread-jump").addEventListener("click", () => {
    if (timelineAutoUnreadId) jumpToTimelineMark("older", timelineAutoUnreadId);
  });
}
$("#inspector-close").addEventListener("click", closeInspector);
$("#drawer-backdrop").addEventListener("click", closeInspector);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeInspector(); });
document.querySelectorAll(".mobile-nav button").forEach((button) => button.addEventListener("click", () => {
  document.body.dataset.mobileView = button.dataset.view;
  document.querySelectorAll(".mobile-nav button").forEach((item) => item.classList.toggle("active", item === button));
  scrollTo({ top: 0, behavior: "smooth" });
}));
if (timelineNavigationEnabled) {
  const timelineVisibilityObserver = new IntersectionObserver(([entry]) => {
    timelinePanelVisible = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.24);
    if (timelinePanelVisible && !document.hidden && !timelineAutoUnreadId) markCurrentTimelineSeen();
  }, { threshold: [0, 0.24, 0.6] });
  timelineVisibilityObserver.observe($(".activity-panel"));
}
document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.classList.toggle("active", button.dataset.themeChoice === document.body.dataset.theme);
  button.addEventListener("click", () => {
    const theme = button.dataset.themeChoice;
    document.body.dataset.theme = theme;
    localStorage.setItem("hub-theme", theme);
    document.querySelectorAll("[data-theme-choice]").forEach((item) => item.classList.toggle("active", item === button));
    applyPalette(document.body.dataset.palette);
  });
});

const paletteToggle = $("#palette-toggle");
const paletteOptions = $("#palette-options");
function closePalettePicker() {
  paletteOptions.hidden = true;
  paletteToggle.setAttribute("aria-expanded", "false");
}
function applyPalette(palette) {
  const choice = palettes[palette] ? palette : "original";
  document.body.dataset.palette = choice;
  localStorage.setItem("hub-palette", choice);
  $("#palette-label").textContent = palettes[choice].label;
  paletteToggle.dataset.palette = choice;
  document.querySelector('meta[name="theme-color"]').content = palettes[choice].themeColor || (document.body.dataset.theme === "vibrant" ? "#f6f3ff" : "#171830");
  document.querySelectorAll("[data-palette-choice]").forEach((button) => {
    const active = button.dataset.paletteChoice === choice;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
}
paletteToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  const opening = paletteOptions.hidden;
  paletteOptions.hidden = !opening;
  paletteToggle.setAttribute("aria-expanded", String(opening));
  if (opening) paletteOptions.querySelector(".active")?.focus();
});
paletteOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-palette-choice]");
  if (!button) return;
  applyPalette(button.dataset.paletteChoice);
  closePalettePicker();
  paletteToggle.focus();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".palette-picker")) closePalettePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !paletteOptions.hidden) {
    closePalettePicker();
    paletteToggle.focus();
  }
});
applyPalette(document.body.dataset.palette);

const cameraRoom = $(".control-room");
const cameraModes = ["wide", "zxc", "hub", "aiasio"];
const cameraButtonModes = ["wide", "hub"];
const desktopCameraQuery = matchMedia("(min-width: 681px)");
const cameraActors = {
  wide: [],
  zxc: ["zxc"],
  hub: ["zxc", "aiasio", "relay"],
  aiasio: ["aiasio"],
};
const savedCamera = localStorage.getItem("hub-camera");
function normalizeCamera(mode) {
  const camera = cameraModes.includes(mode) ? mode : "hub";
  return desktopCameraQuery.matches && camera === "wide" ? "hub" : camera;
}
let cameraTarget = normalizeCamera(cameraRoom.dataset.camera);
let cameraTransitionId = 0;
let cameraExitTimer = null;
let cameraEnterTimer = null;
const cameraFocusArt = $(".control-room-art-focus");
const cameraWideArt = $(".control-room-art-wide");
const sceneSwapArt = $("#scene-swap-art");
cameraRoom.classList.add("scene-booting");
// Camera tuples are [objectPositionX, objectPositionY, transformOriginY].
// Desktop X also marks the subject's hand-tuned transform origin. On phones the
// subject is first cropped into the center, so the transform origin stays at 50%.
// Zoom belongs to the artwork rather than the camera, keeping scale stable while
// switching between zxc, hub, and aiasio.
const sceneDeck = [
  { id: "classic", title: "Classic", src: "/assets/nacchan-control-room.webp", zoom: 1.18, mobileZoom: 1.05, zxc: [29,24,35], hub: [51,65,60], aiasio: [73,26,35], mobileZxc: [15,50,44], mobileHub: [51,64,58], mobileAiasio: [88,50,44] },
  { id: "neon", title: "Neon City", src: "/assets/nacchan-neon.webp", zoom: 1.16, mobileZoom: 1.03, zxc: [31,19,35], hub: [50,79,60], aiasio: [69,18,35], mobileZxc: [19,48,44], mobileHub: [50,64,58], mobileAiasio: [82,48,44] },
  { id: "watercolor", title: "Glass Garden", src: "/assets/nacchan-watercolor.webp", zoom: 1.15, mobileZoom: 1.03, zxc: [34,22,35], hub: [51,50,56], aiasio: [72,20,35], mobileZxc: [23,47,44], mobileHub: [52,51,56], mobileAiasio: [87,47,44] },
  { id: "celestial", title: "Moon Atelier", src: "/assets/nacchan-celestial.webp", zoom: 1.20, mobileZoom: 1.05, zxc: [31,30,35], hub: [50,29,52], aiasio: [70,24,35], mobileZxc: [19,50,44], mobileHub: [50,48,54], mobileAiasio: [84,50,44] },
  { id: "kawaii", title: "After School", src: "/assets/nacchan-kawaii.webp", zoom: 1.10, mobileZoom: 1.00, zxc: [28,35,36], hub: [51,70,60], aiasio: [73,35,36], mobileZxc: [13,49,45], mobileHub: [51,64,58], mobileAiasio: [88,49,45] },
  { id: "retro", title: "Orbit '89", src: "/assets/nacchan-retro.webp", zoom: 1.16, mobileZoom: 1.03, zxc: [29,19,35], hub: [51,72,60], aiasio: [77,21,35], mobileZxc: [15,48,44], mobileHub: [51,64,58], mobileAiasio: [95,48,44] },
];
const savedScene = localStorage.getItem("hub-scene");
let sceneIndex = Math.max(0, sceneDeck.findIndex((scene) => scene.id === savedScene));
let sceneChangeId = 0;
let sceneAutoTimer = null;
function sceneShot(scene, camera = cameraTarget, mobile = !desktopCameraQuery.matches) {
  if (camera === "wide") return { position: "center", origin: "50% 50%", zoom: .985, fit: "contain" };
  const key = `${mobile ? "mobile" : ""}${camera[0].toUpperCase()}${camera.slice(1)}`;
  const shot = scene[key] || scene[camera] || scene.hub;
  return {
    position: `${shot[0]}% ${shot[1]}%`,
    origin: `${mobile ? 50 : shot[0]}% ${shot[2]}%`,
    zoom: mobile ? scene.mobileZoom : scene.zoom,
    fit: "cover",
  };
}
function applySceneVariables(scene) {
  const mappings = { zxc: scene.zxc, hub: scene.hub, aiasio: scene.aiasio, mobileZxc: scene.mobileZxc, mobileHub: scene.mobileHub, mobileAiasio: scene.mobileAiasio };
  for (const [key, shot] of Object.entries(mappings)) {
    const prefix = key.startsWith("mobile") ? `--scene-mobile-${key.slice(6).toLowerCase()}` : `--scene-${key}`;
    cameraRoom.style.setProperty(`${prefix}-x`, `${shot[0]}%`);
    cameraRoom.style.setProperty(`${prefix}-y`, `${shot[1]}%`);
    cameraRoom.style.setProperty(`${prefix}-zoom`, key.startsWith("mobile") ? scene.mobileZoom : scene.zoom);
    cameraRoom.style.setProperty(`${prefix}-origin-x`, `${key.startsWith("mobile") ? 50 : shot[0]}%`);
    cameraRoom.style.setProperty(`${prefix}-origin-y`, `${shot[2]}%`);
  }
  cameraRoom.style.setProperty("--scene-image", `url("${scene.src}")`);
  cameraRoom.dataset.scene = scene.id;
}
function updateSceneDeck(scene) {
  $("#scene-title").textContent = scene.title;
  $("#scene-count").textContent = `${sceneIndex + 1} / ${sceneDeck.length}`;
}
function preloadScene(index) {
  const image = new Image();
  image.src = sceneDeck[(index + sceneDeck.length) % sceneDeck.length].src;
}
async function selectScene(index, { manual = false, instant = false } = {}) {
  const nextIndex = (index + sceneDeck.length) % sceneDeck.length;
  const scene = sceneDeck[nextIndex];
  const changeId = ++sceneChangeId;
  const preload = new Image();
  preload.src = scene.src;
  try { await preload.decode(); } catch {
    if (instant) cameraRoom.classList.remove("scene-booting");
    return;
  }
  if (changeId !== sceneChangeId) return;
  sceneIndex = nextIndex;
  localStorage.setItem("hub-scene", scene.id);
  updateSceneDeck(scene);
  if (instant || !sceneSwapArt) {
    cameraWideArt.src = scene.src;
    cameraWideArt.alt = `Anime control room artwork: ${scene.title}`;
    cameraFocusArt.src = scene.src;
    applySceneVariables(scene);
    requestAnimationFrame(() => requestAnimationFrame(() => cameraRoom.classList.remove("scene-booting")));
  } else {
    const shot = sceneShot(scene);
    sceneSwapArt.classList.remove("visible");
    sceneSwapArt.style.transition = "none";
    sceneSwapArt.src = scene.src;
    sceneSwapArt.style.objectFit = shot.fit;
    sceneSwapArt.style.objectPosition = shot.position;
    sceneSwapArt.style.transformOrigin = shot.origin;
    sceneSwapArt.style.transform = `scale(${shot.zoom})`;
    sceneSwapArt.style.translate = "0px 0px";
    sceneSwapArt.style.rotate = "0deg";
    cameraRoom.classList.add("scene-changing");
    void sceneSwapArt.offsetWidth;
    sceneSwapArt.style.removeProperty("transition");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (changeId !== sceneChangeId) return;
    sceneSwapArt.classList.add("visible");
    await new Promise((resolve) => setTimeout(resolve, 480));
    if (changeId !== sceneChangeId) return;
    cameraWideArt.src = scene.src;
    cameraWideArt.alt = `Anime control room artwork: ${scene.title}`;
    cameraFocusArt.src = scene.src;
    applySceneVariables(scene);
    void cameraFocusArt.offsetWidth;
    sceneSwapArt.classList.remove("visible");
    setTimeout(() => {
      if (changeId !== sceneChangeId) return;
      sceneSwapArt.removeAttribute("src");
      sceneSwapArt.style.removeProperty("object-fit");
      sceneSwapArt.style.removeProperty("object-position");
      sceneSwapArt.style.removeProperty("transform-origin");
      sceneSwapArt.style.removeProperty("transform");
      sceneSwapArt.style.removeProperty("translate");
      sceneSwapArt.style.removeProperty("rotate");
      cameraRoom.classList.remove("scene-changing");
    }, 480);
  }
  preloadScene(sceneIndex + 1);
  if (manual) scheduleSceneRotation();
}
function scheduleSceneRotation() {
  clearTimeout(sceneAutoTimer);
  sceneAutoTimer = setTimeout(() => {
    if (!document.hidden && document.body.dataset.theme === "anime" && !cameraRoom.classList.contains("camera-transitioning")) {
      selectScene(sceneIndex + 1).catch(() => {});
    }
    scheduleSceneRotation();
  }, 150_000);
}
applySceneVariables(sceneDeck[sceneIndex]);
updateSceneDeck(sceneDeck[sceneIndex]);
selectScene(sceneIndex, { instant: true }).catch(() => {});
$("#scene-prev").addEventListener("click", () => selectScene(sceneIndex - 1, { manual: true }));
$("#scene-next").addEventListener("click", () => selectScene(sceneIndex + 1, { manual: true }));
scheduleSceneRotation();
function freezeCameraPose() {
  if (!cameraFocusArt) return;
  const pose = getComputedStyle(cameraFocusArt);
  const translate = pose.translate;
  const rotate = pose.rotate;
  cameraFocusArt.style.animation = "none";
  cameraFocusArt.style.translate = translate === "none" ? "0px 0px" : translate;
  cameraFocusArt.style.rotate = rotate === "none" ? "0deg" : rotate;
  void cameraFocusArt.offsetWidth;
}
function settleCameraPose() {
  if (!cameraFocusArt) return;
  requestAnimationFrame(() => {
    cameraFocusArt.style.translate = "0px 0px";
    cameraFocusArt.style.rotate = "0deg";
  });
}
function releaseCameraPose() {
  if (!cameraFocusArt) return;
  cameraFocusArt.style.removeProperty("animation");
  cameraFocusArt.style.removeProperty("translate");
  cameraFocusArt.style.removeProperty("rotate");
}
function clearCameraPhases({ preservePose = false } = {}) {
  clearTimeout(cameraExitTimer);
  clearTimeout(cameraEnterTimer);
  cameraRoom.classList.remove("camera-exiting", "camera-entering", "camera-transitioning");
  for (const actor of ["zxc", "aiasio", "relay"]) {
    cameraRoom.classList.remove(`exit-${actor}`, `enter-${actor}`, `hold-${actor}`);
  }
  delete cameraRoom.dataset.cameraNext;
  delete cameraRoom.dataset.cameraFrom;
  if (!preservePose) releaseCameraPose();
}
function applyCamera(mode, { focus = false, manual = false, temporary = false } = {}) {
  const camera = normalizeCamera(mode);
  const alreadyTargeted = cameraTarget === camera;
  if (manual) {
    lastManualCameraAt = Date.now();
    appliedHostCameraAction = null;
    hostCameraRestore = null;
  }
  if (!temporary) localStorage.setItem("hub-camera", camera);
  document.querySelectorAll("[data-camera-choice]").forEach((button) => {
    const active = button.dataset.cameraChoice === camera;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    if (active && focus) button.focus();
  });
  if (alreadyTargeted) return;
  const current = cameraRoom.dataset.camera;
  const outgoing = cameraActors[current].filter((actor) => !cameraActors[camera].includes(actor));
  const incoming = cameraActors[camera].filter((actor) => !cameraActors[current].includes(actor));
  cameraTarget = camera;
  const transitionId = ++cameraTransitionId;
  freezeCameraPose();
  clearCameraPhases({ preservePose: true });
  cameraRoom.dataset.cameraFrom = current;
  cameraRoom.dataset.cameraNext = camera;
  cameraRoom.classList.add("camera-transitioning");
  for (const actor of outgoing) cameraRoom.classList.add(`exit-${actor}`);
  for (const actor of incoming) cameraRoom.classList.add(`hold-${actor}`);
  if (outgoing.length) {
    cameraRoom.classList.add("camera-exiting");
  }
  const cameraExitDelay = outgoing.length ? 260 : 0;
  cameraRoom.dataset.camera = camera;
  void cameraRoom.offsetWidth;
  settleCameraPose();
  cameraExitTimer = setTimeout(() => {
    if (transitionId !== cameraTransitionId) return;
    for (const actor of incoming) {
      cameraRoom.classList.add(`enter-${actor}`);
      if (actor !== "relay") {
        $(`#scene-${actor}-speech`)?.classList.remove("speech-updated");
        $(`#scene-${actor}-status`)?.classList.remove("status-updated");
      }
    }
    if (incoming.length) cameraRoom.classList.add("camera-entering");
    for (const actor of incoming) cameraRoom.classList.remove(`hold-${actor}`);
    cameraRoom.classList.remove("camera-exiting");
    for (const actor of outgoing) cameraRoom.classList.remove(`exit-${actor}`);
    delete cameraRoom.dataset.cameraNext;
    cameraEnterTimer = setTimeout(() => {
      if (transitionId !== cameraTransitionId) return;
      clearCameraPhases();
    }, Math.max(0, 760 - cameraExitDelay));
  }, cameraExitDelay);
}
function shiftCamera(direction, focus = false, modes = cameraModes, manual = false) {
  const current = modes.indexOf(cameraTarget);
  if (current >= 0) {
    const next = (current + direction + modes.length) % modes.length;
    applyCamera(modes[next], { focus, manual });
    return;
  }
  let index = cameraModes.indexOf(cameraTarget);
  for (let step = 0; step < cameraModes.length; step += 1) {
    index = (index + direction + cameraModes.length) % cameraModes.length;
    if (modes.includes(cameraModes[index])) {
      applyCamera(cameraModes[index], { focus, manual });
      return;
    }
  }
}
document.querySelectorAll("[data-camera-choice]").forEach((button) => {
  button.addEventListener("click", () => applyCamera(button.dataset.cameraChoice, { manual: true }));
});
const cameraDock = $(".camera-dock");
cameraDock.addEventListener("keydown", (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  shiftCamera(event.key === "ArrowRight" ? 1 : -1, true, cameraButtonModes, true);
});
desktopCameraQuery.addEventListener("change", (event) => {
  if (event.matches && cameraTarget === "wide") applyCamera("hub");
});
let cameraPointer = null;
let cameraSwiped = false;
cameraRoom.addEventListener("pointerdown", (event) => {
  cameraSwiped = false;
  if (!["touch", "pen"].includes(event.pointerType) || event.target.closest(".camera-dock,.scene-deck")) {
    cameraPointer = null;
    return;
  }
  cameraPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
cameraRoom.addEventListener("pointerup", (event) => {
  if (!cameraPointer || cameraPointer.id !== event.pointerId) return;
  const dx = event.clientX - cameraPointer.x;
  const dy = event.clientY - cameraPointer.y;
  cameraPointer = null;
  if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
  cameraSwiped = true;
  event.preventDefault();
  shiftCamera(dx < 0 ? 1 : -1, false, cameraModes, true);
});
cameraRoom.addEventListener("pointercancel", () => { cameraPointer = null; });
cameraRoom.addEventListener("click", (event) => {
  if (!cameraSwiped) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  cameraSwiped = false;
}, true);
cameraRoom.addEventListener("click", (event) => {
  if (document.body.dataset.theme !== "anime" || !["zxc", "aiasio"].includes(cameraTarget)) return;
  if (event.defaultPrevented || event.target.closest(".operator-card,.camera-dock,.scene-deck")) return;
  const bounds = cameraRoom.getBoundingClientRect();
  const horizontalPosition = (event.clientX - bounds.left) / bounds.width;
  if (horizontalPosition >= 0.32 && horizontalPosition <= 0.68) applyCamera("hub", { manual: true });
});
applyCamera(savedCamera);

for (const name of ["zxc", "aiasio"]) {
  const card = $(`#scene-${name}`);
  card.setAttribute("tabindex", "0");
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Hear a reaction from ${operatorName(name)}`);
  const react = () => {
    if (document.body.dataset.theme === "anime") applyCamera(name, { manual: true });
    const instance = state?.instances?.[name];
    const unavailable = !instance?.connected || instance.rateLimitTelemetry?.state === "auth-required";
    if (!unavailable) {
      quipIndex[name] = (quipIndex[name] + 1) % operatorQuips[name].length;
      manualQuipUntil[name] = Date.now() + 8_000;
      updateSceneText(`#scene-${name}-speech`, operatorQuips[name][quipIndex[name]], "speech-updated");
    }
    card.classList.remove("boop");
    requestAnimationFrame(() => card.classList.add("boop"));
  };
  card.addEventListener("click", react);
  card.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); react(); } });
}
const relayStage = $(".relay-stage");
relayStage.setAttribute("tabindex", "0");
relayStage.setAttribute("role", "button");
relayStage.setAttribute("aria-label", "Launch a relay sparkle burst");
function launchRelayBurst() {
  const room = $(".control-room");
  if (document.body.dataset.theme === "anime") applyCamera("hub", { manual: true });
  for (let index = 1; index <= 8; index += 1) {
    const spark = document.createElement("i");
    spark.className = `relay-spark spark-${index}`;
    spark.textContent = index % 3 === 0 ? "♡" : index % 2 ? "✦" : "•";
    room.append(spark);
    setTimeout(() => spark.remove(), 1_100);
  }
  relayStage.classList.remove("boop");
  requestAnimationFrame(() => relayStage.classList.add("boop"));
}
relayStage.addEventListener("click", launchRelayBurst);
relayStage.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); launchRelayBurst(); } });

async function refreshLoop() {
  await refresh();
  setTimeout(refreshLoop, document.hidden ? 10_000 : 2_500);
}

async function markViewerPresence() {
  if (document.hidden) return;
  try {
    await fetch("/api/presence", { method: "POST", cache: "no-store" });
  } catch {}
}

addEventListener("resize", positionHostCallouts);
addEventListener("scroll", positionHostCallouts, true);
setInterval(markViewerPresence, 30_000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    markViewerPresence();
    refresh();
    if (timelinePanelVisible && !timelineAutoUnreadId) markCurrentTimelineSeen();
    visibleQuotaKeys.forEach(scheduleQuotaReveal);
  } else {
    quotaRevealTimers.forEach((_, key) => clearQuotaRevealTimer(key));
  }
});

await markViewerPresence();
await refreshLoop();
