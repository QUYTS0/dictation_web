import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { MAX_BULK_SELECTABLE_ITEMS } from "@/lib/utils/vocabulary";

interface BulkDeleteRequest {
  ids?: unknown;
}

/**
 * Deletes multiple vocabulary items owned by the caller in one request —
 * the Vocabulary Bank's bulk-selection flow. One SQL statement, so for ids
 * that exist and belong to the caller it's all-or-nothing at the DB level;
 * an id that doesn't belong to the caller (or no longer exists) is simply
 * excluded from `deletedIds` rather than treated as an error, mirroring
 * DELETE /api/vocabulary's own `.eq("user_id", ...)` ownership scoping.
 *
 * MAX_BULK_SELECTABLE_ITEMS is imported from the same shared module the
 * client uses to disable further checkbox selection once reached — the cap
 * enforced here is defense-in-depth; in normal use the client never lets a
 * request exceed it.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, "vocabulary/bulk-delete", {
      limit: 10,
      windowMs: 60_000,
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body: BulkDeleteRequest = await request.json();
    const { ids } = body;

    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_BULK_SELECTABLE_ITEMS ||
      !ids.every((id) => typeof id === "string" && id.length > 0)
    ) {
      return NextResponse.json(
        { error: `ids must be a non-empty array of strings, up to ${MAX_BULK_SELECTABLE_ITEMS} items` },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("vocabulary_items")
      .delete()
      .in("id", ids as string[])
      .eq("user_id", user.id)
      .select("id");

    if (error) {
      console.error("[vocabulary/bulk-delete] delete error:", error);
      return NextResponse.json({ error: "Failed to delete vocabulary items" }, { status: 500 });
    }

    return NextResponse.json({ deletedIds: (data ?? []).map((row) => row.id as string) });
  } catch (err) {
    console.error("[vocabulary/bulk-delete] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
