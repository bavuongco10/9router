import { NextResponse } from "next/server";
import { getRequestDetailsStats } from "@/lib/usageDb";

// Analytics aggregated over ALL requests matching the filters (no pagination),
// so the summary cards + chart reflect the full filtered dataset, not one page.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const filter = {};

    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const result = await getRequestDetailsStats(filter);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] Failed to get request details stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details stats" },
      { status: 500 }
    );
  }
}
