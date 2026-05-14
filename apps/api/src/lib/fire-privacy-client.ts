import { Logger } from "winston";
import { config } from "../config";
import {
  PIIBlock,
  PIIStatus,
  PIISpan,
  RedactPIIOptions,
  type RedactPIIEntity,
} from "../controllers/v2/types";

type FirePrivacyResponse = {
  redacted_text?: unknown;
  spans?: unknown;
  model_status?: unknown;
  model_truncated_at?: unknown;
};

type RedactOptions = {
  text: string;
  url?: string;
  timeoutMs?: number;
  logger?: Logger;
  // Caller-provided config. Boolean form is normalized to a defaults
  // object via the Zod transform before reaching here; an unset value
  // wouldn't trigger this code path at all (transformer skips when
  // meta.options.redactPII is falsy).
  options?: RedactPIIOptions;
};

// Mode + replaceStyle map to fire-privacy's `mode` and `operator` fields.
// Keep both sides in sync if either side changes.
const MODE_MAP = {
  accurate: "model",
  aggressive: "both",
  fast: "heuristics",
} as const;

const REPLACE_MAP = {
  tag: "replace",
  mask: "mask",
  remove: "redact",
} as const;

const DEFAULTS = {
  mode: "accurate",
  replaceStyle: "tag",
  language: "en",
} as const;

// Maps a span's `kind` (as returned by either OPF or Presidio) onto the
// unified entity bucket we expose to callers. Kinds we don't recognize
// fall through unmapped — entity filtering treats them as "not in any
// bucket" and drops them when an entity allowlist is in play.
const KIND_TO_ENTITY: Record<string, RedactPIIEntity> = {
  // Person
  PRIVATE_PERSON: "PERSON",
  PERSON: "PERSON",
  // Email
  PRIVATE_EMAIL: "EMAIL",
  EMAIL_ADDRESS: "EMAIL",
  // Phone
  PRIVATE_PHONE: "PHONE",
  PHONE_NUMBER: "PHONE",
  PHONEIMEI: "PHONE",
  // Location
  PRIVATE_ADDRESS: "LOCATION",
  LOCATION: "LOCATION",
  // Financial
  ACCOUNT_NUMBER: "FINANCIAL",
  CREDIT_CARD: "FINANCIAL",
  IBAN_CODE: "FINANCIAL",
  US_BANK_NUMBER: "FINANCIAL",
  US_SSN: "FINANCIAL",
  US_ITIN: "FINANCIAL",
  CRYPTO: "FINANCIAL",
  // Secret
  SECRET: "SECRET",
  API_KEY: "SECRET",
  PASSWORD: "SECRET",
  US_DRIVER_LICENSE: "SECRET",
  US_PASSPORT: "SECRET",
  MEDICAL_LICENSE: "SECRET",
};

function coerceSpans(value: unknown): PIISpan[] {
  if (!Array.isArray(value)) return [];
  const out: PIISpan[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.start !== "number" ||
      typeof r.end !== "number" ||
      typeof r.kind !== "string"
    ) {
      continue;
    }
    out.push({
      start: r.start,
      end: r.end,
      kind: r.kind,
      score: typeof r.score === "number" ? r.score : 0,
      source: typeof r.source === "string" ? r.source : "unknown",
    });
  }
  return out;
}

function statusFromModelStatus(value: unknown): PIIStatus {
  // Per the API contract: on 200, derive status from `model_status` when
  // present. "skipped" and "error" map directly. Anything else — including
  // "ok", "disabled", or an absent field — means redaction succeeded.
  if (value === "skipped") return "skipped";
  if (value === "error") return "error";
  return "ok";
}

// Apply an entity allowlist to the span set. When unset, returns the
// spans unchanged. When set, keeps only spans whose `kind` maps onto
// one of the requested entities — unmapped kinds drop.
function filterByEntities(
  spans: PIISpan[],
  entities: readonly RedactPIIEntity[] | undefined,
): PIISpan[] {
  if (!entities || entities.length === 0) return spans;
  const allow = new Set(entities);
  return spans.filter(span => {
    const bucket = KIND_TO_ENTITY[span.kind];
    return bucket !== undefined && allow.has(bucket);
  });
}

