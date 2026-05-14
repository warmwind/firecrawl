import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { redactText } from "../../../lib/fire-privacy-client";

export async function performRedactPII(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!meta.options.redactPII) return document;
  if (!hasFormatOfType(meta.options.formats, "pii")) return document;

  // pii format requires markdown to redact. If the markdown derivation step
  // ran and produced nothing, we surface that as `skipped` rather than calling
  // fire-privacy with an empty body.
  if (typeof document.markdown !== "string") {
    document.pii = {
      status: "skipped",
      redactedMarkdown: null,
      spans: [],
      truncatedAt: null,
    };
    return document;
  }

  document.pii = await redactText({
    text: document.markdown,
    url: meta.url,
    logger: meta.logger,
    // meta.options.redactPII is normalized by the Zod transform —
    // truthy here means it's the options object; falsy was already
    // bailed out of above.
    options: meta.options.redactPII || undefined,
  });
  return document;
}
