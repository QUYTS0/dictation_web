import { useRef } from "react";
import { clsx } from "clsx";
import { FileText, Type, AlignLeft, ClipboardCheck, type LucideIcon } from "lucide-react";
import type { Bookmark, TranscriptSegment, VocabHighlightPhrase } from "@/lib/types";
import type { AudioRecorderStatus, RecordedClip } from "@/hooks/useAudioRecorder";
import type { SpeechRecognitionStatus } from "@/hooks/useSpeechRecognition";
import { ScriptTab } from "./ScriptTab";
import { WordsTab } from "./WordsTab";
import { SentencesTab } from "./SentencesTab";
import { EvaluationTab } from "./EvaluationTab";
import type { InputMode, LessonSavedItem, RightPanelTab as RightPanelTabValue, SentenceEvaluation } from "../types";
import type { ShadowingEvaluationSummary } from "../useShadowingEvaluations";

const TAB_CONFIG: Array<{ id: RightPanelTabValue; label: string; icon: LucideIcon }> = [
  { id: "script", label: "Script", icon: FileText },
  { id: "words", label: "Words", icon: Type },
  { id: "sentences", label: "Sentences", icon: AlignLeft },
  { id: "evaluation", label: "Evaluate", icon: ClipboardCheck },
];

function CountBadge({ count }: { count: number }) {
  return (
    <span className="flex h-[17px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] px-1 text-[10px] font-semibold leading-none text-[var(--accent)]">
      {count > 99 ? "99+" : count}
    </span>
  );
}

// Every tab is a grid cell (see gridTemplateColumns on the tablist) — the
// active cell's track is only moderately wider (1.45fr/1.55fr vs 1fr), never
// the full remaining space, so the bar stays visually balanced. Content
// itself is a centered inline group (icon [+ label] [+ badge]) rather than
// anything absolutely positioned, so a two-digit badge never overlaps the icon.
function TabButton({
  id,
  label,
  Icon,
  isActive,
  count,
  onSelect,
  buttonRef,
  onKeyDown,
}: {
  id: RightPanelTabValue;
  label: string;
  Icon: LucideIcon;
  isActive: boolean;
  count: number;
  onSelect: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      id={`rightpanel-tab-${id}`}
      aria-selected={isActive}
      aria-controls="rightpanel-tabpanel"
      aria-label={label}
      title={label}
      tabIndex={isActive ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={clsx(
        "flex min-h-[44px] w-full min-w-0 items-center justify-center rounded-lg px-1.5 text-sm font-bold outline-none",
        "transition-[background-color,color,border-color] duration-200 ease-out",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
        isActive
          ? "border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--accent)] shadow-sm"
          : "text-[var(--text-muted)] hover:text-[var(--accent)]"
      )}
    >
      <span className="flex min-w-0 max-w-full items-center justify-center gap-1.5">
        <Icon size={21} strokeWidth={1.8} className="shrink-0" />
        {isActive && <span className="min-w-0 truncate">{label}</span>}
        {count > 0 && <CountBadge count={count} />}
      </span>
    </button>
  );
}

export function RightPanelTabs({
  rightPanelTab,
  setRightPanelTab,
  scriptSegments,
  currentSegIdx,
  inputMode,
  onSeekToSegment,
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
  recorderStatus,
  recordingClip,
  speechStatus,
  transcript,
  onEvaluationRecorded,
  evaluationSummary,
}: {
  rightPanelTab: RightPanelTabValue;
  setRightPanelTab: (tab: RightPanelTabValue) => void;
  scriptSegments: TranscriptSegment[];
  currentSegIdx: number;
  inputMode: InputMode;
  onSeekToSegment: (segmentIndex: number) => void;
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
  recorderStatus: AudioRecorderStatus;
  recordingClip: RecordedClip | null;
  speechStatus: SpeechRecognitionStatus;
  transcript: string | null;
  onEvaluationRecorded: (evaluation: SentenceEvaluation) => void;
  evaluationSummary: ShadowingEvaluationSummary;
}) {
  const tabRefs = useRef<Partial<Record<RightPanelTabValue, HTMLButtonElement | null>>>({});
  const visibleTabs = TAB_CONFIG.filter((tab) => tab.id !== "evaluation" || inputMode === "shadowing");
  const countFor = (id: RightPanelTabValue) => {
    if (id === "words") return wordItems.length;
    if (id === "sentences") return sentenceItems.length + bookmarks.length;
    return 0;
  };

  const handleTabListKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const ids = visibleTabs.map((tab) => tab.id);
    const currentIndex = ids.indexOf(rightPanelTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = ((currentIndex < 0 ? 0 : currentIndex) + 1) % ids.length;
    else if (event.key === "ArrowLeft") nextIndex = ((currentIndex < 0 ? 0 : currentIndex) - 1 + ids.length) % ids.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = ids.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextId = ids[nextIndex];
    setRightPanelTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  // Balanced ratios rather than "active tab takes all remaining space" — the
  // active column is only moderately wider than the rest. Track count always
  // matches visibleTabs.length, and every track is minmax(0, ...) so the grid
  // never grows past the bar's own fixed width, only redistributes it.
  const activeRatio = visibleTabs.length === 3 ? 1.45 : 1.55;
  const gridTemplateColumns = visibleTabs
    .map((tab) => (tab.id === rightPanelTab ? `minmax(0, ${activeRatio}fr)` : "minmax(0, 1fr)"))
    .join(" ");

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 mx-3 mt-2">
        <div
          role="tablist"
          aria-label="Right panel sections"
          style={{ gridTemplateColumns }}
          className="grid w-full items-center gap-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1 text-[var(--text)] shadow-inner transition-[grid-template-columns] duration-200 ease-out"
        >
          {visibleTabs.map((tab) => (
            <TabButton
              key={tab.id}
              id={tab.id}
              label={tab.label}
              Icon={tab.icon}
              isActive={rightPanelTab === tab.id}
              count={countFor(tab.id)}
              onSelect={() => setRightPanelTab(tab.id)}
              buttonRef={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              onKeyDown={handleTabListKeyDown}
            />
          ))}
        </div>
      </div>

      <div
        id="rightpanel-tabpanel"
        role="tabpanel"
        aria-labelledby={`rightpanel-tab-${rightPanelTab}`}
        tabIndex={-1}
        className="momentum-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2 pt-0.5 outline-none"
      >
        {rightPanelTab === "script" ? (
          <ScriptTab
            scriptSegments={scriptSegments}
            currentSegIdx={currentSegIdx}
            inputMode={inputMode}
            onSeekToSegment={onSeekToSegment}
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
        ) : rightPanelTab === "sentences" ? (
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
        ) : (
          <EvaluationTab
            currentSegIdx={currentSegIdx}
            currentSegment={scriptSegments[currentSegIdx]}
            recorderStatus={recorderStatus}
            recordingClip={recordingClip}
            speechStatus={speechStatus}
            transcript={transcript}
            onEvaluated={() => setRightPanelTab("evaluation")}
            onEvaluationRecorded={onEvaluationRecorded}
            evaluationSummary={evaluationSummary}
            onJumpToSegment={onSeekToSegment}
          />
        )}
      </div>
    </>
  );
}
