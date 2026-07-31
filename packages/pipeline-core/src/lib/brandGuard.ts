/**
 * Visible-brand relevance guard.
 *
 * AI Doom qualification #1 used a factory aerial whose roof reads "Volkswagen
 * Chattanooga" over narration about HBM memory supply. Volkswagen has nothing
 * to do with that story, so the footage implied a connection that does not
 * exist.
 *
 * Two detection surfaces, because branding often appears only inside the
 * footage and never in the metadata:
 *
 *   1. METADATA — asset title, URL slug, search query. Cheap, runs on every
 *      candidate before download.
 *   2. RENDERED FRAMES — internal visual inspection of representative frames
 *      before approval. This is what actually catches roof signage; the
 *      Volkswagen clip carried no brand hint in its slug at all.
 *
 * This module implements (1) and records the fields (2) writes into. It does
 * not claim logo recognition — it claims that obvious readable signage must be
 * caught by one surface or the other before an asset ships.
 */

/** Companies and marques whose visible branding needs narration support. */
const KNOWN_BRANDS = [
  // Automotive — the family that produced the Volkswagen Chattanooga failure
  "volkswagen", "vw", "audi", "porsche", "bmw", "mercedes", "toyota", "honda",
  "ford", "chevrolet", "chevy", "nissan", "hyundai", "kia", "tesla", "rivian",
  "stellantis", "chrysler", "jeep", "subaru", "mazda", "volvo", "ferrari",
  // Retail / logistics
  "amazon", "walmart", "target", "costco", "fedex", "ups", "dhl", "maersk",
  "alibaba", "ikea", "tesco", "carrefour",
  // Tech / semiconductor (relevant only when the narration says so)
  "nvidia", "amd", "intel", "apple", "google", "microsoft", "meta", "samsung",
  "sk hynix", "hynix", "micron", "tsmc", "asml", "qualcomm", "broadcom",
  "arm", "ibm", "oracle", "cisco", "dell", "hp", "lenovo", "asus", "gigabyte",
  "openai", "anthropic", "huawei", "xiaomi", "sony", "lg", "panasonic",
  // Marine (Wet Circuit)
  "garmin", "humminbird", "lowrance", "simrad", "raymarine", "furuno",
  "minn kota", "motorguide", "yamaha", "mercury marine", "suzuki",
  // Food / consumer, common on industrial signage
  "coca cola", "coca-cola", "pepsi", "nestle", "unilever", "mcdonald",
  "starbucks", "boeing", "airbus", "siemens", "bosch", "ge ", "abb",
];

/**
 * Facility signage: "<ProperNoun> <Place|Plant|Works>". Matched on the
 * ORIGINAL text and requiring a capitalised leading token, so ordinary
 * descriptions like "modern semiconductor manufacturing facility" are not
 * mistaken for branding — over-rejection would starve the timeline of
 * legitimate footage.
 */
const FACILITY_PATTERN =
  /\b([A-Z][A-Za-z&.\-]{2,19})\s+(Chattanooga|Plant|Works|Assembly|Campus|GmbH|Inc\.?|Corp\.?|Ltd\.?)\b/;

/** Words that look like signage suffixes but are ordinary descriptors. */
const GENERIC_FACILITY_WORDS = new Set([
  "manufacturing", "industrial", "production", "modern", "large", "advanced",
  "automated", "semiconductor", "electronics", "assembly", "processing",
]);

export type BrandDecision = "NO_BRAND" | "RELEVANT" | "IRRELEVANT" | "UNVERIFIED";

export interface BrandCheck {
  visibleBrandDetected: boolean;
  detectedBrandOrSignage: string | null;
  brandRelevantToNarration: boolean | null;
  brandDecision: BrandDecision;
  rejectionReason: string | null;
  /** Which surface produced the verdict. */
  source: "metadata" | "frame-inspection" | "none";
}

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9&.\- ]/g, " ").replace(/\s+/g, " ")} `;
}

/** True when the narration actually discusses this brand or entity. */
export function narrationMentionsBrand(narration: string, brand: string): boolean {
  const n = norm(narration);
  const b = brand.trim().toLowerCase();
  if (n.includes(` ${b} `) || n.includes(` ${b}'`) || n.includes(` ${b},`)) return true;
  // "sk hynix" should also match a narration saying just "hynix".
  const parts = b.split(" ").filter((p) => p.length > 3);
  return parts.length > 0 && parts.every((p) => n.includes(p));
}

/**
 * Metadata-surface brand check, run before download on every candidate.
 *
 * @param text   asset description / slug / title
 * @param query  the search query used
 * @param narration the narration this scene sits under
 */
export function checkBrandFromMetadata(
  text: string,
  query: string,
  narration: string,
): BrandCheck {
  const haystack = norm(`${text} ${query}`);

  const hit = KNOWN_BRANDS.find((b) => haystack.includes(` ${b.trim()} `));
  const facilityMatch = FACILITY_PATTERN.exec(text);
  const facility =
    facilityMatch && !GENERIC_FACILITY_WORDS.has(facilityMatch[1].toLowerCase())
      ? facilityMatch
      : null;

  const detected = hit ?? (facility ? facility[0].trim() : null);
  if (!detected) {
    return {
      visibleBrandDetected: false,
      detectedBrandOrSignage: null,
      brandRelevantToNarration: null,
      brandDecision: "NO_BRAND",
      rejectionReason: null,
      source: "none",
    };
  }

  const relevant = narrationMentionsBrand(narration, detected);
  return {
    visibleBrandDetected: true,
    detectedBrandOrSignage: detected,
    brandRelevantToNarration: relevant,
    brandDecision: relevant ? "RELEVANT" : "IRRELEVANT",
    rejectionReason: relevant
      ? null
      : `visible branding "${detected}" is not discussed in the narration — would imply an unsupported connection`,
    source: "metadata",
  };
}

/**
 * Record a verdict reached by inspecting rendered frames.
 *
 * Metadata cannot see roof signage: the Volkswagen Chattanooga clip was
 * described only as "aerial view of large industrial warehouse facility".
 * Frame inspection is the surface that catches those, and its verdict is
 * recorded here so the QA record shows how the decision was reached.
 */
export function brandCheckFromFrameInspection(
  signage: string | null,
  narration: string,
): BrandCheck {
  if (!signage) {
    return {
      visibleBrandDetected: false,
      detectedBrandOrSignage: null,
      brandRelevantToNarration: null,
      brandDecision: "NO_BRAND",
      rejectionReason: null,
      source: "frame-inspection",
    };
  }
  const relevant = narrationMentionsBrand(narration, signage);
  return {
    visibleBrandDetected: true,
    detectedBrandOrSignage: signage,
    brandRelevantToNarration: relevant,
    brandDecision: relevant ? "RELEVANT" : "IRRELEVANT",
    rejectionReason: relevant
      ? null
      : `visible signage "${signage}" is unrelated to the narration`,
    source: "frame-inspection",
  };
}

/** An asset may be used only when no irrelevant branding is visible. */
export function brandAdmits(check: BrandCheck): boolean {
  return check.brandDecision !== "IRRELEVANT";
}

/**
 * Generic industrial aerials are the highest-risk category for unrelated
 * corporate signage — they are wide enough to show a roof or a sign and are
 * rarely specific to the topic. Flagged so frame inspection prioritises them.
 */
export function isHighBrandRiskFootage(description: string): boolean {
  const d = norm(description);
  return (
    (d.includes("aerial") || d.includes("drone")) &&
    (d.includes("factory") || d.includes("warehouse") || d.includes("plant") ||
     d.includes("industrial") || d.includes("facility"))
  );
}
