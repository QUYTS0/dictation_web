

# MASTER PLAN — ENGLISH DICTATION WEB APP

## 1) Product Summary

### Product name

English Dictation Trainer

### Product goal

Xây dựng một web app luyện nghe chép chính tả từ video YouTube, trong đó video sẽ tự dừng theo từng câu, người học phải gõ đúng mới được học tiếp, đồng thời có AI hỗ trợ giải thích lỗi và gợi ý học từ vựng.

### Primary use case

Người dùng dán link YouTube, hệ thống tải video, xác định transcript theo từng segment, phát từng câu, tự pause, nhận input, chấm đáp án, lưu tiến độ và hỗ trợ AI khi cần.

---

## 2) Product Scope

## In scope for MVP

* Dán URL YouTube để học
* Nhúng YouTube player
* Lấy transcript từ cache hoặc nguồn fallback
* Chia transcript thành segment theo thời gian
* Tự pause sau mỗi câu
* User gõ câu trả lời
* So sánh câu trả lời theo nhiều mode
* Hiển thị tiến độ học
* Hint cơ bản
* Lưu transcript và progress
* AI giải thích lỗi khi người dùng yêu cầu hoặc khi sai nhiều lần

---

## 3) Success Criteria

### Product KPIs cho MVP

* User có thể hoàn tất 1 session dictation từ đầu đến cuối mà không reload thủ công
* Tỷ lệ lỗi sync video-segment thấp
* Transcript được cache và tái sử dụng cho cùng video
* Thời gian load vào bài học đủ nhanh cho nhóm nhỏ
* AI chỉ chạy khi cần, tránh tốn quota không cần thiết

### Engineering KPIs

* Không lộ API key
* Không có flow nào phụ thuộc vào client-only secret
* Có log cho transcript generation, answer checking, AI explanation
* Có test cho core logic: normalize text, segment lookup, next sentence flow

---

## 4) User Roles

### Guest user

* Dán link video
* Học thử
* Có thể không cần login ở phiên bản đầu

### Registered user

* Lưu tiến độ
* Xem lịch sử lỗi
* Resume bài học dang dở

### Admin

* Theo dõi transcript status
* Rebuild transcript
* Xem log lỗi hệ thống

---

## 5) Functional Requirements

## 5.1 Video Input

* Người dùng nhập YouTube URL
* Hệ thống parse ra `youtubeVideoId`
* Hệ thống validate URL hợp lệ
* Nếu không hợp lệ, hiển thị lỗi rõ ràng

## 5.2 Video Player

* Nhúng YouTube player bằng IFrame API
* Hỗ trợ:

  * play
  * pause
  * seekTo
  * getCurrentTime
  * listen state changes
* Hệ thống luôn biết video đang ở segment nào

## 5.3 Transcript Pipeline

### Transcript source priority

1. Transcript đã cache trong database
2. Transcript đã tạo trước đó bởi AI
3. Transcript generation job mới
4. Fail state nếu không tạo được

### Transcript output format

```json
[
  {
    "segmentIndex": 0,
    "start": 12.32,
    "end": 15.48,
    "duration": 3.16,
    "text": "How are you doing today?"
  }
]
```

### Transcript requirements

* Có timestamp
* Có text sạch, đã normalize cơ bản
* Có thể tái sử dụng cho các user sau

## 5.4 Dictation Logic

* Phát đến hết segment hiện tại thì auto pause
* User nhập đáp án
* Hệ thống so sánh với expected text
* Nếu đúng:

  * tăng `currentSegmentIndex`
  * phát tiếp segment tiếp theo
* Nếu sai:

  * giữ nguyên segment
  * hiển thị feedback cơ bản
  * cho phép thử lại hoặc dùng hint

## 5.5 Answer Matching

### Chế độ chấm

* Exact match
* Relaxed match
* Learning mode

### Normalization rules

