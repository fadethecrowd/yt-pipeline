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
 * Brand names that are also ordinary English words. Matching these on the bare
 * token rejects footage that has nothing to do with the company: "industrial
 * robot arm on an assembly line" was being rejected as Arm Holdings branding,
 * which would starve every robotics topic of its most obvious B-roll. Each of
 * these only counts as branding when the surrounding text corroborates it.
 */
const AMBIGUOUS_BRANDS: Record<string, string[]> = {
  arm: ["arm holdings", "arm cortex", "arm chip", "arm processor", "arm architecture",
        "arm-based", "arm server", "arm cpu"],
  target: ["target store", "target retail", "target corporation", "target warehouse",
           "target distribution", "target shopping"],
  meta: ["meta platforms", "meta ai", "meta quest", "facebook", "instagram", "metaverse"],
  apple: ["apple inc", "apple store", "apple silicon", "apple iphone", "apple mac",
          "apple computer", "apple watch"],
  orange: ["orange telecom", "orange mobile"],
};

/**
 * True when an ambiguous token appears in a context that genuinely reads as
 * the company rather than the everyday word.
 */
function ambiguousBrandConfirmed(brand: string, haystack: string): boolean {
  const contexts = AMBIGUOUS_BRANDS[brand];
  if (!contexts) return true; // not ambiguous — the bare token is enough
  return contexts.some((c) => haystack.includes(c));
}

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
  /**
   * Where the support came from when the verdict is RELEVANT: the beat's own
   * words, or the video's subject. Recorded so a QA record shows which rule
   * admitted the asset.
   */
  relevanceSource?: "beat" | "subject" | null;
}

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9&.\- ]/g, " ").replace(/\s+/g, " ")} `;
}

/**
 * What the video is ABOUT, as opposed to what any one beat happens to say.
 *
 * The guard tests `beat.narration` — a 9-27 second slice of spoken words. That
 * is the right question for an incidental brand and the wrong one for the
 * brand the video is a review OF. Run cmtt7hovx (Garmin GMI 40) said "Garmin"
 * ten times across the script and in the topic title, yet 8 of its 16 beats do
 * not contain the word, so Garmin's own footage was rejected on those beats as
 * "an unsupported connection" and three of them starved into fallback cards
 * after 4,453 credits had been spent.
 *
 * The title and the hook are what establish the subject: they are where a video
 * says what it is about. A brand named there is supported everywhere in that
 * video. A brand named only in the middle of one segment is not the subject —
 * it is a passing comparison — and stays supported only on the beat that
 * actually discusses it.
 */
export function brandSubject(topicTitle: string, hook: string): string {
  return `${topicTitle} ${hook}`;
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
  /**
   * The video's subject — `brandSubject(topicTitle, hook)`. A brand named here
   * is the thing the video is about, so its footage is supported on EVERY beat,
   * not only the beats that happen to repeat the name. Optional: omitted, the
   * check behaves exactly as it did, which is what keeps callers that have no
   * subject to offer honest rather than silently permissive.
   */
  subject?: string,
): BrandCheck {
  const haystack = norm(`${text} ${query}`);

  const hit = KNOWN_BRANDS.find(
    (b) => haystack.includes(` ${b.trim()} `) && ambiguousBrandConfirmed(b.trim(), haystack),
  );
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
      relevanceSource: null,
    };
  }

  // Two independent sufficient conditions. The beat discusses the brand, OR the
  // brand is what the video is about. Either supports the footage; neither, and
  // it still implies a connection the script never makes.
  const onBeat = narrationMentionsBrand(narration, detected);
  const isSubject = !onBeat && !!subject && narrationMentionsBrand(subject, detected);
  const relevant = onBeat || isSubject;
  return {
    visibleBrandDetected: true,
    detectedBrandOrSignage: detected,
    brandRelevantToNarration: relevant,
    brandDecision: relevant ? "RELEVANT" : "IRRELEVANT",
    rejectionReason: relevant
      ? null
      : `visible branding "${detected}" is unrelated to this beat and is not the subject of the video — would imply an unsupported connection`,
    source: "metadata",
    relevanceSource: onBeat ? "beat" : isSubject ? "subject" : null,
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
  /** See `checkBrandFromMetadata`. Roof signage of the subject brand is fine. */
  subject?: string,
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
  const onBeat = narrationMentionsBrand(narration, signage);
  const isSubject = !onBeat && !!subject && narrationMentionsBrand(subject, signage);
  const relevant = onBeat || isSubject;
  return {
    visibleBrandDetected: true,
    detectedBrandOrSignage: signage,
    brandRelevantToNarration: relevant,
    brandDecision: relevant ? "RELEVANT" : "IRRELEVANT",
    rejectionReason: relevant
      ? null
      : `visible signage "${signage}" is unrelated to this beat and is not the subject of the video`,
    source: "frame-inspection",
    relevanceSource: onBeat ? "beat" : isSubject ? "subject" : null,
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
