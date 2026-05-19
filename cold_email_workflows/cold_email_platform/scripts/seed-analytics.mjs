// Seeds one dialer row + one Meeting-Booked call, so the Analytics tab has
// something to display. Run: node scripts/seed-analytics.mjs

const BASE = "http://localhost:3000";

const phone = "+919999900011";
const replyAt = "2026-05-19T10:00:00Z";
const callAt = "2026-05-19T10:02:00Z"; // 2 min after reply -> within 5 min

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  console.log(`${path} -> ${res.status}`);
  console.log(txt);
}

await post("/api/webhooks/sequencer", {
  event: { type: "LEAD_INTERESTED" },
  data: {
    reply: { id: 11, uuid: "u-11", date_received: replyAt },
    lead: {
      id: 11,
      email: "a@test.com",
      first_name: "A",
      custom_variables: [{ name: "phone number", value: phone }],
    },
    campaign: { id: 1 },
  },
});

await post("/api/webhooks/justcall", {
  event_type: "call_completed",
  data: {
    direction: "Outbound",
    datetime: callAt,
    contact_number: phone,
    disposition: "Meeting Booked",
  },
});