* trim khoảng trắng thừa
* normalize Unicode
* bỏ khác biệt hoa/thường nếu chọn relaxed
* chuẩn hóa dấu câu nếu chọn relaxed
* chuẩn hóa apostrophe/ký tự đặc biệt phổ biến

### Error types cần phân loại

* sai chính tả
* thiếu từ
* thừa từ
* sai dạng từ / ngữ pháp
* sai dấu câu
* sai viết hoa

## 5.6 Hint System

* Hint level 1: hiện chữ cái đầu
* Hint level 2: hiện số từ
* Hint level 3: hiện từ bị thiếu
* Hint level 4: show full answer

## 5.7 AI Tutor

* Chỉ gọi AI khi:

  * user bấm Explain
  * hoặc sai quá N lần
* AI trả về:

  * câu đúng
  * lỗi sai nằm ở đâu
  * vì sao sai
  * ví dụ tương tự
  * mẹo nhớ ngắn

## 5.8 Progress Tracking

* Lưu:

  * current segment
  * accuracy
  * số lần thử
  * thời gian học
* Có resume session

---

## 6) Non-Functional Requirements

## Performance

* Tải player nhanh
* Input phản hồi mượt
* Không gọi AI quá thường xuyên
* Có caching transcript và AI response

## Security

* API key Gemini chỉ nằm server-side
* Rate limit cho:

  * resolve video
  * generate transcript
  * AI explain
* Validate mọi input URL và payload

## Reliability

* Có trạng thái `processing`, `ready`, `failed`
* Có retry logic cho transcript generation
* Có timeout cho external AI calls

## Scalability

* Thiết kế đủ để chạy tốt cho nhóm nhỏ 5–6 người
* Có khả năng nâng cấp sau này lên paid tier mà không phải đổi kiến trúc lõi

---

## 7) Technical Architecture

## Frontend

* Next.js App Router
* TypeScript
* Tailwind CSS
* Zustand cho session/player state
* TanStack Query cho data fetching

## Backend

* Next.js Route Handlers
* Server-side service layer cho:

  * video resolving
  * transcript resolving
  * answer checking
  * AI explanation
  * progress persistence

## Database

* Supabase Postgres
* Row Level Security cho dữ liệu người dùng
* Supabase Auth cho login nếu bật user account

Supabase có production checklist riêng nhấn mạnh bảo mật và độ sẵn sàng trước khi go-live; với app có user data, nên xem RLS là bắt buộc chứ không phải tùy chọn. ([Supabase][3])

## Hosting

* Vercel Hobby cho MVP public web app
---

## 8) Data Model

## Table: videos

* id
* youtube_video_id
* title
* language
* duration_sec
* created_at

## Table: transcripts

* id
* youtube_video_id
* language
* source (`cache`, `ai`, `manual`)
* status (`processing`, `ready`, `failed`)
* version
* full_text
* created_at
* updated_at

## Table: transcript_segments

* id
* transcript_id
* segment_index
* start_sec
* end_sec
* duration_sec
* text_raw
* text_normalized

## Table: users

* id
* email
* display_name
* created_at

## Table: learning_sessions

* id
* user_id
* youtube_video_id
* transcript_id
* current_segment_index
* accuracy
* total_attempts
* status (`active`, `completed`, `abandoned`)
* started_at
* updated_at

## Table: attempt_logs

* id
* session_id
* segment_index
* expected_text
* user_text
* is_correct
* error_type
* created_at

## Table: ai_feedback

* id
* attempt_id
* explanation
* corrected_text
* example_text
* created_at

---

## 9) API Spec

## `POST /api/video/resolve`

### Input

```json
{ "url": "https://www.youtube.com/watch?v=..." }
```

### Output

```json
{
  "videoId": "abc123",
  "status": "ok"
}
```

## `GET /api/transcript/:videoId?lang=en`

### Behavior

