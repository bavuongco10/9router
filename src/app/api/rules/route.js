import { NextResponse } from "next/server";
import { getApiKeys, getAllRules } from "@/lib/localDb";
import { ruleGrantsAnything } from "@/lib/access/ruleEval";

export const dynamic = "force-dynamic";

// GET /api/rules - list every API key merged with its access rule + status.
export async function GET() {
  try {
    const keys = await getApiKeys();
    const all = await getAllRules();
    const rules = keys.map((k) => {
      const rule = all[k.id] || null;
      const gc = rule
        ? {
            providers: rule.providers.length,
            connections: rule.connections.length,
            models: rule.models.length,
            combos: rule.combos.length,
          }
        : { providers: 0, connections: 0, models: 0, combos: 0 };
      return {
        id: k.id,
        name: k.name,
        isActive: k.isActive,
        createdAt: k.createdAt,
        rule,
        status: ruleGrantsAnything(rule) ? "green" : "red",
        grantCounts: gc,
      };
    });
    return NextResponse.json({ rules });
  } catch (error) {
    console.log("Error fetching rules:", error);
    return NextResponse.json({ error: "Failed to fetch rules" }, { status: 500 });
  }
}
