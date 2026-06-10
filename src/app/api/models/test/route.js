import { NextResponse } from "next/server";
import * as log from "@/sse/utils/logger";
import { pingModelByKind } from "./ping";

// POST /api/models/test - Ping a single model via internal completions or embeddings.
// Optional `connectionId` pins the test to a specific provider connection (no fallback).
export async function POST(request) {
  try {
    const { model, kind, connectionId } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });

    const result = await pingModelByKind(model, kind || "llm", undefined, { connectionId });
    return NextResponse.json(result);
  } catch (err) {
    log.warn("MODEL_TEST", "Diagnostic model test failed", { error: err?.message });
    return NextResponse.json({ ok: false, error: "Model diagnostic failed" }, { status: 500 });
  }
}
