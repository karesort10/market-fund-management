// Optional AI market analysis: summarizes recent financial headlines
// against the user's actual fund holdings/sector exposure, using Claude.
//
// This is entirely opt-in and costs real (small) money billed to your own
// Anthropic account — nothing runs unless ANTHROPIC_API_KEY is set. It
// uses Haiku (Anthropic's cheapest model) with a single bounded prompt, and
// server.js only calls this on a long interval (hours, not minutes) by
// default, so realistic cost is a fraction of a cent per run — a handful
// of calls a day, not per page load. See README for setup and cost notes.
//
// This is not financial advice, and the model can be wrong — it's a
// convenience summary of public headlines, not a signal to act on.

const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const REQUEST_TIMEOUT_MS = 30 * 1000;
const ANTHROPIC_VERSION = "2023-06-01";

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function buildPrompt({ funds, articles }) {
  const exposureLines = (funds || [])
    .map((f) => {
      const topSlices = (f.allocation || [])
        .slice(0, 3)
        .map((s) => `${s.label} ${Math.round(s.percent)}%`)
        .join(", ");
      return `- ${f.label} (${f.code}): ${topSlices || "composition unknown"}`;
    })
    .join("\n");

  const headlineLines = (articles || [])
    .slice(0, 20)
    .map((a) => `- [${a.source}] ${a.title}`)
    .join("\n");

  return `You are a cautious financial analyst helping a retail investor understand how recent news relates to their existing holdings. This is informational only, not financial advice, and you should not tell them to buy or sell anything.

The user holds these funds, with their approximate portfolio composition:
${exposureLines || "(no funds currently held)"}

Recent headlines from trusted financial outlets:
${headlineLines || "(no recent headlines available)"}

Respond with ONLY valid JSON (no markdown code fences, no commentary before or after), matching exactly this shape:
{
  "marketSummary": "2-3 sentence plain-language summary of overall market conditions right now",
  "predictions": [
    { "topic": "short topic or sector name", "outlook": "1-2 sentence near-term outlook, explicitly framed as a read of current sentiment, not a guarantee" }
  ],
  "warnings": [
    { "severity": "high" | "medium" | "low", "sector": "which of the user's specific funds/sectors this affects", "message": "concrete description of the conflict, risk, or major news and why it matters to this user's holdings specifically" }
  ]
}
Only include a warning when it is genuinely notable (armed conflict, sanctions, a major central bank decision, regulatory action, a sector-specific shock) AND clearly relevant to the funds/sectors listed above — if nothing critical stands out, return an empty warnings array rather than inventing one. At most 5 predictions and 5 warnings.`;
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    return JSON.parse(stripped);
  }
}

/**
 * @returns {Promise<{available:false} | {available:true, error:string} | {available:true, generatedAt:string, marketSummary:string, predictions:Array, warnings:Array}>}
 */
async function analyzeMarket({ funds, articles }) {
  if (!isConfigured()) {
    return { available: false };
  }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: buildPrompt({ funds, articles }) }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic API HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const json = await res.json();
    const text = json?.content?.find((block) => block.type === "text")?.text || "";
    const parsed = extractJson(text);

    return {
      available: true,
      generatedAt: new Date().toISOString(),
      marketSummary: typeof parsed.marketSummary === "string" ? parsed.marketSummary : "",
      predictions: Array.isArray(parsed.predictions) ? parsed.predictions.slice(0, 5) : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 5) : [],
    };
  } catch (err) {
    return { available: true, error: err.message };
  }
}

module.exports = { analyzeMarket, isConfigured, MODEL };
