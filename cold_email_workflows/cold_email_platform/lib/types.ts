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
  call_attempts: number;
  call_disposition: string | null;
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
  call_attempts: number;
  call_disposition: string | null;
  status: ReminderStatus | null;
  enrichment_status: string;
};

export type AnalyticsBucket = {
  bucket: string;
  calls_within_5min: number;
  calls_outside_5min: number;
  bookings_within_5min: number;
  bookings_outside_5min: number;
};

export type AnalyticsResponse = {
  tz: "IST" | "EST";
  totals: {
    total_dialer_rows: number;
    total_calls: number;
    calls_within_5min: number;
    calls_outside_5min: number;
    bookings_within_5min: number;
    bookings_outside_5min: number;
  };
  by_day: AnalyticsBucket[];
  by_week: AnalyticsBucket[];
};
