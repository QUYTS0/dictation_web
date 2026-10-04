"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { HistoryVideoRounds, HistoryVideoSessionsPage, HistoryVideosPage, VideoRoundList } from "@/lib/types/learning";

export interface HistorySessionsFilters {
  videoId: string;
}

const VIDEO_PAGE_SIZE = 10;
const SESSION_PAGE_SIZE = 10;

/**
 * Every History key lives under ["history-sessions", userId], so the
 * existing account-scoped invalidation after a confirmed save or flush
 * (invalidateLearningViews → allForUser) refreshes the video list, the
 * rounds and the sessions alike.
 */
export const historySessionsKeys = {
  /** Prefix covering every History query of this user. */
  allForUser: (userId: string | undefined) => ["history-sessions", userId] as const,
  /** (Session-first list — kept for the key shape older code/tests use.) */
  list: (userId: string | undefined, filters: HistorySessionsFilters) => ["history-sessions", userId, filters] as const,
  videos: (userId: string | undefined) => ["history-sessions", userId, "videos"] as const,
  rounds: (userId: string | undefined, videoId: string) => ["history-sessions", userId, "rounds", videoId] as const,
  /** The report page's round selector (all rounds, paged). */
  roundList: (userId: string | undefined, videoId: string) => ["history-sessions", userId, "round-list", videoId] as const,
  /** roundId null = the video's round-less (Listening-only) sittings. */
  videoSessions: (userId: string | undefined, videoId: string, roundId: string | null) =>
    ["history-sessions", userId, "sessions", videoId, roundId ?? "none"] as const,
};

async function getJson<T>(url: string, failure: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(failure);
  return res.json();
}

type VideoCursor = { lastActivityAt: string; videoId: string } | null;

/** One card per studied video, newest learning activity first — grouped and paged on the server. */
export function useHistoryVideosQuery(userId: string | undefined) {
  return useInfiniteQuery({
    queryKey: historySessionsKeys.videos(userId),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(VIDEO_PAGE_SIZE) });
      if (pageParam) {
        params.set("beforeLastActivityAt", pageParam.lastActivityAt);
        params.set("beforeVideoId", pageParam.videoId);
      }
      return getJson<HistoryVideosPage>(`/api/history/videos?${params.toString()}`, "Failed to load your history");
    },
    initialPageParam: null as VideoCursor,
    getNextPageParam: (last): VideoCursor => {
      if (!last.hasMore || last.items.length === 0) return null;
      const tail = last.items[last.items.length - 1];
      return { lastActivityAt: tail.lastActivityAt, videoId: tail.videoId };
    },
    enabled: !!userId,
    placeholderData: keepPreviousData,
  });
}

/** A video's rounds — loaded only when its card is expanded. */
export function useHistoryVideoRoundsQuery(userId: string | undefined, videoId: string, enabled: boolean) {
  return useQuery({
    queryKey: historySessionsKeys.rounds(userId, videoId),
    queryFn: () => getJson<HistoryVideoRounds>(`/api/history/videos/${encodeURIComponent(videoId)}/rounds`, "Failed to load rounds"),
    enabled: enabled && !!userId,
  });
}

type SessionCursor = { startedAt: string; id: string } | null;

/** Study sessions of one round (or the round-less ones) — loaded only when that section is opened. */
export function useHistoryVideoSessionsQuery(userId: string | undefined, videoId: string, roundId: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: historySessionsKeys.videoSessions(userId, videoId, roundId),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ roundId: roundId ?? "none", limit: String(SESSION_PAGE_SIZE) });
      if (pageParam) {
        params.set("beforeStartedAt", pageParam.startedAt);
        params.set("beforeId", pageParam.id);
      }
      return getJson<HistoryVideoSessionsPage>(
        `/api/history/videos/${encodeURIComponent(videoId)}/sessions?${params.toString()}`,
        "Failed to load study sessions"
      );
    },
    initialPageParam: null as SessionCursor,
    getNextPageParam: (last): SessionCursor => {
      if (!last.hasMore || last.items.length === 0) return null;
      const tail = last.items[last.items.length - 1];
      return { startedAt: tail.startedAt, id: tail.studySessionId };
    },
    enabled: enabled && !!userId,
  });
}

const ROUND_LIST_PAGE_SIZE = 50;

/**
 * Every round of one video (report page selector): pages of 50, newest
 * first, with the exact total — "Show older rounds" loads the next page, so
 * no round is silently hidden behind the first page.
 */
export function useVideoRoundListQuery(userId: string | undefined, videoId: string | null | undefined) {
  return useInfiniteQuery({
    queryKey: historySessionsKeys.roundList(userId, videoId ?? ""),
    queryFn: ({ pageParam }) =>
      getJson<VideoRoundList>(
        `/api/history/videos/${encodeURIComponent(videoId as string)}/round-list?offset=${pageParam}&limit=${ROUND_LIST_PAGE_SIZE}`,
        "Failed to load rounds"
      ),
    initialPageParam: 0,
    getNextPageParam: (last): number | null => (last.hasMore ? last.offset + last.items.length : null),
    enabled: !!userId && !!videoId,
  });
}

