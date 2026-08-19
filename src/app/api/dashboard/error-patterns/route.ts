import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ErrorType } from "@/lib/types";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("attempt_logs")
      .select("error_type")
      .eq("is_correct", false)
      .not("error_type", "is", null);

    if (error) {
      console.error("[dashboard/error-patterns] query error:", error);
      return NextResponse.json({ error: "Failed to load error patterns" }, { status: 500 });
    }

    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      const errorType = row.error_type as string | null;
      if (!errorType) continue;
      counts.set(errorType, (counts.get(errorType) ?? 0) + 1);
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const patterns = [...counts.entries()]
      .map(([errorType, count]) => ({
        errorType: errorType as ErrorType,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ total, patterns });
  } catch (err) {
    console.error("[dashboard/error-patterns] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