// Re-render redacted text from the original + a filtered span set when
// fire-privacy's `redacted_text` no longer matches what we want to return
// (i.e. we narrowed the spans via entity filter). Same operator semantics
// as fire-privacy:
//   tag    → `<KIND>` placeholder per span
//   mask   → '*' × span length
//   remove → drop the chars entirely
function renderRedacted(
  text: string,
  spans: PIISpan[],
  replaceStyle: RedactPIIOptions["replaceStyle"],
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue; // overlap with prior span; skip
    if (span.start > text.length) break;
    out += text.slice(cursor, span.start);
    switch (replaceStyle) {
      case "tag":
        out += `<${span.kind}>`;
        break;
      case "mask":
        out += "*".repeat(Math.max(0, span.end - span.start));
        break;
      case "remove":
        break;
    }
    cursor = Math.min(span.end, text.length);
  }
  out += text.slice(cursor);
  return out;
}

export async function redactText(opts: RedactOptions): Promise<PIIBlock> {
  const { text, logger } = opts;
  const timeoutMs = opts.timeoutMs ?? config.FIRE_PRIVACY_TIMEOUT_MS;
  const options: RedactPIIOptions = opts.options ?? {
    mode: DEFAULTS.mode,
    replaceStyle: DEFAULTS.replaceStyle,
  };

  // Empty/whitespace input is a no-op locally — saves a round trip and matches
  // fire-privacy's own "skipped" semantics.
  if (text.trim().length === 0) {
    return {
      status: "skipped",
      redactedMarkdown: text,
      spans: [],
      truncatedAt: null,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.FIRE_PRIVACY_URL}/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        mode: MODE_MAP[options.mode],
        operator: REPLACE_MAP[options.replaceStyle],
        language: DEFAULTS.language,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const status: PIIStatus = timedOut ? "timeout" : "error";
    logger?.warn("fire-privacy request failed", {
      status,
      url: opts.url,
      mode: options.mode,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status,
      redactedMarkdown: null,
      spans: [],
      truncatedAt: null,
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    let status: PIIStatus;
    if (response.status === 503) status = "service_at_capacity";
    else status = "error";
    logger?.warn("fire-privacy returned non-2xx", {
      status,
      httpStatus: response.status,
      url: opts.url,
      mode: options.mode,
    });
    return {
      status,
      redactedMarkdown: null,
      spans: [],
      truncatedAt: null,
    };
  }

  let body: FirePrivacyResponse;
  try {
    body = (await response.json()) as FirePrivacyResponse;
  } catch (err) {
    logger?.warn("fire-privacy returned invalid JSON", {
      url: opts.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "error",
      redactedMarkdown: null,
      spans: [],
      truncatedAt: null,
    };
  }

  const modelStatus = statusFromModelStatus(body.model_status);
  const upstreamRedacted =
    typeof body.redacted_text === "string" ? body.redacted_text : null;
  const allSpans = coerceSpans(body.spans);
  const truncatedAt =
    typeof body.model_truncated_at === "number"
      ? body.model_truncated_at
      : null;

  if (modelStatus === "error" || upstreamRedacted === null) {
    return {
      status: "error",
      redactedMarkdown: null,
      // Surface whatever fire-privacy gave us — even on error, partial
      // Presidio spans may be present and useful for callers.
      spans: filterByEntities(allSpans, options.entities),
      truncatedAt,
    };
  }

  const spans = filterByEntities(allSpans, options.entities);
  // Re-render only when the entity filter actually pruned spans;
  // otherwise fire-privacy's redacted_text already reflects our spans
  // (it was rendered with the same operator we requested).
  const redactedMarkdown =
    spans.length === allSpans.length
      ? upstreamRedacted
      : renderRedacted(text, spans, options.replaceStyle);

  return {
    status: modelStatus,
    redactedMarkdown,
    spans,
    truncatedAt,
  };
}
