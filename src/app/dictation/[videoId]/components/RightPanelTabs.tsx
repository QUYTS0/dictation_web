import { FileText, Type, AlignLeft } from "lucide-react";
import type { Bookmark, TranscriptSegment, VocabHighlightPhrase } from "@/lib/types";
import { ScriptTab } from "./ScriptTab";
import { WordsTab } from "./WordsTab";
import { SentencesTab } from "./SentencesTab";
import type { LessonSavedItem, RightPanelTab as RightPanelTabValue } from "../types";

export function RightPanelTabs({
  rightPanelTab,
  setRightPanelTab,
  scriptContextSegments,
  currentSegIdx,
  showPreviousScriptContext,
  setShowPreviousScriptContext,
  translationBySegmentIndex,
  scriptTranslationLoading,
  scriptTranslationError,
  phrasesBySegmentIndex,
  vocabHighlightsError,
  scriptTextContainerRef,
  handleScriptMouseUp,
  handleScriptWordMouseUp,
  handlePhraseMouseEnter,
  handlePhraseMouseLeave,
  handlePhraseTap,
  wordItems,
  sentenceItems,
  learningError,
  learningErrorRetry,
  learningDeletingId,
  learningUpdatingId,
  onDeleteLearningItem,
  onUpdateLearningItem,
  bookmarks,
  bookmarksLoading,
  bookmarksError,
  bookmarksErrorRetry,
  bookmarkDeletingId,
  onDeleteBookmark,
  onUpdateBookmarkNote,
  onJumpBookmark,
}: {
  rightPanelTab: RightPanelTabValue;
  setRightPanelTab: (tab: RightPanelTabValue) => void;
  scriptContextSegments: TranscriptSegment[];
  currentSegIdx: number;
  showPreviousScriptContext: boolean;
  setShowPreviousScriptContext: (updater: (prev: boolean) => boolean) => void;
  translationBySegmentIndex: Map<number, string>;
  scriptTranslationLoading: boolean;
  scriptTranslationError: boolean;
  phrasesBySegmentIndex: Map<number, VocabHighlightPhrase[]>;
  vocabHighlightsError: boolean;
  scriptTextContainerRef: React.RefObject<HTMLDivElement | null>;
  handleScriptMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleScriptWordMouseUp: (event: React.MouseEvent<HTMLSpanElement>) => void;
  handlePhraseMouseEnter: (event: React.MouseEvent<HTMLSpanElement>, segmentIndex: number, text: string) => void;
  handlePhraseMouseLeave: () => void;
  handlePhraseTap: (event: React.MouseEvent<HTMLButtonElement>, segmentIndex: number, text: string) => void;
  wordItems: LessonSavedItem[];
  sentenceItems: LessonSavedItem[];
  learningError: string | null;
  learningErrorRetry: (() => void) | null;
  learningDeletingId: string | null;
  learningUpdatingId: string | null;
  onDeleteLearningItem: (itemId: string) => void;
  onUpdateLearningItem: (
    itemId: string,
    values: {
      term: string;
      sentenceContext: string;
      note: string;
      translation: string;
      phonetic: string;
      partOfSpeech: string;
      definition: string;
    }
  ) => void;
  bookmarks: Bookmark[];
  bookmarksLoading: boolean;
  bookmarksError: string | null;
  bookmarksErrorRetry: (() => void) | null;
  bookmarkDeletingId: string | null;
  onDeleteBookmark: (id: string) => void;
  onUpdateBookmarkNote: (id: string, note: string) => void;
  onJumpBookmark: (segmentIndex: number) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 mx-3 mt-2">
        <div className="flex flex-1 bg-[var(--surface-2)] border border-[var(--border)] p-1 rounded-xl shadow-inner text-[var(--text)]">
          <button
            onClick={() => setRightPanelTab("script")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm font-bold rounded-lg transition-all ${
              rightPanelTab === "script"
                ? "bg-[var(--surface)] text-[var(--accent)] shadow-sm border border-[var(--border-strong)]"
                : "text-[var(--text-muted)] hover:text-[var(--accent)]"
            }`}
          >
            <FileText size={15} /> Script
          </button>
          <button
            onClick={() => setRightPanelTab("words")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm font-bold rounded-lg transition-all ${
              rightPanelTab === "words"
                ? "bg-[var(--surface)] text-[var(--accent)] shadow-sm border border-[var(--border-strong)]"
                : "text-[var(--text-muted)] hover:text-[var(--accent)]"
            }`}
          >
            <Type size={15} /> Words
            {wordItems.length > 0 && (
              <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
                {wordItems.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setRightPanelTab("sentences")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm font-bold rounded-lg transition-all ${
              rightPanelTab === "sentences"
                ? "bg-[var(--surface)] text-[var(--accent)] shadow-sm border border-[var(--border-strong)]"
                : "text-[var(--text-muted)] hover:text-[var(--accent)]"
            }`}
          >
            <AlignLeft size={15} /> Sentences
            {sentenceItems.length + bookmarks.length > 0 && (
              <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
                {sentenceItems.length + bookmarks.length}
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {rightPanelTab === "script" ? (
          <ScriptTab
            scriptContextSegments={scriptContextSegments}
            currentSegIdx={currentSegIdx}
            showPreviousScriptContext={showPreviousScriptContext}
            setShowPreviousScriptContext={setShowPreviousScriptContext}
            translationBySegmentIndex={translationBySegmentIndex}
            scriptTranslationLoading={scriptTranslationLoading}
            scriptTranslationError={scriptTranslationError}
            phrasesBySegmentIndex={phrasesBySegmentIndex}
            vocabHighlightsError={vocabHighlightsError}
            learningError={learningError}
            learningErrorRetry={learningErrorRetry}
            scriptTextContainerRef={scriptTextContainerRef}
            handleScriptMouseUp={handleScriptMouseUp}
            handleScriptWordMouseUp={handleScriptWordMouseUp}
            handlePhraseMouseEnter={handlePhraseMouseEnter}
            handlePhraseMouseLeave={handlePhraseMouseLeave}
            handlePhraseTap={handlePhraseTap}
          />
        ) : rightPanelTab === "words" ? (
          <WordsTab
            items={wordItems}
            deletingId={learningDeletingId}
            updatingId={learningUpdatingId}
            onDelete={onDeleteLearningItem}
            onUpdate={onUpdateLearningItem}
            learningError={learningError}
            learningErrorRetry={learningErrorRetry}
          />
        ) : (
          <SentencesTab
            sentenceItems={sentenceItems}
            deletingId={learningDeletingId}
            updatingId={learningUpdatingId}
            onDelete={onDeleteLearningItem}
            onUpdate={onUpdateLearningItem}
            learningError={learningError}
            learningErrorRetry={learningErrorRetry}
            bookmarks={bookmarks}
            bookmarksLoading={bookmarksLoading}
            bookmarksError={bookmarksError}
            bookmarksErrorRetry={bookmarksErrorRetry}
            bookmarkDeletingId={bookmarkDeletingId}
            onDeleteBookmark={onDeleteBookmark}
            onUpdateBookmarkNote={onUpdateBookmarkNote}
            onJumpBookmark={onJumpBookmark}
          />
        )}
      </div>
    </>
  );
}
