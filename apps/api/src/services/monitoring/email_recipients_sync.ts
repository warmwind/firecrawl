import { logger as _logger } from "../../lib/logger";
import { sendMonitoringConfirmationEmail } from "../notification/monitoring_email";
import {
  ensureMonitorEmailRecipient,
  getTeamMemberEmails,
  listMonitorEmailRecipients,
  normalizeRecipientEmail,
  type MonitorEmailRecipientRow,
} from "./email_recipients";
import type { MonitorRow } from "./types";

const logger = _logger.child({ module: "monitor-email-recipients-sync" });

export type SyncedRecipient = {
  email: string;
  status: MonitorEmailRecipientRow["status"];
  source: MonitorEmailRecipientRow["source"];
  confirmationEmailSent: boolean;
  /** True if this row was created during this sync (vs. already existed). */
  created: boolean;
};

export type SyncResult = {
  recipients: SyncedRecipient[];
};

/**
 * Reconcile the canonical list of `notification.email.recipients` for a
 * monitor against the per-recipient subscription table.
 *
 * Rules:
 * - Team-member emails are auto-confirmed (they already have dashboard access
 *   to this monitor; making them click an opt-in link would be pure friction).
 * - All other newly added emails start in `pending` and receive a one-time
 *   confirmation email. They will not receive monitor alerts until they click
 *   the confirm link.
 * - Existing rows are left alone — once a recipient confirms or unsubscribes
 *   that decision persists even if the monitor is edited and the recipient
 *   is re-added.
 *
 * Recipients that were previously configured but are no longer in the list
 * are not deleted; we keep the row so that a quick "remove then re-add"
 * doesn't accidentally re-send a confirmation email to someone who already
 * confirmed (or worse, undo an unsubscribe).
 */
export async function syncMonitorEmailRecipients(params: {
  monitor: MonitorRow;
}): Promise<SyncResult> {
  const configured = params.monitor.notification?.email?.recipients ?? [];
  const normalized = Array.from(
    new Set(
      configured
        .map(normalizeRecipientEmail)
        .filter(email => email.length > 0),
    ),
  );

  if (normalized.length === 0) {
    return { recipients: [] };
  }

  const [existingRows, teamMatches] = await Promise.all([
    listMonitorEmailRecipients(params.monitor.id),
    getTeamMemberEmails(params.monitor.team_id, normalized),
  ]);
  const existingByEmail = new Map(existingRows.map(r => [r.email, r]));

  const results: SyncedRecipient[] = [];

  for (const email of normalized) {
    const existing = existingByEmail.get(email);
    if (existing) {
      results.push({
        email: existing.email,
        status: existing.status,
        source: existing.source,
        confirmationEmailSent: existing.confirmation_sent_at !== null,
        created: false,
      });
      continue;
    }

    const isTeamMember = teamMatches.has(email);
    const { row, created } = await ensureMonitorEmailRecipient({
      monitorId: params.monitor.id,
      teamId: params.monitor.team_id,
      input: {
        email,
        source: isTeamMember ? "team" : "opt_in",
        status: isTeamMember ? "confirmed" : "pending",
      },
    });

    let confirmationEmailSent = false;
    if (created && !isTeamMember && row.status === "pending") {
      const sendResult = await sendMonitoringConfirmationEmail({
        recipient: row,
        monitorName: params.monitor.name,
      }).catch(error => {
        logger.warn("Confirmation email send threw", {
          error,
          recipientId: row.id,
          monitorId: params.monitor.id,
        });
        return { attempted: true, success: false } as const;
      });
      confirmationEmailSent = sendResult.attempted && sendResult.success;
    }

    results.push({
      email: row.email,
      status: row.status,
      source: row.source,
      confirmationEmailSent,
      created,
    });
  }

  return { recipients: results };
}
