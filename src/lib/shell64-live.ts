import { useEffect, useState } from "react";

// Shell 64 activity, as published by the shared Apps Script (leatr-ash gas/presence.gs).
// Contract: DART-Skyboard/Autumn docs/SHELL64_FEED_CONTRACT.md. Op names and numbers only.
const GAS = "https://script.google.com/macros/s/AKfycbyzkQxLR5miUXP6oDw-1AR1GIjgpzlw9iLw0gO_ZTeLfL849LWbNX7WVz_kf7yLWBKA_w/exec";
export const SHELL64_LIVE_PATH = "ashtree/analytics-live/shell64/live.json";
const POLL_MS = 30000;

export type Shell64Op = { ts: string; op: string; mode: string; detail: string };
export type Shell64Live = {
  totalCalcs: number;
  activeSessions: number;
  calcsPerMin: number;
  lastActivityAt: string | null;
  updatedAt: string | null;
  recent: Shell64Op[];
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function parseShell64Live(body: unknown): Shell64Live | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const raw = b.ok === true && "content" in b ? (b.content as Record<string, unknown>) : b;
  if (!raw || typeof raw !== "object" || raw.schema !== "leatr.shell64.live/1") return null;
  const recent = Array.isArray(raw.recent) ? raw.recent : [];
  return {
    totalCalcs: num(raw.totalCalcs),
    activeSessions: num(raw.activeSessions),
    calcsPerMin: num(raw.calcsPerMin),
    lastActivityAt: typeof raw.lastActivityAt === "string" ? raw.lastActivityAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    recent: recent
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({ ts: String(r.ts ?? ""), op: String(r.op ?? ""), mode: String(r.mode ?? ""), detail: String(r.detail ?? "") }))
      .slice(-10),
  };
}

// The cache-only live summary (no GitHub read) — fresher than live.json for "active now".
function parseActivity(body: unknown): { active: number; calcsPerMin: number; total: number; recent: Shell64Op[] } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return null;
  const recent = Array.isArray(b.recent) ? b.recent : [];
  return {
    active: num(b.active),
    calcsPerMin: num(b.calcsPerMin),
    total: num(b.total),
    recent: recent
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({ ts: new Date(num(r.ts)).toISOString(), op: String(r.op ?? ""), mode: String(r.mode ?? ""), detail: String(r.detail ?? "") })),
  };
}

/** Polls Shell 64 activity every 30 s while `enabled`. `pulse` increments whenever new calculations appear. */
export function useShell64Live(enabled: boolean): { data: Shell64Live | null; pulse: number } {
  const [data, setData] = useState<Shell64Live | null>(null);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer = 0;
    let lastKey = "";
    const poll = async () => {
      if (document.hidden) return schedule();
      try {
        const [liveRes, actRes] = await Promise.all([
          fetch(`${GAS}?action=ashread&path=${encodeURIComponent(SHELL64_LIVE_PATH)}&t=${Date.now()}`, { cache: "no-store" }),
          fetch(`${GAS}?action=shell64activity&t=${Date.now()}`, { cache: "no-store" }),
        ]);
        const live = liveRes.ok ? parseShell64Live(await liveRes.json()) : null;
        const act = actRes.ok ? parseActivity(await actRes.json().catch(() => null)) : null;
        if (cancelled) return;
        if (live || act) {
          const merged: Shell64Live = {
            totalCalcs: Math.max(live?.totalCalcs ?? 0, act?.total ?? 0),
            activeSessions: act ? act.active : (live?.activeSessions ?? 0),
            calcsPerMin: act ? act.calcsPerMin : (live?.calcsPerMin ?? 0),
            lastActivityAt: live?.lastActivityAt ?? null,
            updatedAt: live?.updatedAt ?? null,
            recent: (act && act.recent.length ? act.recent : (live?.recent ?? [])).slice(-10),
          };
          const key = `${merged.totalCalcs}|${merged.recent.length ? merged.recent[merged.recent.length - 1].ts : ""}`;
          if (lastKey && key !== lastKey && (merged.activeSessions > 0 || merged.calcsPerMin > 0)) setPulse((n) => n + 1);
          lastKey = key;
          setData(merged);
        }
      } catch {
        /* keep the last good reading */
      }
      schedule();
    };
    const schedule = () => {
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS + Math.random() * 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled]);
  return { data, pulse };
}

export function formatShell64Ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
