import { NextResponse } from "next/server";
import { getApiKeyById, getRule, setRule, deleteRule } from "@/lib/localDb";

const EMPTY_RULE = { providers: [], connections: [], models: [], combos: [] };

function toStringArray(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.length > 0) : [];
}

// GET /api/rules/[apiKeyId] - the rule for one API key (empty rule if none).
export async function GET(request, { params }) {
  try {
    const { apiKeyId } = await params;
    const key = await getApiKeyById(apiKeyId);
    if (!key) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }
    const rule = (await getRule(apiKeyId)) || EMPTY_RULE;
    return NextResponse.json({ apiKeyId, rule });
  } catch (error) {
    console.log("Error fetching rule:", error);
    return NextResponse.json({ error: "Failed to fetch rule" }, { status: 500 });
  }
}

// PUT /api/rules/[apiKeyId] - replace the rule for one API key.
export async function PUT(request, { params }) {
  try {
    const { apiKeyId } = await params;
    const key = await getApiKeyById(apiKeyId);
    if (!key) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const normalized = {
      providers: toStringArray(body.providers),
      connections: toStringArray(body.connections),
      models: toStringArray(body.models),
      combos: toStringArray(body.combos),
    };
    const saved = await setRule(apiKeyId, normalized);
    return NextResponse.json(saved);
  } catch (error) {
    console.log("Error saving rule:", error);
    return NextResponse.json({ error: "Failed to save rule" }, { status: 500 });
  }
}

// DELETE /api/rules/[apiKeyId] - remove the rule (reverts key to default-deny).
export async function DELETE(request, { params }) {
  try {
    const { apiKeyId } = await params;
    await deleteRule(apiKeyId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting rule:", error);
    return NextResponse.json({ error: "Failed to delete rule" }, { status: 500 });
  }
}
