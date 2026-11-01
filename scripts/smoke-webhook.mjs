const base = (process.env.TASB_URL ?? "http://127.0.0.1:8787").replace(
  /\/$/,
  "",
);
const secret = process.env.WEBHOOK_SECRET ?? "";
const text = "hello from smoke";

if (secret.length === 0) {
  console.error("WEBHOOK_SECRET is required");
  process.exit(1);
}

const healthResponse = await fetch(`${base}/health`);
const healthRaw = await healthResponse.text();
const health = JSON.parse(healthRaw);
if (
  healthResponse.status !== 200 ||
  health.ok !== true ||
  health.service !== "tasb"
) {
  console.error(`health failed: ${healthResponse.status}`);
  process.exit(1);
}

const webhook = `${base}/telegram/webhook`;
const update = {
  update_id: 1,
  message: {
    message_id: 10,
    date: 1761955200,
    chat: { id: -100123, type: "supergroup", title: "demo" },
    from: { id: 42, is_bot: false, first_name: "Ada" },
    text,
  },
};

const denied = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(update),
});
if (denied.status !== 401) {
  console.error(`expected 401 without secret, got ${denied.status}`);
  process.exit(1);
}

const accepted = await fetch(webhook, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-telegram-bot-api-secret-token": secret,
  },
  body: JSON.stringify(update),
});
const acceptedRaw = await accepted.text();
if (acceptedRaw.includes(text) || acceptedRaw.includes(secret)) {
  console.error("webhook response leaked input");
  process.exit(1);
}
const body = JSON.parse(acceptedRaw);
if (accepted.status !== 200 || body.ok !== true || body.ignored === true) {
  console.error(`webhook failed: ${accepted.status}`);
  process.exit(1);
}

console.log(
  `smoke ok health=${health.deploymentMode ?? "unknown"} webhook=200`,
);
