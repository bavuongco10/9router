import { buildModelsList } from "@/app/api/v1/models/route.js";

// All service kinds exposed by 9router providers. Admin UI lists every model
// across kinds so the per-API-key rule editor can grant any of them.
const ALL_KINDS = ["llm", "embedding", "tts", "stt", "image", "imageToText", "webSearch", "webFetch"];

// Dashboard-only models endpoint. Returns the full unfiltered models list so
// admin UIs (e.g. the rule editor) can pick from every available resource
// regardless of any per-API-key rule. Gated by the existing dashboard
// middleware that already protects /api/*.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await buildModelsList(ALL_KINDS);
    return Response.json({ object: "list", data });
  } catch (error) {
    console.log("Error fetching admin models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}

