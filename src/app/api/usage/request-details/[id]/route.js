import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";

/**
 * GET /api/usage/request-details/[id]
 *
 * Returns the FULL request detail for a single request, including the heavy
 * bodies (request / providerRequest / providerResponse / response). Those
 * bodies are gzip-compressed on disk and decompressed here on demand — the
 * list endpoint never touches them, so this is the only place they're read.
 *
 * If the payload file was evicted (size cap) the light summary is returned
 * with `payloadEvicted: true` so the UI can explain the missing bodies.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json({ error: "Request detail not found" }, { status: 404 });
    }

    return NextResponse.json(detail);
  } catch (error) {
    console.error("[API] Failed to get request detail by id:", error);
    return NextResponse.json(
      { error: "Failed to fetch request detail" },
      { status: 500 }
    );
  }
}
