import { randomBytes } from "crypto";
import { logger as _logger } from "../../lib/logger";
import { supabase_rr_service, supabase_service } from "../supabase";

const logger = _logger.child({ module: "monitor-email-recipients" });

export type MonitorEmailRecipientStatus =
  | "pending"
  | "confirmed"
  | "unsubscribed";

export type MonitorEmailRecipientSource = "team" | "opt_in" | "legacy";

export type MonitorEmailRecipientRow = {
  id: string;
  monitor_id: string;
  team_id: string;
  email: string;
  status: MonitorEmailRecipientStatus;
  token: string;
  source: MonitorEmailRecipientSource;
  confirmation_sent_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  last_notified_at: string | null;
  created_at: string;
  updated_at: string;
};

export function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

// 32 bytes of entropy, base64url-encoded (43 chars, URL safe, no padding).
// Plenty of bits to make tokens unguessable and unique without UUID overhead.
export function generateRecipientToken(): string {
  return randomBytes(32).toString("base64url");
}

function throwIfError(error: any, message: string): void {
  if (error) {
    throw new Error(`${message}: ${error.message ?? JSON.stringify(error)}`);
  }
}

export async function listMonitorEmailRecipients(
  monitorId: string,
): Promise<MonitorEmailRecipientRow[]> {
  const { data, error } = await supabase_rr_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("monitor_id", monitorId);

  throwIfError(error, "Failed to list monitor email recipients");
  return (data ?? []) as MonitorEmailRecipientRow[];
}

export async function getRecipientByToken(
  token: string,
): Promise<MonitorEmailRecipientRow | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase_rr_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("token", trimmed)
    .maybeSingle();

  throwIfError(error, "Failed to look up monitor email recipient by token");
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

/**
 * Look up the monitor name for a given monitor id. Used by the email opt-in
 * controllers so the public confirmation/unsubscribe pages can show the
 * recipient which monitor they're acting on.
 */
export async function getMonitorNameById(
  monitorId: string,
): Promise<string | null> {
  const { data, error } = await supabase_rr_service
    .from("monitors")
    .select("name")
    .eq("id", monitorId)
    .maybeSingle();

  if (error) {
    logger.warn("Failed to load monitor name for opt-in response", {
      error,
      monitorId,
    });
    return null;
  }
  return (data?.name as string | undefined) ?? null;
}

/**
 * Look up which of the given emails are members of the monitor's team. Members
 * are auto-confirmed because they already have dashboard access to this
 * monitor; requiring them to click an opt-in link would be pure friction.
 */
export async function getTeamMemberEmails(
  teamId: string,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();

  const { data, error } = await supabase_rr_service
    .from("user_teams")
    .select("users(email)")
    .eq("team_id", teamId);

  if (error) {
    logger.warn("Failed to load team member emails for recipient sync", {
      error,
      teamId,
    });
    return new Set();
  }

  const wanted = new Set(emails.map(normalizeRecipientEmail));
  const matches = new Set<string>();
  for (const row of data ?? []) {
    const email = (row as any).users?.email;
    if (typeof email === "string") {
      const normalized = normalizeRecipientEmail(email);
      if (wanted.has(normalized)) matches.add(normalized);
    }
  }
  return matches;
}

export type RecipientUpsertInput = {
  email: string;
  source: MonitorEmailRecipientSource;
  status: MonitorEmailRecipientStatus;
};

export type RecipientUpsertResult = {
  row: MonitorEmailRecipientRow;
  created: boolean;
};

/**
 * Idempotently create a recipient row. If a row already exists for
 * (monitor_id, email):
 *   - returns the existing row unchanged (so an opt-out is honored even if
 *     the monitor is edited and the email re-added)
 *   - records `created = false`
 *
 * If the row is new, the caller should send a confirmation email when the
 * status is `pending`.
 */
export async function ensureMonitorEmailRecipient(params: {
  monitorId: string;
  teamId: string;
  input: RecipientUpsertInput;
}): Promise<RecipientUpsertResult> {
  const email = normalizeRecipientEmail(params.input.email);

  const existing = await supabase_rr_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("monitor_id", params.monitorId)
    .eq("email", email)
    .maybeSingle();

  throwIfError(existing.error, "Failed to look up monitor email recipient");
  if (existing.data) {
    return {
      row: existing.data as MonitorEmailRecipientRow,
      created: false,
    };
  }

  const now = new Date().toISOString();
  const token = generateRecipientToken();
  const insert = {
    monitor_id: params.monitorId,
    team_id: params.teamId,
    email,
    status: params.input.status,
    token,
    source: params.input.source,
    confirmation_sent_at: params.input.status === "pending" ? now : null,
    confirmed_at: params.input.status === "confirmed" ? now : null,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .insert(insert)
    .select("*")
    .single();

  throwIfError(error, "Failed to insert monitor email recipient");
  return { row: data as MonitorEmailRecipientRow, created: true };
}

export async function markRecipientConfirmationSent(
  id: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ confirmation_sent_at: now, updated_at: now })
    .eq("id", id);

  throwIfError(error, "Failed to mark recipient confirmation sent");
}

export async function confirmRecipientByToken(
  token: string,
): Promise<MonitorEmailRecipientRow | null> {
  const row = await getRecipientByToken(token);
  if (!row) return null;
  if (row.status === "confirmed") return row;

  // Once a recipient unsubscribes we treat that as permanent — re-confirming
  // would let a malicious actor effectively re-subscribe someone after they
  // opted out. They have to be re-added to a monitor manually, which sends a
  // fresh confirmation email.
  if (row.status === "unsubscribed") return row;

  const now = new Date().toISOString();
  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ status: "confirmed", confirmed_at: now, updated_at: now })
    .eq("id", row.id)
    .select("*")
    .single();

  throwIfError(error, "Failed to confirm monitor email recipient");
  return data as MonitorEmailRecipientRow;
}

export async function unsubscribeRecipientByToken(
  token: string,
): Promise<MonitorEmailRecipientRow | null> {
  const row = await getRecipientByToken(token);
  if (!row) return null;
  if (row.status === "unsubscribed") return row;

  const now = new Date().toISOString();
  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ status: "unsubscribed", unsubscribed_at: now, updated_at: now })
    .eq("id", row.id)
    .select("*")
    .single();

  throwIfError(error, "Failed to unsubscribe monitor email recipient");
  return data as MonitorEmailRecipientRow;
}

export async function touchRecipientsNotified(
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ last_notified_at: now, updated_at: now })
    .in("id", ids);

  if (error) {
    logger.warn("Failed to update last_notified_at on recipients", {
      error,
      ids,
    });
  }
}
