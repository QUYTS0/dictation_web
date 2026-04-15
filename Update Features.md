# Update Features

## 0. Continuous Typing Mode
- After the user answers question N correctly, the app immediately moves to question N+1. Input is reset and opens instantly. Video plays question N+1. Users can type while listening.
- After a user enters a correct sentence, the system should immediately accept their input and allow them to continue practicing without waiting for the next sentence to finish playing. I mean the input box should be active and ready for the user to type anytime, even while the next sentence is being played. This way, users can practice more efficiently and maintain their flow without unnecessary interruptions.

## 1. Autosave and Resume - Save the study progress of users
- Save the current video timestamp, current segment, and current question index for each user in the database.
- When the user returns, load their saved progress and resume from where they left off.
- This allows users to study at their own pace and not lose their progress if they need to take a break.
Autosave periodically
Autosave when an important event occurs

### Task 1.1 — Create learning_sessions table support

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
### Task 1.2 — Implement autosave strategy

Autosave when:

the user submits an answer
the user changes segment
every 10–15 seconds during active learning
optionally on visibility/page hide

Acceptance criteria:

User progress is restored even if the tab closes unexpectedly
No reliance on browser-close-only saving
### Task 1.3 — Implement resume flow

When a saved session exists:

show a resume card
display last known timestamp and segment
let the user resume or restart

Acceptance criteria:

Resume seeks to the correct timestamp
Resume restores the correct segment index

## 2. Add a feature to allow users to review their mistakes
- After completing a segment or a video, provide a summary of the user's performance, including the questions they got wrong and the correct answers.
- Allow users to click on each question to see a detailed explanation of the correct answer and why their answer was incorrect.
- This helps users learn from their mistakes and understand the material better.
- Consider adding a "Review Mistakes" section where users can see all their past mistakes across different videos and segments, allowing them to focus on areas where they need improvement.
- This feature can be implemented using a combination of database storage for user performance data and a user interface that presents this information in an accessible way.
### Task 2.1 — Store answer attempts

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
### Task 2.2 — Add word-level diff utility

Build a utility that compares expected vs user input and identifies:

missing words
extra words
replaced words
punctuation mismatches

Acceptance criteria:

The app can highlight what is wrong, not only that it is wrong
### Task 2.3 — Build Session Review UI

After a session or video ends, show:

total correct answers
total mistakes
list of incorrect sentences
correct answer
replay button for each mistake

Acceptance criteria:

User can review mistakes from the completed session
Each mistake item links to the original segment context
### Task 2.4 — Build Mistake History page

Show all past mistakes across sessions, filterable by:

video
date
error type

Acceptance criteria:

User can revisit older mistakes later



## 3. Add a feature to allow users save new words/phrases to their personal vocabulary list
- Allow users to highlight words or phrases in the transcript that they find difficult or want to remember.
- Provide an option to save these highlighted words/phrases to a personal vocabulary list within the application.
- Users can review their vocabulary list at any time and see the context in which the word/phrase was used in the video.
- Additionally, provide a way for users to export their vocabulary list for offline study.

### Task 3.1 — Add save vocabulary action

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
### Task 3.2 — Add vocabulary list page

Display:

saved term
source sentence
source video
optional note
created date

Acceptance criteria:

User can review and manage saved terms
Duplicate saves are handled cleanly
### Task 3.3 — Add note support

Allow the user to add a personal note to each vocabulary item.

## 4. Basic dashboard

Display:

- Completed videos
- Recent mistakes
- Learning trend:
    - Average accuracy
    - Total practice time
- Saved vocabulary
- Consider adding visualizations like charts or graphs to show the user's learning progress over time, such as accuracy trends or time spent practicing.
- Provide quick access links to resume recent sessions, review mistakes, and manage vocabulary directly from the dashboard for a more seamless user experience.
- Additionally, consider adding a motivational element to the dashboard, such as streaks for consecutive days of practice or badges for milestones achieved, to encourage consistent learning habits.

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
