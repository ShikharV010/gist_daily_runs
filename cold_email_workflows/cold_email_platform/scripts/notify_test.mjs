// Fires a fake LEAD_INTERESTED webhook so you can verify the new-row chime
// and tab-title flash on the live dashboard.
//
// Usage:
//   node scripts/notify_test.mjs                    # hits prod
//   node scripts/notify_test.mjs http://localhost:3000   # hits local

const BASE = process.argv[2] || "https://cold-email-platform-phi.vercel.app";

const uniq = Math.floor(Date.now() / 1000);
const payload = {
  event: { type: "LEAD_INTERESTED" },
  data: {
    reply: {
      id: uniq,
      uuid: `notif-test-${uniq}`,
      date_received: new Date().toISOString(),
    },
    lead: {
      id: uniq,
      email: `notif.test+${uniq}@example.com`,
      first_name: "Notif",
      last_name: "Test",
      company: "Test Co",
      custom_variables: [
        { name: "phone number", value: "+18315559900" },
      ],
    },
    campaign: { id: 1 },
  },
};

const res = await fetch(`${BASE}/api/webhooks/sequencer`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.log(`${res.status}`, await res.text());
