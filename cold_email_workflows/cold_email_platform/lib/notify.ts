// Browser-side new-row alerts: sound + native Notification + title flash.

let audioEl: HTMLAudioElement | null = null;
let unlocked = false;

function getAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (audioEl) return audioEl;
  audioEl = new Audio("/chime.wav");
  audioEl.preload = "auto";
  audioEl.volume = 0.6;
  // Try to load immediately so first play is instant.
  audioEl.load();
  return audioEl;
}

/** Pre-create the audio element and attach a one-time gesture handler that
 *  "unlocks" autoplay for the rest of the session. */
export function preloadChime(): void {
  if (typeof window === "undefined") return;
  getAudio();
  if (unlocked) return;
  const unlock = () => {
    const a = getAudio();
    if (!a) return;
    a.muted = true;
    a.play()
      .then(() => {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
        unlocked = true;
      })
      .catch(() => {
        a.muted = false;
      });
    window.removeEventListener("click", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("touchstart", unlock);
  };
  window.addEventListener("click", unlock);
  window.addEventListener("keydown", unlock);
  window.addEventListener("touchstart", unlock);
}

/** Play the chime. Returns the play() promise so callers can await/inspect. */
export function chime(): Promise<void> | void {
  const a = getAudio();
  if (!a) return;
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        // Most common: browser rejected autoplay. Will succeed after first user
        // gesture (the unlock above handles this for non-test plays).
        console.warn("[chime] play blocked:", err?.message || err);
      });
      return p as Promise<void>;
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

export function notifyNewLead(opts: { name: string; company?: string | null }): void {
  if (typeof window === "undefined") return;
  chime();
  flashCount += 1;
  startTitleFlash();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = "New positive reply";
  const body = opts.company ? `${opts.name} · ${opts.company}` : opts.name;
  try {
    const n = new Notification(title, {
      body,
      icon: "/gushwork-icon.svg",
      tag: "icep-new-lead",
    });
    setTimeout(() => n.close(), 6000);
    n.onclick = () => window.focus();
  } catch {
    // ignore
  }
}
