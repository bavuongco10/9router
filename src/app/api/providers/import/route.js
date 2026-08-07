import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { sanitizeImportedConnection } from "@/lib/connectionShare";

export const dynamic = "force-dynamic";

// POST /api/providers/import — recreate a connection from a copied blob.
// Body: { connection } (or the raw blob). Goes through createProviderConnection
// (WAL-safe, dedups by email/name, assigns priority) — never a direct DB write.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const blob = body && typeof body === "object" && body.connection !== undefined ? body.connection : body;

  let clean;
  try {
    clean = sanitizeImportedConnection(blob);
  } catch (e) {
    return NextResponse.json({ error: e.message || "Invalid connection data" }, { status: 400 });
  }

  try {
    const conn = await createProviderConnection(clean);
    return NextResponse.json({
      connection: { id: conn.id, provider: conn.provider, name: conn.name, email: conn.email },
    }, { status: 201 });
  } catch (error) {
    console.log("Error importing connection:", error);
    return NextResponse.json({ error: "Failed to import connection" }, { status: 500 });
  }
}
