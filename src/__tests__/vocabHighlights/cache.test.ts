import { readCachedHighlights, upsertHighlightRows } from "@/lib/vocabHighlights/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

function fakeSupabase(builder: Record<string, jest.Mock>): SupabaseClient {
  return { from: jest.fn(() => builder) } as unknown as SupabaseClient;
}

function selectChain(rows: unknown[]) {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  // The third .eq() call resolves the (thenable) query — Supabase's actual
  // client behaves this way when awaited directly without a terminal method.
  let eqCallCount = 0;
  builder.eq = jest.fn(() => {
    eqCallCount++;
    if (eqCallCount >= 3) return Promise.resolve({ data: rows, error: null });
    return builder;
  });
  return builder;
}

describe("readCachedHighlights", () => {
  it("returns a row whose stored hash matches the current segment text hash", async () => {
    const supabase = fakeSupabase(
      selectChain([
        { segment_index: 0, phrases: [{ phrase: "destined", translation: null, start: 13, end: 21 }], status: "complete", transcript_text_hash: "hash-0", azure_used: false },
      ])
    );

    const result = await readCachedHighlights(supabase, "t1", "B1", "v1", new Map([[0, "hash-0"]]));
    expect(result.get(0)?.phrases).toHaveLength(1);
  });

  it("treats a text-hash mismatch as a cache miss, even though the other key columns match", async () => {
    const supabase = fakeSupabase(
      selectChain([
        { segment_index: 0, phrases: [{ phrase: "destined", translation: null, start: 13, end: 21 }], status: "complete", transcript_text_hash: "stale-hash", azure_used: false },
      ])
    );

    const result = await readCachedHighlights(supabase, "t1", "B1", "v1", new Map([[0, "current-hash"]]));
    expect(result.has(0)).toBe(false);
  });

  it("treats a null (legacy Gemini-era) stored hash as never matching", async () => {
    const supabase = fakeSupabase(
      selectChain([{ segment_index: 0, phrases: [], status: "complete", transcript_text_hash: null, azure_used: false }])
    );

    const result = await readCachedHighlights(supabase, "t1", "B1", "gemini-legacy-v1", new Map([[0, "current-hash"]]));
    expect(result.has(0)).toBe(false);
  });

  it("passes canonicalForm/learningPattern through unchanged, and tolerates legacy rows without them", async () => {
    const supabase = fakeSupabase(
      selectChain([
        {
          segment_index: 0,
          phrases: [
            {
              phrase: "go a long way toward",
              translation: null,
              start: 0,
              end: 21,
              canonicalForm: "go a long way",
              learningPattern: "go a long way toward(s) + noun/V-ing",
            },
            // Legacy row generated before learningPattern/canonicalForm existed.
            { phrase: "destined", translation: null, start: 30, end: 38 },
          ],
          status: "complete",
          transcript_text_hash: "hash-0",
          azure_used: false,
        },
      ])
    );

    const result = await readCachedHighlights(supabase, "t1", "B1", "v1", new Map([[0, "hash-0"]]));
    const phrases = result.get(0)?.phrases ?? [];
    expect(phrases[0].canonicalForm).toBe("go a long way");
    expect(phrases[0].learningPattern).toBe("go a long way toward(s) + noun/V-ing");
    expect(phrases[1].canonicalForm).toBeUndefined();
    expect(phrases[1].learningPattern).toBeUndefined();
  });

  it("returns an empty map on a database error rather than throwing", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    let eqCallCount = 0;
    builder.eq = jest.fn(() => {
      eqCallCount++;
      if (eqCallCount >= 3) return Promise.resolve({ data: null, error: { message: "db down" } });
      return builder;
    });
    const supabase = fakeSupabase(builder);

    const result = await readCachedHighlights(supabase, "t1", "B1", "v1", new Map());
    expect(result.size).toBe(0);
  });
});

describe("upsertHighlightRows", () => {
  it("upserts on the (transcript_id, segment_index, learning_level, pipeline_version) conflict target", async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.upsert = jest.fn(() => Promise.resolve({ error: null }));
    const supabase = fakeSupabase(builder);

    await upsertHighlightRows(supabase, "t1", "B1", "v1", [
      {
        segmentIndex: 0,
        phrases: [{ phrase: "destined", translation: null, start: 13, end: 21 }],
        status: "complete",
        transcriptTextHash: "hash-0",
        azureUsed: false,
        candidateCounts: { subtlex: 1 },
      },
    ]);

    expect(builder.upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          transcript_id: "t1",
          segment_index: 0,
          learning_level: "B1",
          pipeline_version: "v1",
          status: "complete",
        }),
      ]),
      { onConflict: "transcript_id,segment_index,learning_level,pipeline_version" }
    );
  });

  it("does nothing when there are no rows to write", async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.upsert = jest.fn(() => Promise.resolve({ error: null }));
    const supabase = fakeSupabase(builder);

    await upsertHighlightRows(supabase, "t1", "B1", "v1", []);
    expect(builder.upsert).not.toHaveBeenCalled();
  });

  it("does not throw when the write fails", async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.upsert = jest.fn(() => Promise.resolve({ error: { message: "db down" } }));
    const supabase = fakeSupabase(builder);

    await expect(
      upsertHighlightRows(supabase, "t1", "B1", "v1", [
        { segmentIndex: 0, phrases: [], status: "empty", transcriptTextHash: "h", azureUsed: false, candidateCounts: {} },
      ])
    ).resolves.toBeUndefined();
  });
});
