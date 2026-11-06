# Crewtree — UI Wireframes

> Phác thảo bằng text cho toàn bộ màn hình. Nhãn trong wireframe là tiếng Anh (ngôn ngữ mặc định); khi chọn Tiếng Việt, mọi nhãn được dịch qua i18n, riêng các thuật ngữ agent/session/skill/plugin/MCP/prompt/token/model/task giữ nguyên.
> Kế hoạch tổng thể: [PLAN.md](./PLAN.md)

**Ký hiệu**

| Ký hiệu | Ý nghĩa |
|---|---|
| `●` | running (xanh dương, nhấp nháy nhẹ) |
| `✓` | done (xanh lá) |
| `✕` | error (đỏ) |
| `⚑` | waiting for approval (vàng) |
| `◌` | throttled (tím nhạt) |
| `○` | idle (xám) |
| `▾` | dropdown · `▸` mở rộng · `⊟` thu gọn nhánh · `↺` model bị ghi đè trong session |
| `▍` | thanh màu của agent |

**Nguyên tắc thị giác:** nền trung tính (zinc/slate), màu chỉ dùng cho trạng thái và điểm nhấn của agent; bo góc 12px, viền 1px; font Inter, code JetBrains Mono; có theme sáng/tối.

---

## Mục lục

0. [App shell và Sessions](#0-app-shell-và-sessions)
1. [New session dialog](#1-new-session-dialog)
2. [Session Workspace](#2-session-workspace)
3. [Composer](#3-composer)
4. [Agent detail drawer](#4-agent-detail-drawer)
5. [Approvals](#5-approvals)
6. [Files và File Viewer](#6-files-và-file-viewer)
7. [Agents library](#7-agents-library)
8. [Agent Editor](#8-agent-editor)
9. [Skills và Commands](#9-skills-và-commands)
10. [Memory](#10-memory)
11. [MCP servers](#11-mcp-servers)
12. [Plugins](#12-plugins)
13. [Settings](#13-settings)
14. [CLI và installer](#14-cli-và-installer)
15. [Bảng đối chiếu tính năng](#15-bảng-đối-chiếu-tính-năng)

---

## 0. App shell và Sessions

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ Crewtree    Project: ~/Workspace/my-app ▾          ⚑ 2 pending    ◐    EN ▾    ⚙     │
├───────────────────┬──────────────────────────────────────────────────────────────────────┤
│ WORKSPACE         │  Sessions                              [Search…      ]  [+ New session]│
│  ▣ Sessions       │  Filter: [Status ▾] [Project ▾]                                        │
│                   │  ───────────────────────────────────────────────────────────────────  │
│ CLAUDE CONFIG     │  ● Login feature       5 agents · 3 levels  running   124k tok  2m ago │
│  ◎ Agents     12  │  ✓ Research payment    3 agents · 2 levels  done       58k tok  1h ago │
│  ✦ Skills      8  │  ✕ Refactor billing    4 agents · 2 levels  error      12k tok  1d ago │
│  / Commands    4  │  ○ Draft onboarding    0 agents             idle           —    3d ago │
│  ▤ Memory      5  │                                                                        │
│  ⇄ MCP         3  │  Row hover: [Open] [Rename] [Duplicate] [Save as template] [Delete]    │
│  ⧉ Plugins     2  │                                                                        │
│                   │                                                                        │
│ ───────────────   │                                                                        │
│  ⚙ Settings       │                                                                        │
│  ● Claude Code    │                                                                        │
│    logged in      │                                                                        │
└───────────────────┴────────────────────────────────────────────────────────────────────────┘
  Ctrl+K: command palette (jump to session/agent/skill, run actions)
```

- **Project switcher**: quyết định thư mục `<cwd>/.claude/...` nào được nạp làm project scope.
- **⚑ N pending**: gom yêu cầu duyệt quyền của mọi session (mở Approval Inbox, mục 5).
- **EN ▾**: bộ chọn ngôn ngữ (English / Tiếng Việt), lưu vào DB.
- **◐**: đổi theme (Light / Dark / System), lưu vào DB.
- **Trạng thái Claude Code** ở chân sidebar: logged in / not logged in / rate limited.

Empty state (chưa có session):
```
│                 No sessions yet                                  │
│   Create a session, pick a few agents and give the Supervisor    │
│   a goal.                                   [+ New session]      │
```

---

## 1. New session dialog

```
┌─ New session ───────────────────────────────────────────────────────────┐
│ Session name        [ Login feature                                   ] │
│ Working directory   [ ~/Workspace/my-app                    ] [Browse…] │
│                                                                         │
│ Supervisor          [ crewtree-supervisor       ▾ ]  Model [ Opus 5.5 ▾]│
│                                                                         │
│ Initial agent tree (you can change it later)                            │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ ◆ Supervisor                                                        │ │
│ │  ├─ researcher                     Sonnet 5.5 ▾              [✕]    │ │
│ │  ├─ analyst                        Sonnet 5.5 ▾              [✕]    │ │
│ │  └─ lead-coder   (delegates)       Opus 5.5   ▾  [+ child]   [✕]    │ │
│ │      └─ implementer                Sonnet 5.5 ▾              [✕]    │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ [+ Add agent]    [Use template ▾]                                       │
│                                                                         │
│ ▸ Advanced                                                              │
│   Max concurrent [ 3 ] (≤ global 3)  Max depth [ 4 ]  Max total [ 10 ]  │
│   Max tokens/session [ 500k ]   Max turns/agent [ 60 ]                  │
│   Claude Code config: ☑ CLAUDE.md ☑ Skills/Plugins ☑ Hooks ☑ Permissions│
│   Suspend idle agents after [ 5 ] min                                   │
│   ☐ Git checkpoint before each Supervisor turn                          │
│                                                   [Cancel]  [Create ▸]  │
└─────────────────────────────────────────────────────────────────────────┘
```

- `[+ child]` chỉ hiện với agent có `canDelegate`; danh sách chọn bị giới hạn theo `delegates`.
- Ô Supervisor mặc định là `crewtree-supervisor` (tự tạo với model tốt nhất của tài khoản nếu thư viện chưa có agent `role: supervisor`); chọn được agent khác có `canDelegate`.
- "Claude Code config": 4 nhóm cấu hình nạp vào agent, mặc định bật hết.
- Model dropdown lấy từ danh sách model của tài khoản; chọn ở đây là ghi đè cho session.

**Add agent dialog** (dùng ở đây và trong Workspace):
```
┌─ Add agents ─────────────────────────────────────────────────┐
│ [Search agents…                 ]  Scope [All ▾]             │
│ Parent  [ lead-coder ▾ ]                                     │
│ ☑ implementer     Implements code from a spec…   [User]      │
│ ☐ tester          Writes and runs tests…         [Project]   │
│ ☐ ATAI            B3N-Lib expert…                [User]      │
│                                        [Cancel]  [Add (1)]   │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Session Workspace

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◀ Login feature  ● running   ~/my-app   124k tok · 38 turns   ⚑ 1  [⚙ Session] [⏸] [■ Stop]   │
├──────────────────────────────┬────────────────────────────────────────────────────────────────┤
│ CHAT · Supervisor            │ [Tree] [Files] [Changes]       [Outline] [⊟ All] [⤢ Fit] [+]   │
│                              │                                                                │
│ You  10:20                   │                     ┌──────────────────────┐                   │
│  Build the login page + auth │                     │▍◆ Supervisor      ●  │                   │
│  API using JWT. [spec.md]    │                     │  Opus 5.5            │                   │
│                              │                     │  waiting 2/3 children│                   │
│ Supervisor  10:20            │                     └──────────┬───────────┘                   │
│  I'll split this into 3:     │         ┌──────────────────────┼───────────────────────┐       │
│  ▸ delegated to researcher   │  ┌──────┴───────┐      ┌───────┴──────┐      ┌─────────┴─────┐ │
│  ▸ delegated to analyst      │  │▍researcher ✓ │      │▍analyst    ● │      │▍lead-coder  ● │ │
│  ▸ delegated to lead-coder   │  │ Sonnet 5.5   │      │ Sonnet 5.5   │      │ Opus 5.5    ⊟ │ │
│                              │  │ ✓ task 3m12s │      │ Read spec.md │      │ waiting 1/2   │ │
│  ⟳ waiting for results…      │  └──────────────┘      └──────────────┘      └───────┬───────┘ │
│                              │                                              ┌───────┴──────┐  │
│                              │                                      ┌───────┴─────┐ ┌──────┴─┐│
│                              │                                      │▍impl-1    ● │ │▍impl-2⚑││
│                              │                                      │ Edit Login… │ │approval││
│                              │                                      └─────────────┘ └────────┘│
├──────────────────────────────┤                                                  ┌─ minimap ─┐ │
│ [Composer → Supervisor]      │                                                  │  ▪ ▪▪ ▪   │ │
│                              │                                                  └───────────┘ │
└──────────────────────────────┴────────────────────────────────────────────────────────────────┘
```

**Header:** tên session, trạng thái, cwd, tổng token/turn, số approval đang chờ, Session settings (giới hạn, nguồn config, checkpoint), Pause, Stop.

**Cột trái (resizable ~380px):** chat với Supervisor. Tool call điều phối hiện thành chip `▸ delegated to …`; bấm chip → canvas focus node đó. Kết quả cuối của Supervisor render markdown.

**Canvas:**
- Layout cây từ trên xuống (elkjs), tự sắp xếp khi thêm node nhưng giữ vị trí node người dùng đã kéo.
- Edge smoothstep: nét đứt có animation khi đang có task (hover → tiêu đề task); nét liền xám khi task xong; nhiều task giữa một cặp → một edge + badge "3 tasks".
- Kéo agent từ `[+]` thả lên một node → gắn làm con.
- `⊟` thu gọn nhánh → node hiện `+2 agents · 1 running`.
- Node do agent tự sinh (`spawn_agent`) xuất hiện với animation nhẹ và nhãn nhỏ `spawned by lead-coder`.

**Node anatomy:**
```
┌───────────────────────────────────┐
│▍[icon] lead-coder            ●    │ ← agent color bar · status dot
│  Opus 5.5 ↺                       │ ← ↺ = session model override (click to change)
│  ──────────────────────────────── │
│  ⚙ Bash · npm test                │ ← current activity (1 line, truncated)
│  Task: Auth API          2m14s    │
│  waiting 1/2 · 3 files touched    │
│  12.4k tok · 9 turns       [≡][⊟] │ ← hover: chat, details, collapse
└───────────────────────────────────┘
```

| Trạng thái | Biểu hiện node |
|---|---|
| idle | chấm xám; badge task gần nhất (`✓ task 3m12s`, `✕ task failed`) |
| running | chấm xanh nhấp nháy, viền xanh nhạt |
| waiting_input | chấm vàng, nút Allow/Deny ngay trên node |
| throttled | chấm tím, "Rate limited · retry in 20s" |
| queued | chấm xám viền nét đứt, "Queued · 3 agents running" |
| waiting_children | chấm xanh không nhấp nháy, "Waiting for 1/2 children" |
| needs_input | chấm vàng, badge "Question for <parent>" (Supervisor: "Needs your input" hiện trong chat chính) |
| suspended | node mờ nhẹ, "Suspended · resumes on next task" |
| error | chấm đỏ, viền đỏ nhạt, dòng lỗi rút gọn |

Node hiện **trạng thái agent**; kết quả của task gần nhất hiện dạng badge nhỏ (agent vẫn sống sau khi xong task).
| model unavailable | ⚠ cạnh tên model |

**Node context menu (chuột phải):**
```
┌──────────────────────────────┐
│ View details                 │
│ Chat                         │
│ Change model (this session) ▸│
│ Add child agent…             │
│ Collapse / expand branch     │
│ Stop current task            │
│ Open in Agent Editor         │
│ ──────────────────────────── │
│ Remove from session          │
└──────────────────────────────┘
```

**Outline panel** (cho cây lớn):
```
┌─ Outline ─────────────────────┐
│ ◆ Supervisor            ●     │
│  ├ researcher           ✓     │
│  ├ analyst              ●     │
│  └ lead-coder           ●     │
│     ├ impl-1            ●     │
│     └ impl-2            ⚑     │
└───────────────────────────────┘
```

**Session settings drawer** (`⚙ Session`):
```
┌─ Session settings ─────────────────────────────┐
│ Concurrent [3] (≤3)  Max depth [4]  Total [10] │
│ Max tokens [500k]   Max turns/agent [60]       │
│ Config: ☑ CLAUDE.md ☑ Skills/Plugins           │
│         ☑ Hooks     ☑ Permissions              │
│ Suspend idle agents after [5] min              │
│ ☐ Git checkpoint before each Supervisor turn   │
│ Usage: 124k / 500k tokens  ▓▓▓░░░░░░░          │
│   input 80k · output 44k · cache read 1.2M     │
│ Processes: 4 running · 2 suspended · 1.3 GB RAM│
│                                    [Save]      │
└────────────────────────────────────────────────┘
```

---

## 3. Composer

Một component dùng chung cho: chat Supervisor, chat riêng từng node, Try it trong Agent Editor, AI Generate panel (tắt `/`).

**Mặc định:**
```
┌────────────────────────────────────────────────────────────────────────┐
│ [img login-mock.png ✕]  [pdf spec.pdf ✕]                                │ ← attachments
│ Update [src/auth.ts#L10-24] following [@analyst]'s notes, then /review▌ │ ← chips
│────────────────────────────────────────────────────────────────────────│
│ [📎] [@] [/]    Send to: Supervisor ▾        Enter send · Shift+Enter ↵ [➤]│
└────────────────────────────────────────────────────────────────────────┘
  Paste images (Ctrl+V) or drop files anywhere on the composer.
```

**Khi agent đang bận** (tin nhắn được xếp hàng):
```
│ You 10:31                                                    queued │
│  Use refresh tokens too                       [Interrupt & send now]│
```
Tin nhắn `queued` được giao khi agent xong lượt (hoặc ngay trong kết quả `wait_for_tasks` nếu agent đang chờ con). `Interrupt & send now` ngắt lượt hiện tại và gửi ngay.

**`@` — files và agents:**
```
  ┌─ @ auth ─────────────────────────────────────────┐
  │ RECENT                                           │
  │ ▸ src/auth/auth.service.ts      ✎ impl-1 · 1m    │
  │   src/auth/auth.controller.ts                    │
  │ FILES                                            │
  │   src/pages/Login.tsx                            │
  │   test/auth.spec.ts                              │
  │ AGENTS                                           │
  │   @analyst · @lead-coder                         │
  │ ↑↓ select · Enter insert · # pick lines · Tab preview │
  └──────────────────────────────────────────────────┘
```

**`#` — chọn dòng sau khi chọn file:**
```
  ┌─ src/auth/auth.service.ts  #10-24 ───────────────┐
  │  9 │                                              │
  │ 10 │▌export async function login(dto) {          │ ← drag to select
  │ 11 │▌  const user = await repo.find(dto.email);  │   or type #10-24
  │ …  │▌  …                                          │
  │ 24 │▌}                                            │
  │                       [Cancel]  [Insert #L10-24]  │
  └──────────────────────────────────────────────────┘
```

**`/` — skills và commands:**
```
  ┌─ / rev ──────────────────────────────────────────┐
  │ SKILL      /review         Review changed code   │
  │ COMMAND    /review-pr      Review a PR by number │
  │ PLUGIN     /code-review    (plugin: code-review) │
  └──────────────────────────────────────────────────┘
```

---

## 4. Agent detail drawer

Mở khi bấm node; Esc để đóng; `⤢` mở rộng toàn màn.

```
┌─ Supervisor › lead-coder › impl-1 ─────────────────── [⤢] [✕] ┐
│▍impl-1  ● running   Sonnet 5.5 ▾   12.4k tok · 9 turns  [■]    │
│ [Activity] [Chat] [Tasks] [Changes] [Config]                   │
│────────────────────────────────────────────────────────────────│
```

**Activity:**
```
│ 10:21  ▸ Read   src/auth/auth.service.ts          (120 lines)  │
│ 10:21  "I'll add verifyToken…"                                 │
│ 10:22  ▾ Edit   src/auth/auth.service.ts            +24 −3     │
│        ┌──────────────────────────────────────────┐            │
│        │ - return null;                            │            │
│        │ + return jwt.verify(token, secret);       │            │
│        └──────────────────────────────────────────┘            │
│ 10:22  ⟳ Bash   npm test -- auth                running 14s…   │
│ 10:23  ⚠ Model claude-x-9 unavailable, fell back to Sonnet 5.5 │
│                                                                │
│ Filter: [All ▾]  ☑ Text  ☑ Tools  ☐ Errors only  [Load older ↑]│
```

**Chat** (chat riêng với node):
```
│ lead-coder (parent) 10:20                                      │
│  Implement verifyToken + middleware. Scope: src/auth/**        │
│ impl-1 10:23                                                   │
│  Middleware done, running tests now.                           │
│ You 10:24                                                      │
│  Please add refresh tokens too.                                │
│  (lead-coder has been notified)                                │
│────────────────────────────────────────────────────────────────│
│ [Composer → impl-1]                                            │
```

**Tasks:**
```
│ ● Implement verifyToken + middleware   from lead-coder   2m14s │
│     scope: src/auth/**                          [Cancel task]  │
│ ✓ Create login DTOs                    from lead-coder     48s │
│     Result: Added LoginDto, RegisterDto…        [Show full]    │
```

**Changes:**
```
│ 3 files · +58 −7                                [View all diffs]│
│  src/auth/auth.service.ts        +24 −3    task: verifyToken   │
│  src/auth/jwt.middleware.ts      +31 −0    task: verifyToken   │
│  src/auth/dto/login.dto.ts        +3 −4    task: DTOs          │
```

**Config:**
```
│ Agent: implementer  (User scope)          [Open in Editor]     │
│ Model: Sonnet 5.5 ↺ (session override)    [Reset override]     │
│ Delegation: off            [Enable for this session]           │
│ Tools: Read, Edit, Write, Grep, Glob, Bash                     │
│ Skills: review · MCP: —                                        │
│ ▸ System prompt (snapshot, read-only)                          │
│                                        [Remove from session]   │
└────────────────────────────────────────────────────────────────┘
```

---

## 5. Approvals

**Approval Inbox** (từ `⚑` trên header):
```
┌─ Pending approvals (2) ───────────────────────────────────────────┐
│ ⚑ impl-2 · Login feature                              10:25       │
│   Bash:  npm install jsonwebtoken                                 │
│   [Allow once] [Always allow: <pattern> ▾] [Deny with reason…]    │
│ ───────────────────────────────────────────────────────────────── │
│ ⚑ analyst · Research payment                          10:26       │
│   Write: docs/analysis.md  (new file, 84 lines)  [Preview]        │
│   [Allow once] [Always allow: <pattern> ▾] [Deny with reason…]    │
└───────────────────────────────────────────────────────────────────┘
```

- `Always allow` áp dụng cho agent đó trong session này, theo **tool + mẫu** (cú pháp permission của Claude Code). Gợi ý sẵn và sửa được trước khi lưu, ví dụ `Bash(npm install:*)`, `Write(docs/**)`. Không có lựa chọn cho phép cả tool `Bash`.
- Có browser notification (và âm thanh, tuỳ chọn) khi có yêu cầu mới. Không tự từ chối.

**Inline trên node:**
```
┌───────────────────────────────────┐
│▍impl-2                       ⚑    │
│  Needs approval: Bash             │
│  npm install jsonwebtoken         │
│  [Allow] [Deny] [Details]         │
└───────────────────────────────────┘
```

**Cảnh báo xung đột file** (toast + highlight 2 node):
```
  ⚠ impl-2 tried to edit src/auth/auth.service.ts — locked by impl-1 (task: verifyToken).
    Blocked and reported to lead-coder.                                  [View] [Dismiss]
```

---

## 6. Files và File Viewer

```
┌──────────────────────────────┬─────────────────────────────────────────────────────────────────┐
│ FILES  [Search files…    ]   │ src/auth/auth.service.ts   [View | Diff ▾]  [Open in VS Code] [✕]│
│ ☐ Only files changed by agents│ Edited by impl-1 · 1m ago · +24 −3          Compare with [HEAD ▾]│
│                              │─────────────────────────────────────────────────────────────────│
│ ▾ src                        │  8 │ import jwt from 'jsonwebtoken';                            │
│   ▾ auth                     │  9 │                                                            │
│     ● auth.service.ts   M    │ 10 │▌export async function login(dto: LoginDto) {              │
│     ● jwt.middleware.ts A    │ 11 │▌  const user = await repo.find(dto.email);                │
│       auth.controller.ts     │ 12 │▌  if (!user) throw new UnauthorizedException();           │
│   ▸ pages                    │ 13 │   …                                                        │
│ ▸ test                       │    │        ┌───────────────────────────────────────┐           │
│   package.json               │    │        │ [Mention in chat]  [Copy path#L10-12] │           │
│                              │    │        └───────────────────────────────────────┘           │
│ M modified · A added · ● agent│ Ctrl+F find · Ctrl+G go to line · live-updates on change       │
└──────────────────────────────┴─────────────────────────────────────────────────────────────────┘
```

**Diff mode** (side-by-side):
```
│ HEAD                               │ Current (impl-1)                       │
│ 14 │   return null;                │ 14 │   return jwt.verify(token, secret); │
```

- Mở file từ: chip mention, đường dẫn trong tin nhắn, tool call trong Activity, Files touched, tab Changes, cây Files.
- "Compare with": HEAD / checkpoint (git) hoặc snapshot trước Edit; lọc theo agent/task.
- File > 2MB hoặc binary: chỉ hiện thông tin. Ảnh: preview. Markdown: nút Render.
- MVP chỉ đọc.

---

## 7. Agents library

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Agents                  [Search…      ]  Scope [All ▾]  [Bulk change model]  [+ New agent] │
│ ☐ Select multiple                                                                          │
│ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ ┌────────────┐ │
│ │▍ATAI          [User] │ │▍lead-coder    [User] │ │▍Explore    [Built-in]│ │▍code-review│ │
│ │ B3N-Lib expert…      │ │ Tech lead. Breaks…   │ │ Read-only search…    │ │ [Plugin]   │ │
│ │ Sonnet 5 · 6 tools   │ │ Opus 5.5 · delegates │ │ inherit              │ │ …          │ │
│ │ ✦ 2 skills           │ │ → implementer        │ │          🔒 read-only │ │ 🔒          │ │
│ │ [Edit][Duplicate][⋯] │ │ [Edit][Duplicate][⋯] │ │ [Duplicate as mine]  │ │ [Duplicate]│ │
│ └──────────────────────┘ └──────────────────────┘ └──────────────────────┘ └────────────┘ │
│ ┌──────────────────────┐ ┌──────────────────────┐                                         │
│ │▍MLAI          [User] │ │▍old-agent ⚠ [Project]│ ← ⚠ model unavailable                   │
│ │ …                    │ │ model: claude-x-9 ✕  │                                         │
│ └──────────────────────┘ └──────────────────────┘                                         │
│ ⋯ = Export .md · Reveal file · Move to scope… · Version history · Delete                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- Scope gồm: `Crewtree` (`~/.crewtree/agents/`, chỉ Crewtree dùng — `crewtree-supervisor` nằm ở đây), `User`, `Project`, `Plugin`, `Built-in`.
- Mọi agent sẵn có (User, Project, Plugin, Built-in) hiện ngay, không cần tạo lại; file đổi ngoài app → cập nhật ~1 giây.
- Bulk change model: chọn nhiều card → chọn model → xem danh sách file sẽ đổi → Apply.

---

## 8. Agent Editor

```
┌─ ◀ Agents / lead-coder ──────────────── [User scope ▾]  ● Unsaved   [History ▾] [Save] ┐
├─────────────────────────────────────────────┬────────────────────────────────────────────┤
│ BASICS                                      │ [✨ Generate with AI] [Try it] [.md file]   │
│ Name    [ lead-coder           ]  Icon [◎▾] │────────────────────────────────────────────│
│ Color   ● ● ● ● ● ●                         │ Describe the agent you want…               │
│ Description (used to pick this agent) [?]   │ ┌────────────────────────────────────────┐ │
│ [ Tech lead. Breaks work down, delegates  ] │ │ [Composer: "A lead dev for a NestJS    │ │
│ [ to implementers, reviews results.       ] │ │  project, splits tasks by module…"]    │ │
│                                             │ └────────────────────────────────────────┘ │
│ MODEL                                       │ [Generate new]   [Improve current prompt]  │
│ [ Claude Opus 5.5 (1M context)   ▾ ] ↻      │                                            │
│ Effort [ high ▾ ]   Max turns [ 60 ]        │ ── Result (streaming) ──                   │
│                                             │ name: lead-coder                           │
│ DELEGATION                                  │ description: …                             │
│ ☑ Can delegate (canDelegate)                │ suggested tools: Read, Grep, Glob          │
│ Can spawn / delegate to: [implementer ✕] [+]│ system prompt: You are a tech lead…        │
│                                             │                                            │
│ PERMISSIONS & TOOLS                         │ [View diff vs current]   [Apply]           │
│ Tools: ☑Read ☑Grep ☑Glob ☑Edit ☐Write ☐Bash │                                            │
│        ☐WebFetch ☐WebSearch   [+ MCP tools] │                                            │
│ Permission mode [ default ▾ ]               │                                            │
│ Skills  [review ✕] [+]                      │                                            │
│ MCP     [github ✕] [+]                      │                                            │
├─────────────────────────────────────────────┤                                            │
│ SYSTEM PROMPT              [Markdown] [⤢]   │                                            │
│ ┌─────────────────────────────────────────┐ │                                            │
│ │ 1 You are a tech lead…                  │ │                                            │
│ │ 2 ## Workflow                           │ │                                            │
│ │ 3 - Split tasks by file/module…         │ │                                            │
│ └─────────────────────────────────────────┘ │                                            │
└─────────────────────────────────────────────┴────────────────────────────────────────────┘
```

**Model picker** (danh sách lấy từ tài khoản Claude Code):
```
Model  [ Claude Opus 5.5 (1M context)          ▾ ]   ↻
       ┌──────────────────────────────────────────┐
       │ Search models…                           │
       │ ● Claude Opus 5.5 (1M)   most capable…   │
       │ ○ Claude Sonnet 5.5      balanced…       │
       │ ○ Claude Haiku 5.5       fast…           │
       │ ○ Claude Fable 5.1       …               │
       │ ○ inherit                from parent/session│
       └──────────────────────────────────────────┘
```

**Try it tab:**
```
│ Sandbox · cwd: [~/my-app ▾] · ☐ Allow file writes      [Reset] │
│ You: Split the login feature into tasks                        │
│ lead-coder: (delegation is simulated in the sandbox)…          │
│ [Composer]                                                     │
```

**.md file tab:** sửa trực tiếp nội dung file, frontmatter được validate realtime.

**History ▾:** danh sách version → View diff · Rollback.

Rời trang khi chưa lưu → hộp xác nhận "Discard unsaved changes?".

---

## 9. Skills và Commands

Commands dùng cùng layout (không có cây file phụ).

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Skills                      [Search…      ]  Scope [All ▾]    [✨ Create with AI] [+ New] │
├────────────────────────────┬─────────────────────────────────────────────────────────────┤
│ ✦ review          [User]   │ review                    [User]  [History ▾] [Delete] [Save]│
│ ✦ deploy       [Project]   │ Description (decides when the skill is triggered) [?]       │
│ ✦ code-review  [Plugin] 🔒 │ [ Review changed code against a checklist…                ] │
│ ✦ docx         [Plugin] 🔒 │─────────────────────────────────────────────────────────────│
│                            │ FILES                  │ SKILL.md                           │
│ Used by agents:            │ ▾ review/              │ 1 ---                              │
│  lead-coder, ATAI          │    SKILL.md            │ 2 name: review                     │
│                            │    checklist.md        │ 3 description: …                   │
│                            │  ▸ scripts/            │ 4 ---                              │
│                            │ [+ File]               │ 5 # Review workflow…               │
└────────────────────────────┴─────────────────────────────────────────────────────────────┘
```

**AI Generate panel** (dùng chung cho agent/skill/command/memory/MCP/plugin):
```
┌─ Create skill with AI ──────────────────────────────────────────────┐
│ [Composer: "A skill that creates TypeORM migrations named by…"]     │
│ Scope: (●) Project  ( ) User                                        │
│ Output language: Follow interface (English)                         │
│ ── Result ───────────────────────────────────────────────────────── │
│ ▾ migration/                                                        │
│    SKILL.md            (preview ▸)                                  │
│    template.ts         (preview ▸)                                  │
│                              [Regenerate]  [Refine…]  [Apply]       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 10. Memory

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Memory                                                            [✨ AI: Add a rule]      │
├────────────────────────────────┬─────────────────────────────────────────────────────────┤
│ USER                           │ ~/.claude/CLAUDE.md                [History ▾] [Save]   │
│ ▾ ~/.claude/CLAUDE.md          │─────────────────────────────────────────────────────────│
│    ├ @RTK.md                   │ 1 @RTK.md                       ← click to open import   │
│    ├ @ATAI.md                  │ 2 @ATAI.md                                              │
│    └ @MLAI.md                  │ 3 @MLAI.md                                              │
│ PROJECT (~/my-app)             │ 4                                                       │
│ ▸ CLAUDE.md                    │ 5 # Truncated output                                    │
│ ▸ .claude/CLAUDE.local.md      │ 6 …                                                     │
│ AUTO MEMORY                    │                                                         │
│ ▾ memory/  (5)                 │                                                         │
│    MEMORY.md (index)           │                                                         │
│    ref_b3lib_overview.md       │                                                         │
│    …                           │                                                         │
│                                │                                                         │
│ [✨ AI: Clean up & merge]       │                                                         │
└────────────────────────────────┴─────────────────────────────────────────────────────────┘
```

- AI actions luôn hiện diff trước khi ghi; mỗi lần ghi tạo revision.

---

## 11. MCP servers

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ MCP servers                                        [✨ Create config with AI]  [+ Add]     │
│──────────────────────────────────────────────────────────────────────────────────────────│
│ ● github          stdio  npx @mcp/github  [User]     ✓ connected · 24 tools [Test][Edit][⏻]│
│ ● chrome-devtools stdio  …                [User]     ✓ 40 tools             [Test][Edit][⏻]│
│ ○ postgres        stdio  …                [Project]  ✕ ECONNREFUSED         [Test][Edit][⏻]│
│ ⧉ figma           http   (plugin: figma)  [Plugin]🔒                        [Test]         │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Edit form:**
```
┌─ Edit MCP server ───────────────────────────────────┐
│ Name    [ github                ]  Scope [User ▾]   │
│ Type    (●) stdio  ( ) http  ( ) sse                │
│ Command [ npx                   ]                   │
│ Args    [ -y @mcp/github        ]                   │
│ Env     GITHUB_TOKEN = ••••••••  [show] [✕]  [+]   │
│                     [Test connection] [Cancel] [Save]│
└─────────────────────────────────────────────────────┘
```

---

## 12. Plugins

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Plugins                 [Installed] [Marketplace]          [✨ Scaffold plugin with AI]    │
│──────────────────────────────────────────────────────────────────────────────────────────│
│ ⧉ agentmemory     v1.4   ⏻ on    2 agents · 14 skills · 1 MCP · hooks  [Details] [Uninstall]│
│ ⧉ diagram-design  v0.9   ⏻ on    7 skills                              [Details] [Uninstall]│
│                                                                                          │
│ Details ▾ agentmemory                                                                    │
│   Agents: —   Skills: recall, remember, recap…   Commands: …   MCP: agentmemory          │
│   Hooks: SessionStart, PostToolUse                                                       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Marketplace tab:**
```
│ Marketplaces: [official ▾]  [+ Add marketplace]      [Search plugins…        ]          │
│ ⧉ code-review     Review PRs and diffs…                      [Install]                  │
│ ⧉ figma           Figma design-to-code…                      ✓ Installed                │
```

---

## 13. Settings

**General:**
```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Settings     [General] [Models] [Defaults] [Limits] [Account]                             │
│──────────────────────────────────────────────────────────────────────────────────────────│
│ LANGUAGE                                                                                 │
│  Interface language            [ English          ▾ ]   (English / Tiếng Việt)           │
│  Generated content language    [ Follow interface ▾ ]   (Follow interface / EN / VI)     │
│    Used when AI generates agents, skills, commands and memory files.                     │
│    Chat replies always match the language you write in.                                  │
│                                                                                          │
│ APPEARANCE                                                                               │
│  Theme                         [ System ▾ ]             (Light / Dark / System)          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Header language switcher:**
```
                                                    ⚑ 2 pending   ◐   EN ▾   ⚙
                                                              ┌───────────────────┐
                                                              │ ✓ English    EN   │
                                                              │   Tiếng Việt VI   │
                                                              └───────────────────┘
```

**Khi chọn Tiếng Việt** (đổi ngay, không reload; lần sau mở vẫn giữ):
```
│ Cài đặt     [Chung] [Model] [Mặc định] [Giới hạn] [Tài khoản]                            │
│ NGÔN NGỮ                                                                                 │
│  Ngôn ngữ giao diện               [ Tiếng Việt      ▾ ]                                  │
│  Ngôn ngữ nội dung do AI tạo      [ Theo giao diện  ▾ ]                                  │
```

**Models:**
```
│ MODELS (from your Claude Code account)              Updated 10:02  [↻ Refresh]           │
│  ✓ Claude Opus 5.5 (1M)      claude-opus-5-5          most capable                       │
│  ✓ Claude Sonnet 5.5         claude-sonnet-5-5        balanced                           │
│  ✓ Claude Haiku 5.5          claude-haiku-5-5         fast                               │
│  ✓ Claude Fable 5.1          claude-fable-5-1                                            │
```

**Defaults:**
```
│  Delegating agents model  [ Opus 5.5 ▾ ]      Worker agents model   [ Sonnet 5.5 ▾ ]     │
│  AI Generate model        [ Sonnet 5.5 ▾ ]    Fallback model        [ Sonnet 5.5 ▾ ]     │
```

**Limits:**
```
│  GLOBAL (all sessions — one account quota)                                               │
│  Max concurrent agents [3]   Suspend idle agents after [5] min                           │
│  Keep events of closed sessions [30] days                    [Clean up now]              │
│  SESSION DEFAULTS                                                                        │
│  Max depth [4]  Max total agents [10]  Max tokens/session [500k]  Max turns/agent [60]   │
```

**Account:**
```
│  ● Claude Code: logged in            Rate limit: normal                                  │
│  Data directory: ~/.crewtree        Server: http://localhost:4317                       │
```

---

## 14. CLI và installer

Toàn bộ output CLI bằng tiếng Anh.

**Install — thành công** (`curl … | sh`, bản build sẵn từ GitHub Releases):
```
$ curl -fsSL https://github.com/<owner>/crewtree/releases/latest/download/install.sh | sh

  ◆ Crewtree installer

  [1/4] Checking environment
        ✓ macOS arm64
        ✓ Node v22.11.0
        ✓ Claude Code · logged in
  [2/4] Downloading v0.1.0
        ######################################## 100%  18.2 MB
  [3/4] Verifying & extracting
        ✓ SHA256 checksum OK
        ✓ Extracted to ~/.crewtree/app/v0.1.0
  [4/4] Setting up
        ✓ Command `crewtree` → ~/.local/bin/crewtree
        ! Add this line to ~/.zshrc, then open a new terminal:
            export PATH="$HOME/.local/bin:$PATH"

  ✔ Crewtree v0.1.0 installed in 9s
  Run: crewtree
  Log: ~/.crewtree/logs/install-2026-10-20T10-20.log
```

**Install — lỗi môi trường:**
```
  [1/4] Checking environment
        ✓ macOS arm64
        ✓ Node v22.11.0
        ✕ Claude Code is not logged in

  How to fix:
    claude login
  Then re-run the install command.
```

**Install — sai checksum:**
```
  [3/4] Verifying & extracting
        ✕ Checksum mismatch for crewtree-v0.1.0-darwin-arm64.tar.gz
          The download was removed. Please try again.
```

**Update:**
```
$ crewtree update

  ◆ Crewtree update

  Current: v0.1.0   Latest: v0.2.0
  What's new: https://github.com/<owner>/crewtree/releases/tag/v0.2.0

  [1/5] Downloading v0.2.0             ######################## 100%  18.4 MB
  [2/5] Verifying checksum             ✓ SHA256 OK
  [3/5] Extracting                     ✓ ~/.crewtree/app/v0.2.0
  [4/5] Migrating data                 ✓ Backup: ~/.crewtree/backups/crewtree-v0.1.0.db
                                       ✓ 2 migrations applied
  [5/5] Switching & restarting         ✓ current → v0.2.0
                                       ✓ Server restarted on http://localhost:4317

  ✔ Updated v0.1.0 → v0.2.0 in 11s
  Roll back anytime with: crewtree rollback
```

**Update khi có session đang chạy:**
```
  ! 2 sessions are running (Login feature, Research payment).
    [w] Wait until they finish   [f] Update now (running tasks become interrupted)   [c] Cancel
```

**Thông báo bản mới trên CLI:**
```
  ↑ Crewtree v0.2.0 is available (you have v0.1.0). Run: crewtree update
```

**Banner trên web** (có thể tắt; Settings → General → Check for updates):
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ↑ v0.2.0 available · What's new · How to update                         [✕] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Các lệnh khác:**
```
$ crewtree
  ✓ Server started on http://localhost:4317
  ✓ Opened in browser · project: ~/Workspace/my-app

$ crewtree status
  ● Running · pid 48213 · port 4317 · uptime 2h 14m · 2 active sessions

$ crewtree uninstall
  This will remove:
    • ~/.local/bin/crewtree
    • PATH entry in ~/.zshrc
  Your data in ~/.crewtree/ will be kept (use --purge to delete it).
  Continue? (y/N)
```

**Install trên Windows (PowerShell):**
```
PS> irm https://github.com/<owner>/crewtree/releases/latest/download/install.ps1 | iex

  ◆ Crewtree installer

  [1/4] Checking environment
        ✓ Windows x64
        ✓ Node v22.11.0
        ✓ Claude Code · logged in
        ✓ Git Bash found (required by Claude Code)
  [2/4] Downloading v0.1.0
        ######################################## 100%  19.0 MB
  [3/4] Verifying & extracting
        ✓ SHA256 checksum OK
        ✓ Extracted to %USERPROFILE%\.crewtree\app\v0.1.0
  [4/4] Setting up
        ✓ Command `crewtree` → %USERPROFILE%\.crewtree\bin\crewtree.cmd
        ✓ Added to your user PATH (open a new terminal to use it)

  ✔ Crewtree v0.1.0 installed in 11s
  Run: crewtree
```

Biến môi trường của installer (dùng chung cho `install.sh` và `install.ps1`): `CREWTREE_VERSION`, `CREWTREE_INSTALL_DIR`, `CREWTREE_MODIFY_PATH=1` (chỉ macOS), `NO_COLOR`. Linux/WSL hỗ trợ ở Phase 8.

---

## 15. Bảng đối chiếu tính năng

| Tính năng | Màn hình |
|---|---|
| Tạo, sửa, xoá, nhân bản, import/export agent; version | 7, 8 |
| Sinh và cải thiện prompt bằng AI | 8, panel AI ở 9 |
| Chọn model theo tài khoản; đổi theo agent, session, hàng loạt | 8, 2 (node), 7, 13 |
| Tạo session, dựng cây ban đầu, giới hạn | 1, 2 (Session settings) |
| Điều phối cây N tầng, thu gọn nhánh, outline | 2 |
| Chat với Supervisor, chat riêng từng node | 2, 4 |
| Composer chung: đính kèm, `@file`, `#dòng`, `@agent`, `/skill` | 3 |
| Xem agent đang làm gì | 4 (Activity) |
| Task, kết quả, huỷ | 4 (Tasks) |
| Duyệt quyền, xung đột file | 5 |
| Xem file, diff, chọn dòng để mention | 6 |
| Skills, Commands | 9 |
| Memory | 10 |
| MCP servers | 11 |
| Plugins, marketplace | 12 |
| Tài nguyên có sẵn tự hiện (User/Project/Plugin/Built-in) | 7, 9–12 |
| Ngôn ngữ EN/VI lưu DB, generated content language, theme | 0, 13 |
| CLI `crewtree`, cài bằng curl, update/rollback, thông báo bản mới | 14 |
| Command palette Ctrl+K | 0 |
