// Browser-side new-row alerts: sound + native Notification + title flash.

// We keep a small pool of pre-loaded Audio elements so overlapping chimes
// don't cancel each other (the browser restarts a single element if you call
// .play() while it's already playing).
const POOL_SIZE = 5;
let pool: HTMLAudioElement[] = [];
let poolIdx = 0;
let unlocked = false;

function buildPool(): HTMLAudioElement[] {
  if (typeof window === "undefined") return [];
  if (pool.length) return pool;
  for (let i = 0; i < POOL_SIZE; i++) {
    const a = new Audio("/chime.wav");
    a.preload = "auto";
    a.volume = 1.0;
    a.load();
    pool.push(a);
  }
  return pool;
}

/** Pre-create the audio pool and attach a one-time gesture handler that
 *  "unlocks" autoplay for every element in the pool. */
export function preloadChime(): void {
  if (typeof window === "undefined") return;
  buildPool();
  if (unlocked) return;
  const unlock = () => {
    for (const a of buildPool()) {
      a.muted = true;
      a.play()
        .then(() => {
          a.pause();
          a.currentTime = 0;
          a.muted = false;
        })
        .catch(() => {
          a.muted = false;
        });
    }
    unlocked = true;
    window.removeEventListener("click", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("touchstart", unlock);
  };
  window.addEventListener("click", unlock);
  window.addEventListener("keydown", unlock);
  window.addEventListener("touchstart", unlock);
}

/** Play the chime. Uses a round-robin pool so back-to-back calls overlap
 *  rather than cancel each other. */
export function chime(): void {
  const p = buildPool();
  if (p.length === 0) return;
  const a = p[poolIdx % p.length];
  poolIdx++;
  try {
    a.currentTime = 0;
    const r = a.play();
    if (r && typeof r.catch === "function") {
      r.catch((err) => {
        console.warn("[chime] play blocked:", err?.message || err);
      });
    }
  } catch (e) {
    console.warn("[chime] threw:", e);
  }
}

export function ensureNotifPermission(): void {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

// Title flashing: prepend "(N new) " when there are unseen new rows.
let originalTitle: string | null = null;
let flashCount = 0;
let flashTimer: ReturnType<typeof setInterval> | null = null;

function startTitleFlash() {
  if (typeof document === "undefined") return;
  if (originalTitle === null) originalTitle = document.title;
  if (flashTimer) return;
  let on = true;
  flashTimer = setInterval(() => {
    if (typeof document === "undefined") return;
    document.title = on
      ? `(${flashCount} new) ${originalTitle}`
      : (originalTitle as string);
    on = !on;
  }, 1500);

  const stopOnFocus = () => {
    if (flashTimer) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    if (originalTitle !== null) document.title = originalTitle;
    flashCount = 0;
    window.removeEventListener("focus", stopOnFocus);
    document.removeEventListener("visibilitychange", visibilityHandler);
  };
  const visibilityHandler = () => {
    if (document.visibilityState === "visible") stopOnFocus();
  };
  window.addEventListener("focus", stopOnFocus);
  document.addEventListener("visibilitychange", visibilityHandler);
}

let notifCounter = 0;

export function notifyNewLead(opts: { name: string; company?: string | null }): void {
  if (typeof window === "undefined") return;
  chime();
  flashCount += 1;
  startTitleFlash();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = "New positive reply";
  const body = opts.company ? `${opts.name} · ${opts.company}` : opts.name;
  try {
    // Unique tag per call so the browser doesn't collapse rapid notifications
    // into a single visible one.
    const n = new Notification(title, {
      body,
      icon: "/gushwork-icon.svg",
      tag: `icep-new-lead-${++notifCounter}-${Date.now()}`,
    });
    setTimeout(() => n.close(), 6000);
    n.onclick = () => window.focus();
  } catch {
    // ignore
  }
}
