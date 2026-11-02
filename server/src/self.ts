import { config } from "./config.js";
import { db } from "./db.js";
import { createKey, getTenant, upsertTenant } from "./tenants.js";

/** mux calling its own gateway, as the Assistant tenant: the assistant, its test requests and the brain's embeddings. */
export const gateway = `http://127.0.0.1:${config.port}`;

/** The Assistant tenant's own key: what the assistant sends through the gateway is metered like anyone's. */
export function assistantKey(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'assistant_key'").get() as { value: string } | undefined;
  if (row && getTenant("assistant")) return JSON.parse(row.value);
  if (!getTenant("assistant")) upsertTenant({ id: "assistant", name: "Assistant", description: "The dashboard's assistant and its test requests", color: "#a855f7" });
  const { key } = createKey("assistant", "dashboard");
  db.prepare("INSERT INTO settings(key, value) VALUES('assistant_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(key));
  return key;
}