* check DB trước
* nếu có transcript ready thì trả về
* nếu chưa có thì trả về `processing` hoặc trigger generation

### Output

```json
{
  "status": "ready",
  "source": "ai",
  "segments": []
}
```

## `POST /api/transcript/generate`

### Behavior

* tạo transcript generation job
* lưu status
* retry nếu fail

## `POST /api/dictation/check`

### Input

```json
{
  "sessionId": "xxx",
  "segmentIndex": 4,
  "userText": "he goes to school"
}
```

### Output

```json
{
  "isCorrect": false,
  "matchMode": "relaxed",
  "errorType": "grammar",
  "diff": []
}
```

## `POST /api/ai/explain`

### Input

```json
{
  "expectedText": "He goes to school.",
  "userText": "He go to school."
}
```

### Output

```json
{
  "explanation": "goes is needed because...",
  "correctedText": "He goes to school.",
  "example": "She goes to work by bus."
}
```

## `POST /api/session/save-progress`

* lưu tiến độ user

---

## 10) UX States

Cần định nghĩa rõ các trạng thái UI sau:

* idle
* loading video
* loading transcript
* transcript processing
* transcript ready
* transcript failed
* playing
* paused waiting for input
* checking answer
* AI explaining
* session completed
* network error

Cần có thêm:

* keyboard shortcuts
* replay current sentence
* skip sentence
* resume previous session

---

## 11) Roadmap

## Phase 0 — Foundation

Mục tiêu: chốt kiến trúc, domain model, transcript strategy

Deliverables:

* technical architecture
* DB schema
* transcript strategy
* environment setup
* base design system

## Phase 1 — Core Player + Session

Mục tiêu: dán link, load video, sync segment

Deliverables:

* YouTube player embedded
* parse URL
* player state management
* current time tracking
* seek handling
* segment lookup bằng binary search

## Phase 2 — Transcript Pipeline

Mục tiêu: có transcript usable cho dictation

Deliverables:

* transcript resolve API
* transcript cache DB
* transcript status flow
* segment storage
* fallback transcript generation service

## Phase 3 — Dictation Engine

Mục tiêu: hoàn thiện core loop học tập

Deliverables:

* auto pause
* answer checking
* exact/relaxed/learning modes
* next sentence logic
* progress tracking
* hint system

## Phase 4 — AI Tutor

Mục tiêu: thêm giá trị học tập thật sự

Deliverables:

* AI explain endpoint
* grammar explanation prompt
* cached AI feedback
* vocabulary suggestion

## Phase 5 — User System + Persistence

Mục tiêu: dùng được nhiều lần

Deliverables:

* auth
* session history
* resume session
* user dashboard nhẹ

## Phase 6 — Hardening

Mục tiêu: ổn định để public thử

Deliverables:

* rate limiting
* logging
* monitoring
* e2e test
* error analytics
* security review

---

## 12) Backlog

## P0 — Must have

* project setup
* URL validation
* YouTube player integration
* transcript resolve flow
* transcript DB cache
* transcript segment rendering
* auto pause by segment
* answer check exact/relaxed
* next sentence flow
* progress indicator
* basic hint
* loading/error states
* server-side Gemini integration
* save transcript by `youtube_video_id`
* basic save-progress

## P1 — Should have

* login
* resume session
* AI explanation
* error classification
* diff highlight
* replay current sentence
* skip sentence
* analytics event logging
* retry logic transcript generation

## P2 — Nice to have

* vocabulary learning panel
* sentence translation
* bookmarks
* streaks
* leaderboard
* admin transcript moderation
* multi-language UI

---

## 13) Risk Register

## Risk 1: User tua video làm lệch segment

Mitigation:

* seek detection
* binary search segment index
* restart current segment rule

## Risk 1: Free tier bị chạm quota

Mitigation:

* transcript cache
* không lưu dữ liệu thừa
* bật monitoring sớm
* ưu tiên small private beta trước

