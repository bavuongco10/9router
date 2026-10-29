import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

// Drops a trigger file in the bind-mounted DATA_DIR; the host's launchd agent
// (hello-9router/scripts/claude-update.sh) sees it and runs Claude: "update 9router and deploy".
export async function POST() {
  fs.writeFileSync(path.join(DATA_DIR, "update-request"), new Date().toISOString());
  return NextResponse.json({ success: true, message: "Update requested." });
}
