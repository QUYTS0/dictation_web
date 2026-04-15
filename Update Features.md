# Plan: Dictation Feature Expansion

Implement continuous typing, autosave/resume tied to authenticated users, mistake review/history, vocabulary saving, and a basic dashboard by extending existing session/attempt logging, adding vocabulary storage, and building new UI routes and panels.

**Steps**
## 1. Schema updates (Supabase migration)  
   - Add missing columns to learning_sessions: video_current_time, active_segment_index (map from current_segment_index), attempt_count (map from total_attempts), and keep updated_at current.  
   - Extend attempt_logs with normalized_expected_text and normalized_user_text.  
   - Create vocabulary_items with RLS, indexes, and dedupe keys.  
   - Keep existing columns for compatibility and map in app logic.
## 2. Server APIs and data access  
   - Update save-progress to use auth-aware client and require user session; save timestamp + segment index.  
   - Add resume fetch endpoint for latest active session by user + video.  
   - Add restart/abandon endpoint to close old sessions.  
   - Add mistakes summary/history endpoints with filters.  
   - Add vocabulary create/list endpoints with dedupe logic.
## 3. Continuous typing mode  
   - Keep input enabled during playback; decouple enablement from paused state.  
   - Preserve auto-pause at segment end, but avoid wiping active input.  
   - On correct answer: immediately advance, reset input, and start next segment.
## 4. Autosave + resume flow  
- Save the current video timestamp, current segment, and current question index for each user in the database.
- When the user returns, load their saved progress and resume from where they left off.

### Task 4.1 — Create learning_sessions table support

Ensure the session record stores:

user_id
video_id
transcript_id
active_segment_index
video_current_time
accuracy
attempt_count
status
updated_at
### Task 4.2 — Implement autosave strategy

Autosave when:

the user submits an answer
the user changes segment
optionally on visibility/page hide

Acceptance criteria:

User progress is restored even if the tab closes unexpectedly
No reliance on browser-close-only saving
### Task 4.3 — Implement resume flow

When a saved session exists:

show a resume card
display last known timestamp and segment
let the user resume or restart

Acceptance criteria:

Resume seeks to the correct timestamp
Resume restores the correct segment index
## 5. Mistake review (session end)  
- After completing a segment or a video, provide a summary of the user's performance, including the questions they got wrong and the correct answers.
- Allow users to click on each question to see a detailed explanation of the correct answer and why their answer was incorrect.
- This helps users learn from their mistakes and understand the material better.
- Consider adding a "Review Mistakes" section where users can see all their past mistakes across different videos and segments, allowing them to focus on areas where they need improvement.
- This feature can be implemented using a combination of database storage for user performance data and a user interface that presents this information in an accessible way.
### Task 5.1 — Store answer attempts

Create or extend attempt_logs with:

session_id
segment_index
expected_text
user_text
normalized_expected_text
normalized_user_text
is_correct
error_type
created_at
### Task 5.2 — Add word-level diff utility

Build a utility that compares expected vs user input and identifies:

missing words
extra words
replaced words
punctuation mismatches

Acceptance criteria:

The app can highlight what is wrong, not only that it is wrong
### Task 5.3 — Build Session Review UI

After a session or video ends, show:

total correct answers
total mistakes
list of incorrect sentences
correct answer
replay button for each mistake

Acceptance criteria:

User can review mistakes from the completed session
Each mistake item links to the original segment context
### Task 5.4 — Build Mistake History page

Show all past mistakes across sessions, filterable by:

video
date
error type

Acceptance criteria:
User can revisit older mistakes later
## 6. Mistake history page  
   - New route listing past mistakes with video/date/error filters and jump-to-context.
## 7. Vocabulary features  
- Allow users to highlight words or phrases in the transcript that they find difficult or want to remember.
- Provide an option to save these highlighted words/phrases to a personal vocabulary list within the application.
- Users can review their vocabulary list at any time and see the context in which the word/phrase was used in the video.
- Additionally, provide a way for users to export their vocabulary list for offline study.

### Task 7.1 — Add save vocabulary action

Allow users to save:

a single word
a short phrase
from transcript or mistake review

Stored fields:

user_id
video_id
segment_index
term
normalized_term
sentence_context
note
created_at
### Task 7.2 — Add vocabulary list page

Display:

saved term
source sentence
source video
optional note
created date

Acceptance criteria:

User can review and manage saved terms
Duplicate saves are handled cleanly
### Task 7.3 — Add note support

Allow the user to add a personal note to each vocabulary item.
## 8. Dashboard  
Display:
  
- Completed videos
- Recent mistakes
- Learning trend:
    - Average accuracy
    - Total practice time
- Vocabulary
- Consider adding visualizations like charts or graphs to show the user's learning progress over time, such as accuracy trends or time spent practicing.
- Provide quick access links to resume recent sessions, review mistakes, and manage vocabulary directly from the dashboard for a more seamless user experience.
- Additionally, consider adding a motivational element to the dashboard, such as streaks for consecutive days of practice or badges for milestones achieved, to encourage consistent learning habits.

**Relevant files**
- 001_initial.sql — reference schema for new migration  
- [src/app/dictation/[videoId]/page.tsx](src/app/dictation/%5BvideoId%5D/page.tsx) — continuous typing, autosave, resume, completion UI  
- DictationInput.tsx — input enablement/reset behavior  
- route.ts — auth-aware save + timestamp  
- route.ts — log normalized texts  
- text.ts — enhanced word diff  
- index.ts — new request/response types  
- sessionStore.ts — session fields for resume  
- playerStore.ts — current time + segment index  
- server.ts — auth-aware server client

**Verification**
1. Manual: start dictation, answer correctly, confirm input stays active while next segment plays.  
2. Manual: close tab mid-session, reopen, resume card appears and seeks to saved timestamp.  
3. Manual: finish session, review mistakes list, replay a mistake, save a vocab item.  
4. Manual: visit mistake history and vocabulary pages; verify filters and dedupe.  
5. Automated: extend word diff tests and run existing tests.

**Decisions**
- Auth-only storage for progress, mistakes, and vocabulary.  
- Resume card appears on dictation page; user chooses resume or restart.  
- Input stays enabled during playback; player still auto-pauses at segment end.  
- Mistake review shown after session completion; history is a separate page.  
- Vocabulary saving from mistake review and a transcript segment list panel.



# Suggested database additions
- learning_sessions:
id
user_id
video_id
transcript_id
active_segment_index
video_current_time
accuracy
attempt_count
status
updated_at

- attempt_logs:
id
session_id
segment_index
expected_text
user_text
normalized_expected_text
normalized_user_text
is_correct
error_type
created_at

- vocabulary_items:
id
user_id
video_id
segment_index
term
normalized_term
sentence_context
note
created_at

# UI components should create
ContinuousInputPanel
ResumeSessionCard
MistakeReviewPanel
MistakeHistoryPage
VocabularySaveButton
VocabularyListPage
