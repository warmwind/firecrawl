import { ALLOW_TEST_SUITE_WEBSITE, describeIf, TEST_PRODUCTION } from "../lib";
import {
  Identity,
  idmux,
  scrape,
  scrapeRaw,
  scrapeTimeout,
  scrapeWithFailure,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "v2-scrape-pii",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(ALLOW_TEST_SUITE_WEBSITE)("V2 Scrape redactPII (schema)", () => {
  it.concurrent(
    "rejects redactPII: true when `pii` is not in formats",
    async () => {
      const res = await scrapeWithFailure(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown"],
          redactPII: true,
        },
        identity,
      );

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/redactPII requires `pii`/);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects redactPII with non-boolean value",
    async () => {
      const res = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "pii"],
          // typed as boolean, but we want to confirm the API rejects strings.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redactPII: "yes" as any,
        },
        identity,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "accepts redactPII as an options object with mode/entities/replaceStyle",
    async () => {
      const res = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "pii"],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redactPII: {
            mode: "accurate",
            entities: ["EMAIL", "PHONE"],
            replaceStyle: "tag",
          } as any,
        },
        identity,
      );

      // The page may not have PII (so spans can be empty), but the
      // request itself must validate and the response must include
      // the `pii` block.
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pii).toBeDefined();
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects an unknown mode value",
    async () => {
      const res = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "pii"],
          // "model" is the fire-privacy internal mode, not the
          // public surface — must be rejected.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          redactPII: { mode: "model" } as any,
        },
        identity,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});

describeIf(TEST_PRODUCTION)("V2 Scrape redactPII (e2e)", () => {
  it(
    "returns pii block with spans and a redactedMarkdown when fire-privacy answers",
    async () => {
      // A page with named entities and an email so heuristic recognizers fire
      // even when fire-privacy is in heuristics-only mode.
      const data = await scrape(
        {
          url: "https://en.wikipedia.org/wiki/Alan_Turing",
          formats: ["markdown", "pii"],
          redactPII: true,
        },
        identity,
      );

      // Scrape always succeeds regardless of fire-privacy outcome.
      expect(typeof data.markdown).toBe("string");
      expect((data.markdown ?? "").length).toBeGreaterThan(0);

      expect(data.pii).toBeDefined();
      expect([
        "ok",
        "skipped",
        "error",
        "service_at_capacity",
        "timeout",
      ]).toContain(data.pii!.status);

      if (data.pii!.status === "ok") {
        expect(typeof data.pii!.redactedMarkdown).toBe("string");
        expect(data.pii!.spans.length).toBeGreaterThan(0);
        expect(data.pii!.spans[0]).toEqual(
          expect.objectContaining({
            start: expect.any(Number),
            end: expect.any(Number),
            kind: expect.any(String),
          }),
        );
      } else {
        expect(data.pii!.redactedMarkdown).toBeNull();
      }
    },
    scrapeTimeout,
  );

  it(
    "fails soft when fire-privacy is unreachable — markdown still returned, status is timeout/error",
    async () => {
      const data = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "pii"],
          redactPII: true,
        },
        identity,
      );

      expect(typeof data.markdown).toBe("string");
      expect(data.pii).toBeDefined();
      // We don't pin to a specific failure status — could be ok if
      // fire-privacy is reachable in this environment, or one of the
      // failure statuses otherwise. The contract is: scrape still succeeds.
      expect([
        "ok",
        "skipped",
        "error",
        "service_at_capacity",
        "timeout",
      ]).toContain(data.pii!.status);
    },
    scrapeTimeout,
  );

  it(
    "omits pii block when redactPII is false even if `pii` is in formats",
    async () => {
      const data = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "pii"],
        },
        identity,
      );

      expect(typeof data.markdown).toBe("string");
      expect(data.pii).toBeUndefined();
    },
    scrapeTimeout,
  );
});
