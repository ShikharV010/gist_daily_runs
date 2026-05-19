// Client-safe types and constants. Importable from both server routes and
// client components without pulling server-only deps (pg, node:fs, etc.).

export type PhoneSource = "native" | "enrichment" | "website" | null;

export type DialerRow = {
  id: string;
  external_id: string;
  name: string | null;
  company: string | null;
  website: string | null;
  email: string;
  phone: string | null;
  phone_source: PhoneSource;
  sequencer_thread_url: string | null;
  reply_at: string;
  call_at: string | null;
  call_within_5min: boolean | null;
  enrichment_status: string;
};

export type ReminderStatus =
  | "Not yet dialed"
  | "Confirmed"
  | "Cancelled"
  | "Rescheduled"
  | "Not Connected";

export const REMINDER_STATUS_OPTIONS: ReminderStatus[] = [
  "Not yet dialed",
  "Confirmed",
  "Cancelled",
  "Rescheduled",
  "Not Connected",
];

export type AnalyticsBucket = {
  bucket: string;
  calls_within_5min: number;
  bookings_from_calls: number;
};

export type AnalyticsResponse = {
  tz: "IST" | "EST";
  totals: {
    calls_within_5min: number;
    bookings_from_calls: number;
    total_dialer_rows: number;
  };
  by_day: AnalyticsBucket[];
  by_week: AnalyticsBucket[];
};

export type ReminderRow = {
  id: string;
  external_id: string;
  name: string | null;
  company: string | null;
  website: string | null;
  email: string;
  phone: string | null;
  phone_source: PhoneSource;
  sequencer_thread_url: string | null;
  reply_at: string | null;
  demo_at: string;
  source: string;
  call_at: string | null;
  status: ReminderStatus | null;
  enrichment_status: string;
};
