// Browser-side notifications. Sound + native Notification.

let audioCtx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioCtx) return audioCtx;
  const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = W.AudioContext || W.webkitAudioContext;
  if (!Ctor) return null;
  audioCtx = new Ctor();
  return audioCtx;
}

/** Play a short two-tone chime. No asset file needed. */
export function chime(): void {
  const ctx = getCtx();
  if (!ctx) return;
  // Some browsers suspend audio until a user gesture; resume just in case.
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const tones = [
    { freq: 880, start: 0, duration: 0.12 },   // A5
    { freq: 1318, start: 0.13, duration: 0.18 }, // E6
  ];
  const now = ctx.currentTime;
  for (const t of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = t.freq;
    gain.gain.setValueAtTime(0, now + t.start);
    gain.gain.linearRampToValueAtTime(0.18, now + t.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + t.start);
    osc.stop(now + t.start + t.duration + 0.02);
  }
}

export function ensureNotifPermission(): void {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

export function notifyNewLead(opts: { name: string; company?: string | null }): void {
  if (typeof window === "undefined") return;
  chime();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = "New positive reply";
  const body = opts.company ? `${opts.name} · ${opts.company}` : opts.name;
  try {
    const n = new Notification(title, {
      body,
      icon: "/gushwork-logo.svg",
      tag: "icep-new-lead",
    });
    // Auto-close after 6s
    setTimeout(() => n.close(), 6000);
    n.onclick = () => window.focus();
  } catch {
    // ignore
  }
}
