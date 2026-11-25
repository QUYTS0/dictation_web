"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { streakQueryString } from "@/lib/queries/dashboard";
import type { LeagueAllTimeBoard, LeagueScope, LeagueWeekBoard } from "@/lib/types/leaderboard";

export const leaderboardKeys = {
  all: (userId: string | undefined) => ["leaderboard", userId] as const,
  board: (userId: string | undefined, scope: LeagueScope) => ["leaderboard", userId, scope] as const,
};

type BoardFor<S extends LeagueScope> = S extends "week" ? LeagueWeekBoard : LeagueAllTimeBoard;

/**
 * The league board (GET /api/leaderboard, migration 050). The week board
 * also places an eligible learner in this week's group and finalizes past
 * weeks, so the Dashboard card and /leaderboard share one cache entry. The
 * footer reads it with `enabled: false` (cached only — it never triggers a
 * read). Any failure (e.g. 050 not applied) hides the league parts.
 */
export function useLeaderboardQuery<S extends LeagueScope>(userId: string | undefined, scope: S, enabled = true) {
  return useQuery({
    queryKey: leaderboardKeys.board(userId, scope),
    queryFn: async (): Promise<BoardFor<S>> => {
      const tz = streakQueryString();
      const res = await fetch(`/api/leaderboard?scope=${scope}${tz ? `&${tz.slice(1)}` : ""}`);
      if (!res.ok) throw new Error("Failed to load the leaderboard");
      const data = (await res.json()) as Partial<BoardFor<S>> | null;
      if (!data || data.scope !== scope || !Array.isArray(data.rows) || typeof data.status !== "string") throw new Error("Unexpected leaderboard response");
      return data as BoardFor<S>;
    },
    enabled: !!userId && enabled,
  });
}

/**
 * Kudos (POST /api/leaderboard/kudos): shown at once on the week board and
 * rolled back if the server refuses. Throws with the server's message.
 */
export function useGiveKudosMutation(userId: string | undefined) {
  const queryClient = useQueryClient();
  const key = leaderboardKeys.board(userId, "week");
  return useMutation({
    mutationFn: async (memberKey: string): Promise<{ ok: boolean; kudos: number }> => {
      const res = await fetch("/api/leaderboard/kudos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberKey }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; kudos?: number; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Couldn't send kudos.");
      return { ok: true, kudos: Number(data.kudos) || 0 };
    },
    onMutate: async (memberKey) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<LeagueWeekBoard>(key);
      if (previous) {
        queryClient.setQueryData<LeagueWeekBoard>(key, {
          ...previous,
          rows: previous.rows.map((r) => (r.memberKey === memberKey && !r.youGaveKudos ? { ...r, youGaveKudos: true, kudos: r.kudos + 1 } : r)),
        });
      }
      return { previous };
    },
    onError: (_err, _memberKey, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (result, memberKey) => {
      queryClient.setQueryData<LeagueWeekBoard>(key, (board) =>
        board ? { ...board, rows: board.rows.map((r) => (r.memberKey === memberKey ? { ...r, youGaveKudos: true, kudos: result.kudos } : r)) } : board
      );
    },
  });
}
