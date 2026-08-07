import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { toExportableConnection } from "@/lib/connectionShare";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/export — full connection blob (tokens included) for
// the Copy button. Dashboard-auth-gated by dashboardGuard; unlike /api/providers
// this intentionally returns unredacted credentials so the blob is portable.
export async function GET(_request, { params }) {
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }
  return NextResponse.json({ connection: toExportableConnection(connection) });
}
