# Crewtree — Kế hoạch triển khai

> Hệ thống quản lý và điều phối nhiều agent trên nền Claude Code, có giao diện web chạy local.
> Wireframe chi tiết các màn hình: [UI-WIREFRAMES.md](./UI-WIREFRAMES.md)

---

## 0. Các quyết định đã chốt

| # | Chủ đề | Quyết định |
|---|---|---|
| 1 | Frontend | React |
| 2 | Phạm vi chạy | Local, 1 người dùng, không có tài khoản người dùng (truy cập web được bảo vệ bằng token phiên), không deploy |
| 3 | Xác thực | Dùng tài khoản Claude Code đã `claude login` (không dùng API key) |
| 4 | Lưu định nghĩa agent | File `.md` tương thích Claude Code (`~/.claude/agents`, `<project>/.claude/agents`). Agent riêng của Crewtree (Supervisor mặc định…) nằm ở scope **Crewtree** `~/.crewtree/agents/` để Claude Code CLI không gọi nhầm (mục 6.1) |
| 5 | Cấu trúc agent | Cây **N tầng**: node nào có `canDelegate` đều có thể có agent con |
| 6 | Thư mục làm việc | Mọi agent trong session làm chung một `cwd`, có cơ chế khoá file chống xung đột |
| 7 | Agent tự sinh agent con | Chỉ được sinh agent **đã có sẵn** trong thư viện và nằm trong danh sách `delegates` |
| 8 | Duyệt quyền | Người dùng duyệt trên UI, ở mọi tầng |
| 9 | Model | Lấy động toàn bộ model mà tài khoản Claude Code dùng được; đổi được theo agent, theo session, hàng loạt |
| 10 | Checkpoint git | Tuỳ chọn, mặc định tắt |
| 11 | Agent/skill/memory… có sẵn | Tự hiện trên web (quét file + watcher), không cần tạo lại |
| 12 | Cách chạy | Lệnh `crewtree` ngoài terminal. **Không** đăng ký slash command/plugin/MCP vào Claude Code |
| 13 | Cài đặt | Một dòng lệnh, tải bản build sẵn từ GitHub Releases: macOS `curl -fsSL …/install.sh \| sh`, Windows `irm …/install.ps1 \| iex`; hiện tiến trình từng bước, output bằng tiếng Anh. `git clone` chỉ dùng cho dev |
| 14 | Ngôn ngữ UI | Tiếng Anh (mặc định) và tiếng Việt, chọn trên web, lưu vào DB |
| 15 | Ngôn ngữ AI | Chat: AI trả lời theo ngôn ngữ người dùng viết. Nội dung AI sinh ra để lưu file: theo setting "Generated content language" |
| 16 | Runtime | MVP chỉ chạy Claude Code. Kiến trúc có sẵn trường `runtime` và `AgentDriver` theo khả năng để thêm OpenCode, Codex CLI, Gemini CLI ở Phase 9. Antigravity tạm gác (chưa có API công khai) |
| 17 | Hệ điều hành | MVP hỗ trợ **macOS và Windows (chạy trực tiếp)**. **macOS là nền tảng chính**: phát triển và kiểm thử trên Mac trước ở mọi phase; Windows được CI kiểm tra từ Phase 0 và hoàn thiện đóng gói (`install.ps1`) ở Phase 7. Linux/WSL để Phase 8 |
| 18 | Cập nhật | `crewtree update` / `crewtree rollback`; mỗi phiên bản một thư mục riêng, sao lưu DB trước migration; thông báo bản mới trên CLI và web |
| 19 | Tên dự án | **Crewtree** (crew + tree). Đổi từ tên tạm "Conductor" vì trùng với app https://conductor.build. Đã kiểm tra 21/10/2026: npm `crewtree` còn trống, GitHub chưa có repo trùng tên |
| 20 | License | **Apache-2.0**, bản quyền đứng tên cá nhân (dự án cá nhân, không liên quan công ty). Kèm `NOTICE`, `TRADEMARKS.md`, DCO, kiểm tra license dependency, ký release (mục 21) |
| 21 | Phân phối | Hiện tại chỉ qua GitHub Releases. **Publish npm là dự định tương lai**, chưa làm |
| 22 | Supervisor mặc định | Nếu thư viện chưa có agent `role: supervisor`, Crewtree tự tạo `crewtree-supervisor` trong scope Crewtree (`~/.crewtree/agents/`) với model tài khoản đề xuất, ghi bằng alias để tự lên bản mới; đã có thì không tạo lại, không ghi đè (mục 4.1) |
| 23 | Bảo mật server local | Chỉ nghe `127.0.0.1`, kiểm tra `Host`/`Origin`, token phiên qua cookie `HttpOnly` (mục 15.3) |
| 24 | Giới hạn đồng thời | Đặt **chung** ở Settings → Limits (cả máy dùng chung quota); session chỉ đặt được mức thấp hơn. Chỉ tính agent **đang sinh output**; agent đang chờ con/chờ duyệt không giữ slot → không deadlock (mục 4.3) |
| 25 | Kết thúc task | Agent con báo xong bằng `complete_task`, hỏi lại cha bằng `ask_parent`. Mỗi tin nhắn người dùng gửi Supervisor tạo một **root task** (mục 4.2) |
| 26 | Scope `task` | Server kiểm tra: `delegate_task` bị từ chối nếu `scope` trùng task đang chạy; sửa file ngoài `scope` → đưa lên Approval (mục 5) |

---

## 1. Mục tiêu và phạm vi

| # | Tính năng | Ưu tiên |
|---|---|---|
| F1 | Quản lý agent: tạo, sửa, xoá, nhân bản, import/export, lịch sử version | MVP |
| F2 | Tự sinh và cải thiện system prompt bằng AI | MVP |
| F3 | Tạo session, dựng cây agent ban đầu, thêm/gỡ agent khi đang chạy | MVP |
| F4 | Supervisor và các node điều phối giao task cho agent con, theo dõi, tổng hợp kết quả (cây N tầng) | MVP |
| F5 | Ô chat chính với Supervisor: đính kèm ảnh/file, mention `@file`, `#dòng`, `@agent`, `/skill` | MVP |
| F6 | Sơ đồ cây trực quan, trạng thái realtime, thu gọn nhánh, outline | MVP |
| F7 | Bấm node: xem Activity, Chat riêng, Tasks, Changes, Config | MVP |
| F8 | Duyệt quyền tool trên UI, cảnh báo xung đột file | MVP |
| F9 | File Viewer: xem file, diff, chọn dòng để mention | MVP |
| F10 | Claude Config Manager: Skills, Commands, Memory, MCP servers, Plugins (có tạo bằng AI) | MVP |
| F11 | Settings: model, mặc định, giới hạn, ngôn ngữ, theme | MVP |
| F12 | CLI `crewtree`, cài bằng `curl \| sh` (macOS) / `irm \| iex` (Windows), update/rollback, thông báo bản mới | MVP |
| F13 | Mention theo symbol, sửa file trực tiếp, template session, UI cho settings/hooks, hỗ trợ Linux/WSL, file chạy độc lập không cần Node | Phase 8 |
| F14 | Nhiều runtime: OpenCode, Codex CLI, Gemini CLI; trộn runtime trong một cây | Phase 9 |

**Ngoài phạm vi:** nhiều người dùng, đăng nhập, deploy cloud, phân phối cho người khác dùng tài khoản Claude của họ, Antigravity (cho tới khi có API công khai).

---

## 2. Kiến trúc tổng thể

```
                ┌───────────────────────────────────────────────────────┐
                │                 Crewtree Server (Node)               │
                │                                                       │
 Browser ─WS──► │  ┌───────────────┐  orchestrator MCP (nội bộ)         │
  (React)       │  │ Supervisor    │── list_agents / spawn_agent        │
 ─REST────────► │  │ AgentRuntime  │── delegate_task / wait_for_tasks   │
                │  └──────┬────────┘── message_agent / cancel_task      │
                │         │ con                                         │
                │  ┌──────▼────────┐   ┌──────────────┐                 │
                │  │ lead-coder    │──►│ implementer  │  … (N tầng)     │
                │  │ (canDelegate) │   └──────────────┘                 │
                │  └───────────────┘                                    │
                │         │  mọi SDK message                            │
                │         ▼                                             │
                │  eventNormalizer → EventBus → SQLite + WS broadcast   │
                │                                                       │
                │  FileLockManager · ApprovalService · TaskManager      │
                │  ResourceScanner (~/.claude, <cwd>/.claude) + watcher │
                │  ModelCatalogService · SettingsService · FsService    │
                └───────────────────────────────────────────────────────┘
                          │ mỗi AgentRuntime = 1 phiên Claude Code
                          ▼
                Claude Agent SDK / Claude Code CLI (tài khoản đã login)
```

**Ý tưởng cốt lõi:** không dùng cơ chế subagent có sẵn (tool `Task`) vì đó là hộp đen: không chat riêng được, không stream trạng thái từng subagent ra UI. Thay vào đó, **mỗi agent là một phiên Claude Code riêng** do server quản lý. Các node điều phối được gắn một MCP server nội bộ chứa tool điều phối, server thực thi các tool này bằng cách tạo và điều khiển phiên của agent con.

---

## 3. Runtime và xác thực

### 3.1 AgentDriver
Interface chung, hai cài đặt:

| Driver | Cách chạy | Ghi chú |
|---|---|---|
| **SdkDriver** (mặc định) | `@anthropic-ai/claude-agent-sdk` `query()` với streaming input | Có type, MCP chạy chung tiến trình, hooks trong code |
| **CliDriver** (dự phòng) | spawn `claude -p --input-format stream-json --output-format stream-json --resume … --mcp-config … --allowedTools …` | Dùng khi SdkDriver không chạy được bằng credential của `claude login` |

### 3.2 AgentRuntime (mỗi agent trong session có một)
- `inputQueue`: async iterable, cho phép đẩy tin nhắn vào bất cứ lúc nào (từ cha, từ người dùng).
- Options: system prompt (snapshot) + đoạn quy tắc ngôn ngữ (mục 11), model, allowedTools (= `tools` của agent **+ `mcp__crewtree__*` luôn được tự thêm**), `cwd` của session, `resume` = `sdk_session_id`, `abortController`, hooks `PreToolUse`/`PostToolUse`, `canUseTool` → ApprovalService.
- Duyệt message trả về → `eventNormalizer` → EventBus.
- Mỗi agent xử lý task theo hàng đợi, một lúc một task; các agent khác nhau chạy song song.
- **Context giữa các task:** mặc định giữ **chung một phiên** suốt session (agent nhớ việc trước; Claude Code tự nén context khi dài). Tuỳ chọn `freshContextPerTask: true` (frontmatter hoặc ghi đè trong session) để mỗi task bắt đầu phiên mới.
- **Tool điều phối gắn theo agent:**
  - SdkDriver: mỗi agent có một MCP server chạy chung tiến trình (`createSdkMcpServer`), closure giữ sẵn `sessionAgentId`.
  - CliDriver: HTTP MCP `/mcp/:sessionAgentId` với token riêng cho từng agent (truyền qua `--mcp-config`), token hết hiệu lực khi agent bị dispose.
- **Tắt agent rảnh:** agent không có task và không có tin nhắn mới trong `idleSuspendMinutes` (mặc định 5) → dispose tiến trình, trạng thái `suspended`. Có task/tin nhắn mới → dựng lại bằng `resume` = `sdk_session_id`. Session settings hiển thị số tiến trình đang chạy và RAM.
- `dispose()`: abort, đóng queue, reject waiter, nhả file lock.

### 3.3 Hệ quả của việc dùng tài khoản subscription
- Không tính tiền theo token → UI hiển thị **token và turn**, không hiển thị `$`. Giới hạn session tính bằng `maxTokens`, `maxTurns`.
- Token được tính là **input + output, không tính cache read** (cache read làm số liệu tăng ảo rất lớn). UI hiện chi tiết từng loại (input, output, cache read, cache write).
- Mọi agent chạy song song dùng chung quota → `maxConcurrentAgents` (mặc định 3). Khi bị rate limit: trạng thái `throttled`, retry có backoff, UI hiện thời gian chờ.
- Chỉ dùng cho cá nhân, không đóng gói để người khác đăng nhập tài khoản Claude của họ.

### 3.4 Trạng thái agent và trạng thái task
Agent tồn tại suốt session và nhận nhiều task, nên tách hai bộ trạng thái:

**Agent:**
- `idle`: không có việc
- `running`: đang sinh output (giữ một slot đồng thời)
- `queued`: có việc nhưng chờ slot vì đã đủ `maxConcurrentAgents`
- `waiting_children`: đang chờ con trong `wait_for_tasks`
- `waiting_input`: chờ người dùng duyệt quyền
- `needs_input`: đã `ask_parent`, chờ cha (hoặc người dùng) trả lời
- `throttled`: bị rate limit, đang chờ retry
- `suspended`: tiến trình đã tắt vì rảnh, dựng lại được
- `error`: tiến trình lỗi, cần chạy lại

**Task:** `queued → running ⇄ needs_input → done | failed | cancelled`, thêm `interrupted` (server khởi động lại giữa chừng).

Node trên canvas hiện **trạng thái agent**, kèm badge trạng thái **task gần nhất** (vd. `idle · ✓ task 3m12s`).

### 3.5 Chuẩn bị cho nhiều runtime (thiết kế từ Phase 0, triển khai ở Phase 9)
MVP chỉ có runtime `claude`, nhưng các điểm sau làm ngay từ đầu để sau này không phải sửa lại:
- Agent có trường `runtime` (mặc định `claude`). Mỗi node trên canvas hiện badge runtime khi có nhiều hơn một runtime.
- `AgentDriver` khai báo **khả năng** (capabilities); UI và server dựa vào đó để bật/tắt tính năng:

| Capability | Dùng cho |
|---|---|
| `supportsPreToolHook` | FileLock chặn trước khi sửa. Không có → chỉ phát hiện xung đột sau khi sửa và cảnh báo |
| `supportsPermissionCallback` | Duyệt quyền trên UI |
| `supportsStreamingInput` | Đẩy tin nhắn vào giữa chừng |
| `supportsResume` | Tiếp tục sau khi server khởi động lại |
| `supportsModelList` | Lấy danh sách model động |
| `supportsSkills`, `supportsPlugins`, `supportsMemoryFiles` | Hiện/ẩn các mục Claude Config tương ứng |

- Tool điều phối chạy qua **MCP**, mà các runtime dự kiến đều hỗ trợ MCP → logic điều phối, cây N tầng, TaskManager dùng chung hoàn toàn.
- Mỗi runtime có `eventNormalizer`, `ModelCatalog` và resource adapter riêng (vd. `~/.claude/agents` so với `.opencode/agent`).

| Runtime | Đánh giá | Cách điều khiển dự kiến |
|---|---|---|
| Claude Code | ✅ MVP | Agent SDK / CLI stream-json |
| OpenCode | ✅ Phase 9 (ưu tiên đầu) | `opencode serve` + HTTP API/SDK |
| Codex CLI | ✅ Phase 9 | Chế độ headless, output JSON |
| Gemini CLI | ⚠ Phase 9, cần spike | Headless + MCP; kiểm tra streaming và permission |
| Antigravity | ❌ Gác lại | IDE, chưa có API để điều khiển từ bên ngoài |

> Thông tin về runtime khác cần kiểm tra lại tài liệu mới nhất khi bắt đầu Phase 9.

Ví dụ cây trộn runtime:
```
◆ Supervisor            (claude · Opus)
 ├─ researcher          (gemini-cli)
 └─ lead-coder          (claude · Sonnet)
     └─ implementer     (opencode · model khác)
```

### 3.6 Cấu hình Claude Code được nạp vào agent
Tách thành 4 nhóm, bật/tắt riêng trong dialog New session và Session settings:

| Nhóm | Gồm | Mặc định |
|---|---|---|
| CLAUDE.md | Memory user + project, các file `@import` | Bật |
| Skills / Plugins | Skills, commands, agent và MCP do plugin cung cấp | Bật |
| Hooks | Hooks trong `settings.json` (vd. RTK, agentmemory) | Bật |
| Permissions | Rule allow/deny trong `settings.json` | Bật |

- Mặc định bật cả 4 để agent con hành xử giống Claude Code người dùng đang dùng.
- Permission rule trong `settings.json` được áp dụng trước; chỉ những gì chưa được cho phép mới đưa lên Approval.
- Spike Phase 0: kiểm tra `settingSources` của SDK có tách riêng được từng nhóm không. Nếu không, Crewtree tạo file settings tạm cho session chỉ chứa các nhóm được bật.

---

## 4. Điều phối cây N tầng

### 4.1 Mô hình
- Node gốc là **Supervisor**. Mọi agent có `canDelegate: true` là **node điều phối**, có thể có con.
- **Supervisor mặc định:** khi server khởi động và khi mở dialog New session, nếu thư viện chưa có agent nào `role: supervisor`, Crewtree tạo `~/.crewtree/agents/crewtree-supervisor.md` (scope Crewtree, Claude Code CLI không thấy) từ template (system prompt ở Phụ lục A.1):
  - `model`: model mà tài khoản đề xuất (mục "Default (recommended)" trong ModelCatalog), ghi dưới dạng **alias của họ model** (`opus`, `sonnet`, `fable`…), không ghi ID cố định. Nhờ vậy Claude Code luôn dùng bản mới nhất của họ đó khi có model mới (vd. Opus 7.5), và nhận cả họ model mới mà không cần sửa code. Tài khoản không có mục đề xuất thì chọn theo thứ tự Opus > Sonnet > Haiku → phiên bản mới nhất → bản context lớn. Không có alias thì ghi ID. Không lấy được danh sách → alias `opus`.
  - `tools`: Read, Grep, Glob; tool điều phối luôn được tự thêm khi chạy (mục 3.2); `canDelegate: true`; `delegates: "*"`.
  - Đã có (kể cả đã được sửa) thì **không tạo lại, không ghi đè**. Bị xoá thì lần sau tạo lại. Sửa như agent bình thường.
  - Khi tạo, web hiện thông báo "Created crewtree-supervisor with <model>".
  - Mỗi session có thể chọn agent khác làm Supervisor (agent đó phải có `canDelegate`).
- **Root task:** mỗi tin nhắn người dùng gửi Supervisor tạo một root task (người giao là người dùng). Câu trả lời cuối của Supervisor hiện trong chat chính và tự đóng root task khi không còn task con đang chạy; Supervisor không cần gọi `complete_task`.
- Cây hình thành theo 2 cách:
  1. Người dùng dựng: trong dialog tạo session hoặc kéo agent thả lên một node trên canvas.
  2. Agent tự sinh khi chạy: `spawn_agent`, chỉ với agent có sẵn trong thư viện và nằm trong `delegates` của nó.

### 4.2 Tool điều phối (chỉ cấp cho node có `canDelegate`)

| Tool | Input | Hành vi |
|---|---|---|
| `list_agents` | – | Danh sách **con trực tiếp**: tên, mô tả, trạng thái |
| `spawn_agent` | `agentName, alias?` | Tạo con mới; kiểm tra `delegates`, `maxDepth`, `maxTotalAgents` |
| `delegate_task` | `agentId, title, instructions, scope?[], files?[]` | Giao task cho con trực tiếp, trả `taskId` ngay (không chờ). **Bị từ chối** nếu `scope` trùng với task khác đang chạy trong session |
| `wait_for_tasks` | `taskIds[], timeoutSec?` (mặc định 300, tối đa 600) | Chờ tới khi các task xong **hoặc** hết timeout. Trả về: kết quả tóm tắt của task đã xong, task còn chạy (`still_running`), câu hỏi từ con (`questions`), tin nhắn người dùng gửi cho chính node này, `user_interventions` ở các con. Agent tự gọi lại nếu cần chờ tiếp |
| `get_task_status` | `taskId` | Trạng thái, tool đang chạy, tiến độ gần nhất |
| `get_task_result` | `taskId` | Kết quả **đầy đủ** (không tóm tắt) của task đã xong |
| `answer_child` | `taskId, answer` | Trả lời câu hỏi `ask_parent` của con → task trở lại `running` |
| `message_agent` | `agentId, message` | Gửi tin bổ sung cho con đang chạy |
| `cancel_task` | `taskId, reason` | Huỷ task, **huỷ lan xuống** toàn bộ nhánh con |

Tool cấp cho **mọi** agent:

| Tool | Input | Hành vi |
|---|---|---|
| `report_progress` | `text` | Đẩy cập nhật tiến độ lên cha, không kết thúc task |
| `complete_task` | `summary, details?, files?[]` | Kết thúc task hiện tại. `summary` tối đa ~2k token (dài hơn bị cắt, kèm cảnh báo); `details` lưu DB, cha đọc qua `get_task_result` |
| `ask_parent` | `question` | Hỏi cha khi thiếu thông tin → task chuyển `needs_input`, agent dừng chờ câu trả lời |

**Quy tắc kết thúc task:** nếu agent kết thúc lượt mà không gọi `complete_task` hay `ask_parent`, server nhắc lại một lần ("Call complete_task or ask_parent"). Lần thứ hai vẫn không gọi thì lấy câu trả lời cuối làm `summary`, đánh dấu task `done` với `completed_by: auto`. Quy tắc này không áp dụng cho root task của Supervisor (xem 4.1).

### 4.3 Quy tắc
- Chỉ giao việc cho **con trực tiếp**; không vượt cấp, không sang nhánh khác. Cấu trúc luôn là cây nên không có vòng lặp.
- Kết quả đi ngược lên từng cấp dưới dạng **tóm tắt** để context tầng trên không phình.
- Node cha hiển thị trạng thái tổng hợp: "waiting for 1/2 children".
- Người dùng chat trực tiếp với node nào thì **cha trực tiếp** của node đó được báo qua `user_interventions`.
- Giới hạn theo session: `maxDepth` (mặc định 4), `maxTotalAgents` (10), `maxTurns`/agent (60), `maxTokens`/session (500k), và `maxConcurrentAgents` riêng (tuỳ chọn, chỉ được thấp hơn mức chung).
- **Cách tính `maxConcurrentAgents`:** chỉ đếm agent **đang sinh output** (`running`). Agent `waiting_children`, `waiting_input`, `needs_input`, `throttled`, `idle`, `suspended` **không giữ slot** → cha chờ con không thể gây deadlock. Agent vượt giới hạn chuyển `queued`. Mức chung đặt ở **Settings → Limits** (mặc định 3) và áp dụng cho mọi session/project trên máy (cùng một quota tài khoản).
- Mỗi agent chỉ gọi được tool điều phối của chính nó (MCP gắn `sessionAgentId`, mục 3.2) → server kiểm tra quyền theo cây.
- **Supervisor hỏi người dùng:** Supervisor gọi `ask_parent` → root task chuyển `needs_input`, câu hỏi hiện trong chat chính, session hiện nhãn "Needs your input"; người dùng trả lời ngay trong ô chat chính.
- **Tin nhắn khi agent đang bận:** mặc định **xếp hàng** (nhãn `queued` trong chat); được giao khi agent xong lượt, hoặc trả về ngay trong kết quả `wait_for_tasks` nếu agent đang chờ con. Nút **Interrupt & send** ngắt lượt hiện tại rồi gửi ngay.
- **Trạng thái session:** `active ⇄ paused`, kết thúc ở `completed` (Supervisor trả lời xong, không còn task), `stopped` (người dùng dừng) hoặc `error`. Pause: không giao task mới, agent đang chạy làm nốt lượt hiện tại. Session `completed` vẫn chat tiếp được (quay lại `active`).
- System prompt của node điều phối được thêm hướng dẫn: chia việc theo file/thư mục, khai báo `scope` khi giao task, không tự làm thay việc của con.

### 4.4 Luồng mẫu
```
User ── "Làm trang login + API auth" ──► Supervisor
Supervisor: list_agents → [researcher, analyst, lead-coder]
Supervisor: delegate_task(researcher) → t1, delegate_task(analyst) → t2   (song song)
Supervisor: wait_for_tasks([t1, t2])
Supervisor: delegate_task(lead-coder, scope: src/auth/**, src/pages/Login*) → t3
  lead-coder: spawn_agent(implementer) ×2
  lead-coder: delegate_task(impl-1, scope: src/auth/**) / delegate_task(impl-2, scope: src/pages/**)
     (người dùng chat với impl-1: "thêm refresh token" → lead-coder được báo)
  lead-coder: wait → review → trả tóm tắt
Supervisor: tổng hợp → trả lời người dùng
```

---

## 5. Làm chung thư mục: chống xung đột file

1. **Prompt + kiểm tra phía server:** node điều phối được hướng dẫn chia việc theo phạm vi file và khai báo `scope` trong `delegate_task`. Server từ chối `delegate_task` nếu `scope` trùng task đang chạy. Agent sửa file **ngoài** `scope` của task → yêu cầu được đưa lên Approval với nhãn `outside scope`.
2. **FileLockManager (chặn thật)** qua hook `PreToolUse` cho `Edit`/`Write`/`MultiEdit`:
   - Agent có task đang chạy sửa file X → giữ lease trên X tới khi task kết thúc.
   - Agent khác sửa X → bị từ chối kèm lý do; phát event `file.conflict` để UI cảnh báo trên cả hai node.
   - Lease nhả khi task xong/huỷ/agent dispose; có timeout để không kẹt.
   - `Bash` không chặn trước được → Bash phải được bật rõ cho từng agent; thay đổi do Bash gây ra được phát hiện sau (mục 3).
3. **Ghi nhận thay đổi:** "Files touched" trên node, tab Changes theo agent/task. Watcher theo dõi `cwd`: thay đổi không đến từ Edit/Write được gán cho agent đang chạy `Bash` tại thời điểm đó (nhãn `via Bash`); không xác định được thì gán `unknown`.
4. **Checkpoint git (tuỳ chọn, mặc định tắt):** nếu `cwd` là git repo, trước mỗi lượt của Supervisor tạo snapshot vào **ref riêng** `refs/crewtree/checkpoints/<session>/<n>` (dựng commit từ index tạm, không đổi branch, không chạm working tree hay lịch sử commit của người dùng). Rollback: khôi phục file từ checkpoint sau khi xác nhận. Không bật hoặc không phải git: hook lưu snapshot file trước mỗi lần Edit để phục vụ diff.

---

## 6. Agent và tài nguyên Claude Code

### 6.1 Nguồn dữ liệu
File là nguồn gốc. Crewtree đọc/ghi trực tiếp, không có bước sync.

| Loại | User scope | Project scope | Khác |
|---|---|---|---|
| Agents | `~/.claude/agents/*.md` | `<cwd>/.claude/agents/*.md` | **Crewtree:** `~/.crewtree/agents/*.md`; Plugin (chỉ đọc), Built-in (chỉ đọc) |
| Skills | `~/.claude/skills/<name>/SKILL.md` + file phụ | `<cwd>/.claude/skills/…` | Plugin (chỉ đọc) |
| Commands | `~/.claude/commands/*.md` | `<cwd>/.claude/commands/*.md` | Plugin (chỉ đọc) |
| Memory | `~/.claude/CLAUDE.md` + các file `@import` | `<cwd>/CLAUDE.md`, `<cwd>/.claude/CLAUDE.local.md` | Auto memory `~/.claude/projects/<proj>/memory/` |
| MCP servers | `~/.claude.json` | `<cwd>/.mcp.json` | Plugin (chỉ đọc) |
| Plugins | Thư mục plugin đã cài, marketplace | – | Cài/gỡ qua CLI `claude plugin …` |

- **ResourceScanner** quét khi khởi động và khi đổi project; **watcher** (chokidar) cập nhật trong khoảng 1 giây khi file đổi từ CLI/editor.
- **Scope Crewtree** (`~/.crewtree/agents/`): cùng định dạng `.md`, nhưng Claude Code CLI không đọc thư mục này → agent chỉ dùng trong Crewtree, không bị CLI gọi nhầm qua tool `Task`. Supervisor mặc định nằm ở đây. Có thao tác "Move to scope…" để chuyển agent giữa Crewtree / User / Project.
- Trùng tên: Project > User > Crewtree.
- Badge nguồn: `Crewtree`, `User`, `Project`, `Plugin: <name>`, `Built-in`. Nguồn plugin/built-in chỉ đọc, có nút "Duplicate as mine".
- Agent built-in (general-purpose, Explore, Plan) không có file và system prompt → chỉ hiển thị để tham khảo, **không dùng làm node** trong cây.
- Agent cũ chưa có `canDelegate` vẫn dùng được như node thực thi; bật toggle trong Editor hoặc ghi đè cho một session.

### 6.2 Frontmatter của agent
```yaml
---
name: lead-coder
description: Tech lead. Breaks work down, delegates to implementers, reviews results.
runtime: claude               # mặc định claude; Phase 9: opencode | codex | gemini-cli
model: opus
tools: Read, Grep, Glob, Edit
color: blue
icon: git-branch
canDelegate: true
delegates: [implementer]      # "*" (mọi agent) hoặc danh sách tên agent
maxTurns: 60
skills: [review]
mcpServers: [github]
---
<system prompt>
```
Spike Phase 0 xác nhận Claude Code bỏ qua các trường lạ (`icon`, `canDelegate`, `delegates`…). Nếu không, chuyển các trường riêng sang file sidecar `<name>.crewtree.json`.

Trường riêng khác:
- `role: supervisor`: đánh dấu agent dùng làm Supervisor (mục 4.1).
- `freshContextPerTask: true`: mỗi task một phiên mới (mục 3.2).
- `tools`: danh sách tool của Claude Code. Tool điều phối (`mcp__crewtree__*`) luôn được Crewtree tự thêm khi chạy, không cần khai báo.
- `skills`, `mcpServers`: map sang option của SDK khi chạy. Spike Phase 0 kiểm tra SDK có giới hạn skill/MCP theo từng agent được không; nếu không, chỉ áp dụng `mcpServers`, còn `skills` được nhắc trong system prompt như gợi ý.

### 6.3 An toàn khi ghi vào `~/.claude` và `~/.crewtree/agents`
- Mỗi lần ghi lưu một revision vào SQLite (`resource_revisions`), rollback được.
- Luôn xem diff trước khi lưu; xoá phải xác nhận.
- Ghi atomic (file tạm → rename).
- **`~/.claude.json` là trường hợp đặc biệt:** file chứa cấu hình MCP lẫn nhiều trạng thái khác mà Claude Code ghi liên tục. Thêm/sửa/xoá MCP user scope qua `claude mcp add/remove`. Chỉ khi không làm được mới ghi trực tiếp: đọc lại ngay trước khi ghi, chỉ sửa key `mcpServers`, ghi atomic.
- **Secret:** revision chỉ lưu phần thay đổi; giá trị trong `env`, `headers`, token… được che (`••••`) trước khi lưu DB và khi trả qua API. Rollback một MCP server giữ nguyên secret hiện tại.

### 6.4 Tạo bằng AI (`AiGeneratePanel`, dùng chung)
- Áp dụng cho: agent (Generate / Improve), skill (sinh `SKILL.md` + file phụ), command, memory (thêm quy tắc, dọn trùng), cấu hình MCP, scaffold plugin.
- Người dùng mô tả bằng `<Composer>` (đính kèm được file mẫu) → stream kết quả (SSE) → xem diff hoặc cây file → **Apply**.
- Mỗi loại có meta-prompt riêng dạy đúng format (vd. cách viết `description` để skill/agent được chọn đúng lúc).
- Agent: trả JSON `{name, description, systemPrompt, suggestedTools, suggestedModel, canDelegate, delegates}`.
- Ngôn ngữ đầu ra theo setting **Generated content language** (mục 11).
- Cách chạy: một lần gọi model, **không có tool**, model lấy từ Settings → Defaults → AI Generate model. Meta-prompt ở Phụ lục A.4.
- **Try it** (Agent Editor): chạy agent thật trong cwd đã chọn. Tắt "Allow file writes" → `permissionMode: plan`. Tool điều phối trả kết quả giả, không tạo agent con thật.

---

## 7. Model

- **ModelCatalogService:** gọi `supportedModels()` của Agent SDK để lấy toàn bộ model tài khoản dùng được (`value`, `displayName`, `description`). Cache TTL ~6 giờ, nút Refresh. API `GET /api/models` → `{ models, fetchedAt, source: "account" | "fallback" }`.
- Fallback khi không lấy được: alias `opus`, `sonnet`, `haiku`, `inherit` + ô Custom model ID.
- Settings → Models: xem danh sách, thêm custom model ID.
- Ba nơi đặt model (nơi sau ghi đè nơi trước):
  1. Settings → Defaults: model mặc định cho node điều phối, node thực thi, AI Generate, fallback.
  2. Agent Editor: ghi vào `model:` của file `.md`; có effort/thinking nếu tài khoản hỗ trợ.
  3. Ghi đè trong session (bấm badge model trên node), không sửa file; node hiện `↺`. Áp dụng từ lượt tiếp theo, giữ context.
- Đổi hàng loạt ở trang Agents.
- Model không còn khả dụng: cảnh báo ⚠ trên card/node; khi chạy tự fallback về model mặc định và ghi log vào Activity.

---

## 8. Composer (ô nhập dùng chung)

Dùng ở: chat Supervisor, chat riêng từng node, Try it của Agent Editor, `AiGeneratePanel` (tắt slash).

- Nền: **TipTap (ProseMirror)** + Mention extension; mention hiển thị dạng chip.
- Trigger:

| Gõ | Gợi ý | Chip |
|---|---|---|
| `@` | File/thư mục trong cwd (fuzzy, theo `.gitignore`), file gần đây/agent vừa sửa lên đầu, agent trong session | `src/auth.ts` / `@analyst` |
| `@file` + `#` hoặc `:` | Chọn dòng: gõ `#42`, `#10-24` hoặc mở popover xem trước để bôi chọn | `src/auth.ts#L10-24` |
| `/` | Skill, command (user/project/plugin) | `/review` |
| `@@` | Symbol (Phase 8) | `ƒ login()` |

- Đính kèm: nút, dán (Ctrl+V), kéo thả.
  - Ảnh (png/jpg/webp/gif ≤ ~5MB): gửi image content block.
  - PDF: document block.
  - File text/code: lưu `~/.crewtree/uploads/<session>/`, chèn đường dẫn (file nhỏ nhúng thẳng nội dung).
  - `delegate_task(files)` chuyển tiếp attachment xuống con.
- Khi gửi: chip được chuyển thành tham chiếu rõ ràng, ví dụ `src/auth.ts (lines 10-24)`, đoạn dòng ngắn nhúng kèm nội dung.
- Index file phía server: `fast-glob` + watcher, cache có giới hạn số entry. `GET /api/fs/search?q=` < 50ms.
- Phím: `Enter` gửi, `Shift+Enter` xuống dòng.

---

## 9. File Viewer và tab Files

- Mở từ: chip mention, đường dẫn trong tin nhắn (tự linkify), tool call trong Activity, "Files touched", tab Changes, cây thư mục tab Files.
- Hiển thị: panel chia đôi thay drawer, mở rộng được.
  - **View:** CodeMirror chỉ đọc, highlight, số dòng, Ctrl+F, Ctrl+G, ảnh preview, markdown có chế độ render.
  - **Diff:** side-by-side; so với HEAD/checkpoint (git) hoặc snapshot trước Edit; lọc theo agent/task.
  - Live update khi agent sửa file, highlight dòng mới đổi.
  - Bôi chọn dòng → "Mention in chat" / "Copy path#L".
  - Nút "Open in VS Code" (`vscode://file/<path>:<line>`).
- MVP chỉ đọc. Phase 8: sửa trực tiếp, lưu qua FileLockManager.
- Bảo mật: chỉ đọc trong `cwd`, `~/.claude`, `~/.crewtree/uploads`; chặn path traversal; file > 2MB hoặc binary chỉ hiện thông tin.
- API: `GET /api/fs/tree`, `GET /api/fs/file?path=`, `GET /api/fs/diff?path=&base=`.

---

## 10. Duyệt quyền (Approval)

- `canUseTool` → ApprovalService tạo request → event `agent.permission.request` → node chuyển `waiting_input` (vàng).
- Duyệt ở: **Approval Inbox** (badge ⚑ trên header, gom mọi session) hoặc trực tiếp trên node.
- Lựa chọn:
  - `Allow once`
  - `Always allow (this agent, this session)` theo **tool + mẫu**, cú pháp giống permission của Claude Code: gợi ý sẵn `Bash(npm test:*)`, `Edit(src/auth/**)`, sửa được trước khi lưu. Không có lựa chọn cho phép cả tool `Bash` một lần cho tất cả.
  - `Deny with reason…` (lý do được trả về cho agent)
- Xem trước: lệnh Bash, diff của Edit/Write.
- Áp dụng cho mọi tầng của cây; cha không tự duyệt thay.
- Khi người dùng không ở trước màn hình: browser notification (và âm thanh, tuỳ chọn). Không tự từ chối; các nhánh khác của cây vẫn chạy trong lúc chờ.

---

## 11. Ngôn ngữ

### 11.1 Giao diện (i18n)
- Hai ngôn ngữ: **English (mặc định)** và **Tiếng Việt**.
- Chọn ở header (`EN ▾`) và Settings → General. Đổi là áp dụng ngay, không reload.
- Lưu vào `app_settings.ui.language` qua `PATCH /api/settings`. Lỗi lưu → giữ ngôn ngữ trên UI, toast có Retry.
- Không nháy sai ngôn ngữ: server chèn `<html lang>` và `window.__BOOT__ = { language, theme }` vào `index.html` khi trả trang.
- `i18next` + `react-i18next`, namespace theo màn hình (`common`, `sessions`, `agents`, `workspace`, `config`, `settings`), `fallbackLng: "en"`.
- `pnpm i18n:check` (chạy trong CI) so khớp key giữa `en` và `vi`.
- Thuật ngữ giữ tiếng Anh ở cả hai ngôn ngữ: agent, session, skill, plugin, MCP, prompt, token, model, task (có file glossary).
- Định dạng ngày/số theo locale (`Intl`).
- Không dịch nội dung do người dùng/agent tạo, tên file, output lệnh.
- CLI, `install.sh` và `install.ps1` luôn bằng tiếng Anh.

### 11.2 Ngôn ngữ của AI
| Ngữ cảnh | Quy tắc |
|---|---|
| Chat với Supervisor / sub agent | Trả lời theo ngôn ngữ trong **tin nhắn gần nhất** của người dùng |
| Tin nhắn giữa các agent | Theo ngôn ngữ đang dùng; kết quả cuối trả người dùng vẫn theo ngôn ngữ của họ |
| Code, comment, commit, tài liệu trong repo | Theo quy ước sẵn có của project |
| Nội dung AI sinh ra để lưu file (agent, skill, command, memory, MCP, plugin) | Theo setting **Generated content language**: `follow` (theo giao diện) / `en` / `vi` |

Cách làm: lúc chạy, Crewtree thêm vào system prompt của mọi agent (không ghi vào file `.md`):
> "Reply to the user in the language of their most recent message. Write code, comments, and files following the project's existing conventions."

Nếu system prompt của agent có quy định ngôn ngữ riêng thì quy định đó được ưu tiên.

---

## 12. Tech stack

| Lớp | Lựa chọn |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Ngôn ngữ | TypeScript |
| Agent runtime | `@anthropic-ai/claude-agent-sdk` (dự phòng: Claude Code CLI stream-json) |
| Backend | Node 22, Fastify, `@fastify/websocket`, `@fastify/static`, `@fastify/multipart` |
| Validation | Zod (schema dùng chung server/web) |
| DB | SQLite + Drizzle ORM (`~/.crewtree/crewtree.db`) |
| File watch / search | chokidar, fast-glob, ripgrep (Phase 8 cho symbol) |
| Frontend | React 19, Vite, React Router |
| Sơ đồ | `@xyflow/react` (React Flow) + `elkjs` |
| UI | Tailwind CSS + shadcn/ui (Radix), font Inter / JetBrains Mono |
| State | Zustand (client), TanStack Query (server) |
| Editor | TipTap (Composer), CodeMirror 6 (prompt editor, File Viewer, diff) |
| Markdown | `react-markdown` + `shiki` |
| i18n | `i18next`, `react-i18next` |
| CLI | `commander` + `@clack/prompts` hoặc `listr2`, `open` (mở trình duyệt đa nền tảng), `semver` |
| Installer | POSIX `sh` (`install.sh`, macOS) + PowerShell (`install.ps1`, Windows) |
| CI / Release | GitHub Actions: test trên macOS và Windows; release build ma trận theo nền tảng |
| Test | Vitest, Playwright |

---

## 13. Cấu trúc repo

```
crewtree/
├─ scripts/
│  ├─ install.sh                  # POSIX sh, upload lên GitHub Release
│  ├─ install.ps1                 # PowerShell, Windows
│  └─ pack.ts                     # gom bundle theo nền tảng + tạo SHA256SUMS
├─ .github/workflows/
│  ├─ ci.yml                      # lint, test (macOS/Windows), i18n:check
│  └─ release.yml                 # tag v* → build ma trận → upload Release
├─ apps/
│  ├─ cli/                        # lệnh `crewtree`
│  │  └─ src/ (index, open, stop, status, logs, doctor, update, rollback, uninstall, autostart, daemon, updateCheck, ui/steps)
│  ├─ server/
│  │  └─ src/
│  │     ├─ index.ts, config.ts
│  │     ├─ paths.ts              # mọi đường dẫn (home, data dir, .claude dir) đi qua đây — đa nền tảng
│  │     ├─ db/                   # drizzle schema + migrations
│  │     ├─ resources/            # ResourceScanner, watcher, parsers, writers, revisions
│  │     │  ├─ agents/ skills/ commands/ memory/ mcp/ plugins/
│  │     ├─ sessions/             # SessionService
│  │     ├─ runtime/
│  │     │  ├─ drivers/ (SdkDriver, CliDriver, FakeDriver)
│  │     │  ├─ AgentRuntime.ts
│  │     │  ├─ orchestratorTools.ts
│  │     │  ├─ TaskManager.ts
│  │     │  ├─ FileLockManager.ts
│  │     │  ├─ ApprovalService.ts
│  │     │  └─ eventNormalizer.ts
│  │     ├─ models/               # ModelCatalogService
│  │     ├─ generate/             # meta-prompts + AI generate (SSE)
│  │     ├─ fs/                   # tree, file, diff, search index, snapshots
│  │     ├─ uploads/
│  │     ├─ settings/             # app_settings
│  │     ├─ events/               # EventBus, persist, WS fan-out
│  │     ├─ routes/  ws/
│  │     └─ static/               # phục vụ web build + chèn __BOOT__
│  └─ web/
│     └─ src/
│        ├─ app/ (router, layout, providers)
│        ├─ pages/ (Sessions, Workspace, Agents, AgentEditor, Skills, Commands, Memory, Mcp, Plugins, Settings)
│        ├─ features/
│        │  ├─ flow/              # canvas, AgentNode, edges, elk layout, outline
│        │  ├─ chat/              # MessageList, tool chips
│        │  ├─ composer/          # Composer (TipTap), mention, attachments
│        │  ├─ agent-detail/      # drawer: Activity, Chat, Tasks, Changes, Config
│        │  ├─ files/             # FileTree, FileViewer, DiffView
│        │  ├─ approvals/         # Inbox, inline approval
│        │  ├─ ai-generate/       # AiGeneratePanel
│        │  ├─ model-picker/
│        │  └─ resources/         # list/editor dùng chung cho skills/commands/memory…
│        ├─ i18n/ (index.ts, locales/en/*.json, locales/vi/*.json, glossary.md)
│        ├─ stores/  lib/ (api, ws)
├─ packages/
│  └─ shared/                     # zod schemas, types, event constants
└─ docs/ (PLAN.md, UI-WIREFRAMES.md)
```

Thư mục `~/.crewtree/` (Windows: `%USERPROFILE%\.crewtree`):
```
~/.crewtree/
├─ app/
│  ├─ v0.1.0/          # mỗi phiên bản một thư mục, giữ 2 bản gần nhất
│  ├─ v0.2.0/
│  └─ current → v0.2.0 # symlink (Windows: junction hoặc file version)
├─ agents/            # agent scope Crewtree (Supervisor mặc định…), Claude Code CLI không đọc
├─ crewtree.db
├─ backups/            # crewtree-<version>.db, tạo trước mỗi migration
├─ uploads/  snapshots/  logs/
├─ config.json         # port, …
├─ crewtree.pid
├─ shutdown.token      # token cho POST /api/shutdown
├─ session.secret      # khoá ký cookie phiên web (quyền file 600)
└─ update-check.json   # cache kiểm tra bản mới (tối đa 1 lần/ngày)
```

---

## 14. Data model (SQLite)

| Bảng | Cột chính |
|---|---|
| `app_settings` | key (PK), value (json), updated_at — `ui.language`, `ui.theme`, `ai.generatedContentLanguage`, `models.defaults`, `models.custom`, `limits.defaults` (gồm `maxConcurrentAgents` chung, `idleSuspendMinutes`, `eventsRetentionDays`), `update.check` |
| `resource_revisions` | id, kind (`agent/skill/command/memory/mcp`), scope (`crewtree/user/project`), path, content, created_at |
| `projects` | id, path, last_opened_at |
| `sessions` | id, project_id, title, cwd, supervisor_agent_id, status (`active/paused/completed/stopped/error`), settings json (limits, nhóm cấu hình Claude Code, checkpoint, idleSuspendMinutes), total_tokens, total_turns, created_at, updated_at |
| `session_agents` | id, session_id, agent_name, scope, snapshot (md), parent_id, depth, alias, spawned_by (`user/agent`), model_override, can_delegate_override, fresh_context_override, sdk_session_id, status, last_active_at |
| `tasks` | id, session_id, from_agent_id (null = người dùng → root task), to_agent_id, parent_task_id, title, instructions, scope json, status (`queued/running/needs_input/done/failed/cancelled/interrupted`), is_root, question, answer, result_summary, result_details, completed_by (`tool/auto`), started_at, ended_at |
| `messages` | id, session_agent_id, role (`user/assistant/parent`), content (json blocks), task_id, delivery (`queued/delivered/interrupted`), created_at |
| `events` | id (tăng dần), session_id, session_agent_id, type, payload json, ts — **không lưu từng text delta**, chỉ lưu bản gộp khi xong mỗi đoạn; session đã đóng giữ 30 ngày (chỉnh được), có nút "Clean up" |
| `attachments` | id, session_id, filename, mime, size, path |
| `approvals` | id, session_id, session_agent_id, tool, input json, status (`pending/allowed/denied`), rule (`once/pattern`), pattern (vd. `Bash(npm test:*)`), reason, created_at, decided_at |
| `file_touches` | id, session_id, session_agent_id, task_id, path, op, snapshot_path, ts |

**AgentEvent types:** `agent.status`, `agent.text.delta`, `agent.text.done`, `agent.tool.start`, `agent.tool.end`, `agent.permission.request`, `approval.created`, `approval.resolved`, `agent.spawned`, `agent.removed`, `task.created`, `task.updated`, `task.question`, `message.created`, `usage.updated`, `file.touched`, `file.conflict`, `session.status`, `resource.changed`.

---

## 15. API

### 15.1 REST
```
Settings     GET /api/settings · PATCH /api/settings
Models       GET /api/models · POST /api/models/refresh
Projects     GET /api/projects · POST /api/projects/open

Auth         GET    /auth?t=<token>                       (đổi token dùng một lần thành cookie phiên)

Resources    GET    /api/resources/:kind?scope=           (kind: agents|skills|commands|memory|mcp|plugins; scope: crewtree|user|project|plugin|builtin)
             GET    /api/resources/:kind/:id              (nội dung + revisions)
             POST   /api/resources/:kind
             PUT    /api/resources/:kind/:id
             DELETE /api/resources/:kind/:id
             POST   /api/resources/:kind/:id/duplicate
             POST   /api/resources/agents/:id/move        body: { scope: crewtree|user|project }
             POST   /api/resources/:kind/:id/rollback     body: { revisionId }
             POST   /api/agents/bulk-model                body: { names[], model }
             POST   /api/mcp/:id/test
             POST   /api/plugins/install | /uninstall | /toggle

Generate     POST /api/generate/:kind   (SSE)            body: { mode: generate|improve, input, current? }

Sessions     GET/POST /api/sessions · GET/PATCH/DELETE /api/sessions/:id
             POST   /api/sessions/:id/agents              (thêm agent, parentId)
             PATCH  /api/sessions/:id/agents/:said        (model override, canDelegate override)
             DELETE /api/sessions/:id/agents/:said
             POST   /api/sessions/:id/messages            (gửi Supervisor; body: { content, mode: queue|interrupt })
             POST   /api/sessions/:id/agents/:said/messages   (body như trên)
             POST   /api/sessions/:id/agents/:said/interrupt
             POST   /api/sessions/:id/tasks/:tid/answer   (trả lời câu hỏi của root task khi Supervisor hỏi người dùng; ô chat chính gọi API này)
             GET    /api/sessions/:id/tasks/:tid/result
             POST   /api/sessions/:id/tasks/:tid/cancel
             POST   /api/sessions/:id/stop | /pause | /resume
             GET    /api/sessions/:id/events?after=&agent=&limit=

Approvals    GET /api/approvals?status=pending · POST /api/approvals/:id  body: { decision, rule?, reason? }

Files        GET /api/fs/tree · GET /api/fs/file · GET /api/fs/diff · GET /api/fs/search
Uploads      POST /api/uploads (multipart)
Health       GET /api/health
Version      GET /api/version              → { current, latest, updateAvailable, releaseUrl }
Shutdown     POST /api/shutdown            (chỉ nhận từ localhost + token trong ~/.crewtree/shutdown.token)
```

### 15.2 WebSocket
- `ws://localhost:<port>/ws?sessionId=&lastEventId=`
- Server → client: `AgentEvent`. Client → server: `ping`, `subscribe`.
- Kết nối lại: server gửi bù mọi event `id > lastEventId`.
- Kênh global (không sessionId): `approval.*`, `resource.changed`, `session.status` cho header và sidebar.

### 15.3 Bảo mật truy cập (server local)
Server có API chạy agent, Bash và ghi file, nên phải chặn mọi truy cập không đến từ chính người dùng — kể cả từ trang web lạ đang mở trong trình duyệt (DNS rebinding, CSRF).
- Chỉ lắng nghe `127.0.0.1` (không `0.0.0.0`).
- Kiểm tra header `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`} → chặn DNS rebinding.
- Kiểm tra `Origin` với mọi request thay đổi dữ liệu, SSE và khi mở WebSocket → chặn CSRF và trang web lạ.
- **Token phiên:** lệnh `crewtree` mở trình duyệt với `/auth?t=<token dùng một lần, hết hạn 60s>` → server đổi thành cookie `HttpOnly; SameSite=Strict` (ký bằng `~/.crewtree/session.secret`). Mọi REST/WS/SSE đều cần cookie. Mở web trực tiếp mà không có cookie → trang hướng dẫn chạy `crewtree` để vào lại.
- HTTP MCP của CliDriver: token riêng mỗi agent, hết hiệu lực khi agent bị dispose.
- `POST /api/shutdown` dùng `shutdown.token` của CLI, không dùng cookie.
- Không bao giờ trả secret (env MCP, token) ra API ở dạng rõ.
- Chế độ dev (`pnpm dev`): server in link `/auth?t=…` ra terminal để vào web khi chưa có CLI.
- Test tự động: request từ origin khác, Host lạ, thiếu cookie đều bị từ chối.

---

## 16. CLI, cài đặt, cập nhật và đa nền tảng

### 16.1 Cài đặt (người dùng)
```bash
# macOS
curl -fsSL https://github.com/<owner>/crewtree/releases/latest/download/install.sh | sh

# Phiên bản cụ thể / thư mục khác
curl -fsSL …/install.sh | CREWTREE_VERSION=v0.2.0 sh
curl -fsSL …/install.sh | CREWTREE_INSTALL_DIR=~/apps/crewtree sh
```
```powershell
# Windows (PowerShell)
irm https://github.com/<owner>/crewtree/releases/latest/download/install.ps1 | iex

# Phiên bản cụ thể
$env:CREWTREE_VERSION="v0.2.0"; irm …/install.ps1 | iex
```

`releases/latest/download/` luôn trỏ tới bản release mới nhất (bỏ qua pre-release).

- `install.sh` dành cho macOS và Linux/WSL (x64/arm64, glibc hoặc musl).
- `install.ps1` làm đúng 4 bước như `install.sh` (kiểm tra môi trường, tải, kiểm tra SHA256, thiết lập), đặt app vào `%USERPROFILE%\.crewtree\app\<version>\`, tạo `crewtree.cmd`, thêm vào PATH của user (không cần admin) và kiểm tra Git Bash cho Claude Code. Biến môi trường dùng chung (`CREWTREE_VERSION`…).

Các bước của `install.sh` (output tiếng Anh, `[n/4]`, ✓/✕, thời gian):
1. **Checking environment:** phát hiện OS/arch (`uname`), Node ≥ 22, Claude Code có trong máy và đã login. Thiếu → in cách sửa và dừng. Nền tảng không hỗ trợ → báo rõ.
2. **Downloading:** tải `crewtree-<version>-<os>-<arch>.tar.gz` (thanh tiến trình của curl).
3. **Verifying & extracting:** kiểm tra SHA256 với `SHA256SUMS`; sai → xoá file và dừng. Giải nén vào `~/.crewtree/app/<version>/`, trỏ `current`.
4. **Setting up:** link `crewtree` vào `~/.local/bin`, tạo `~/.crewtree/`. PATH: vì stdin đang là script nên không hỏi được → **in ra dòng cần thêm** vào shell rc; chỉ tự sửa khi có `CREWTREE_MODIFY_PATH=1`.

Nguyên tắc:
- Viết bằng **POSIX `sh`**, không dùng cú pháp riêng của bash.
- Không cần sudo; không động vào `~/.claude`.
- Idempotent: chạy lại = cài/cập nhật lên bản được chọn.
- Log đầy đủ ở `~/.crewtree/logs/install-<timestamp>.log`; lỗi → in dòng cuối, đường dẫn log, cách sửa.
- Non-TTY: tắt màu. Biến môi trường: `CREWTREE_VERSION`, `CREWTREE_INSTALL_DIR`, `CREWTREE_MODIFY_PATH`, `NO_COLOR`.
- Vẫn cần Node 22 trên máy (Phase 8 spike file chạy độc lập để bỏ yêu cầu này).

### 16.2 Cài đặt cho dev
```bash
git clone <repo> && cd crewtree && pnpm install && pnpm dev
```

### 16.3 Lệnh
```
crewtree [path]                 khởi động server nếu chưa chạy (daemon), mở trình duyệt cho project = path | cwd
crewtree stop                   dừng server (gọi POST /api/shutdown → dispose mọi runtime)
crewtree status                 pid, port, uptime, số session đang chạy, version
crewtree logs [-f]
crewtree doctor                 môi trường, server, port, quyền ghi ~/.claude và ~/.crewtree, Git Bash (Windows)
crewtree update [version]       cập nhật lên bản mới nhất hoặc bản chỉ định
crewtree update --check         chỉ kiểm tra có bản mới không
crewtree update --pre           cho phép bản pre-release
crewtree rollback               quay về bản trước
crewtree autostart on|off       launchd (macOS) / Task Scheduler (Windows)
crewtree uninstall [--purge]    liệt kê thứ sẽ gỡ, hỏi xác nhận; mặc định giữ dữ liệu
```
- Một tiến trình, một cổng (mặc định 4317, bị chiếm thì lấy cổng khác, ghi vào `config.json`). Server phục vụ luôn web đã build.
- **Một server cho mọi project:** `crewtree <path>` khi server đang chạy chỉ mở thêm tab cho project đó. Các project chạy song song, dùng chung giới hạn số agent đồng thời.
- Phát hiện server đang chạy qua `GET /api/health` + pid file.

### 16.4 Cập nhật
```
$ crewtree update
  Current: v0.1.0   Latest: v0.2.0
  What's new: https://github.com/<owner>/crewtree/releases/tag/v0.2.0
  [1/5] Downloading v0.2.0             ######################## 100%
  [2/5] Verifying checksum             ✓ SHA256 OK
  [3/5] Extracting                     ✓ ~/.crewtree/app/v0.2.0
  [4/5] Migrating data                 ✓ Backup: ~/.crewtree/backups/crewtree-v0.1.0.db
                                       ✓ 2 migrations applied
  [5/5] Switching & restarting         ✓ current → v0.2.0 · server restarted
  ✔ Updated v0.1.0 → v0.2.0 in 11s
  Roll back anytime with: crewtree rollback
```

Các bước bên trong: GitHub API `/releases/latest` → so sánh semver → tải + kiểm tra SHA256 → giải nén vào **thư mục riêng** (không ghi đè bản đang chạy, nên Windows không bị lỗi file đang dùng) → sao lưu DB → migration → đổi `current` → restart → giữ 2 bản gần nhất.

| Tình huống | Xử lý |
|---|---|
| Đang có session chạy agent | Mặc định không cập nhật; báo số session đang chạy và cho chọn `--wait` (chờ xong), `--force` (task → `interrupted`, resume được sau) hoặc huỷ |
| Tải lỗi / sai checksum | Dừng, bản hiện tại không bị ảnh hưởng |
| Migration lỗi | Tự khôi phục DB từ bản sao lưu, giữ bản cũ |
| Bản mới chạy lỗi | `crewtree rollback`: trỏ `current` về bản trước + khôi phục DB sao lưu tương ứng |
| Hạ phiên bản | Dùng bản sao lưu DB của phiên bản đó; migration chỉ chạy một chiều |

**Thông báo bản mới:**
- CLI: kiểm tra tối đa 1 lần/ngày (cache `update-check.json`), in `↑ Crewtree v0.2.0 is available (you have v0.1.0). Run: crewtree update`.
- Web: banner nhỏ có thể tắt `v0.2.0 available · What's new · How to update` (dựa trên `GET /api/version`). Web chỉ thông báo, không tự cập nhật.
- Tắt: Settings → General → `Check for updates`, hoặc `CREWTREE_NO_UPDATE_CHECK=1`.

### 16.5 Release pipeline
Push tag `v*` → GitHub Actions `release.yml`:
1. Build ma trận: `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64` (chỉ khi spike xác nhận có prebuild `better-sqlite3` và runner Windows ARM; nếu không, MVP chỉ có `win32-x64`). Phase 8 thêm `linux-x64`, `linux-arm64`. Build riêng từng nền tảng vì `better-sqlite3` là module native.
2. Gom bundle: server, web tĩnh, cli, `node_modules` production → `tar.gz` (Windows: `zip`); tạo `SHA256SUMS`.
3. Upload cùng `install.sh` và `install.ps1` lên GitHub Release.

**Điều kiện:** repo (hoặc một repo phát hành riêng chỉ chứa release) phải **public** thì `curl` mới tải được không cần token.

### 16.6 Đa nền tảng

**Thứ tự ưu tiên:** macOS là nền tảng chính — mọi phase được phát triển và kiểm thử trên Mac trước. Windows chạy trực tiếp nằm trong MVP: code tuân thủ quy tắc đa nền tảng từ đầu, CI chạy test trên Windows từ Phase 0, phần đóng gói và cài đặt Windows hoàn thiện ở Phase 7. Linux/WSL để Phase 8.

| Vấn đề | macOS | Windows |
|---|---|---|
| Thư mục dữ liệu / Claude | `~/.crewtree`, `~/.claude` | `%USERPROFILE%\.crewtree`, `%USERPROFILE%\.claude` |
| PATH | In dòng cần thêm vào `.zshrc`/`.bashrc` | Sửa biến PATH của user (không cần admin) |
| Lệnh `crewtree` | symlink trong `~/.local/bin` | `crewtree.cmd` gọi `node …\cli.js` |
| `current` | symlink | junction hoặc file ghi version |
| Dừng server | `POST /api/shutdown` (thống nhất mọi OS; Windows không có SIGTERM) | như bên trái |
| Autostart | launchd | Task Scheduler |
| Mở trình duyệt | thư viện `open` | thư viện `open` |
| Ghi file `.md` | giữ nguyên kiểu xuống dòng sẵn có (LF/CRLF) | như bên trái |
| Ghi atomic | rename | rename + retry có backoff (file có thể bị editor/antivirus giữ) |
| Đường dẫn | chuẩn hoá qua `paths.ts`; API và mention luôn dùng `/` | thêm xử lý ổ đĩa, `\` |
| Hoa/thường tên file | mặc định không phân biệt (APFS), có thể phân biệt | không phân biệt → FileLock luôn so sánh path đã chuẩn hoá |
| Tool `Bash` của agent | bình thường | Claude Code cần Git Bash; `crewtree doctor` kiểm tra |

Nguyên tắc code: không gọi lệnh shell trong server/CLI (dùng API Node, `child_process` với `shell: false`); mọi đường dẫn qua `paths.ts`; CI chạy test trên macOS và Windows.

---

## 17. Cleanup và chống rò rỉ tài nguyên

- `AgentRuntime.dispose()`: abort query, đóng inputQueue, reject waiter, nhả file lock. Gọi khi xoá/stop session, gỡ agent, server shutdown (SIGINT/SIGTERM).
- `wait_for_tasks` luôn có timeout.
- EventBus: huỷ listener khi WS đóng; heartbeat ping/pong phát hiện socket chết.
- Watcher (chokidar) và search index đóng khi đổi project / shutdown; cache có giới hạn số entry.
- FileLock lease có timeout.
- ModelCatalog cache có TTL.
- Frontend: WS client `close()` khi rời Workspace; subscription dọn trong cleanup của `useEffect`; danh sách event dùng virtualized list, chỉ giữ N event gần nhất trong bộ nhớ, phần cũ tải theo trang.
- Uploads/snapshots dọn khi xoá session.
- Agent rảnh quá `idleSuspendMinutes` → tắt tiến trình (mục 3.2); token MCP của agent hết hiệu lực theo.
- Events của session đã đóng xoá sau thời gian giữ (mặc định 30 ngày).

---

## 18. Kiểm thử

- **Unit:** eventNormalizer, TaskManager (state machine), orchestratorTools (quyền theo cây, depth/total limit, huỷ lan xuống), FileLockManager, parser/writer frontmatter, ModelCatalog fallback, settings validation.
- **Integration:** `FakeDriver` phát kịch bản event cố định → test điều phối N tầng không tốn token; test approval flow; test resource watcher.
- **E2E (Playwright, FakeDriver):** tạo agent → tạo session có cây 3 tầng → gửi prompt → node đổi trạng thái → duyệt quyền → mở drawer → chat riêng → mở file từ chip → đổi ngôn ngữ, reload vẫn giữ.
- **i18n:** `pnpm i18n:check`.
- **Đa nền tảng:** CI chạy unit + e2e (FakeDriver) trên `macos-latest` và `windows-latest`. Kiểm thử thủ công với tài khoản thật làm trên Mac trước, Windows trước khi phát hành.
- **Installer / update:** chạy `install.sh` trên runner macOS sạch và `install.ps1` trên runner Windows sạch với release giả (checksum đúng/sai, nền tảng không hỗ trợ, thiếu Node); test `update` → `rollback` với migration giả.
- **Thủ công với tài khoản thật:** 3 kịch bản (feature + review; research + viết tài liệu; cây 3 tầng research/analyst/lead-coder→implementer).
- **Bảo mật:** request từ origin khác, Host lạ, thiếu cookie đều bị từ chối (mục 15.3).

### Tiêu chí hoàn thành MVP
- [x] Cài bằng `curl … | sh` trên macOS sạch và `irm … | iex` trên Windows sạch; `crewtree` mở được web trong vòng 5 giây trên cả hai. — v0.1.0 đã phát hành. Trên Mac này, `curl -fsSL …/releases/latest/download/install.sh | sh` vào HOME sạch cài xong trong 11 giây; server khởi động 1,4 giây trên Node 24 (bản build dùng Node 22, binary SQLite tự chuyển sang `node-v137`); `doctor` đạt, `update --check` thấy v0.1.0 là bản mới nhất. Checksum và build provenance (`gh attestation verify`) của gói đều khớp. Windows: `install.ps1` chạy trên runner sạch trong mọi lần chạy `release.yml`, kể cả lần phát hành; lệnh `irm … | iex` từ Release chưa chạy trên máy Windows thật
- [x] Agent sẵn có trong `~/.claude/agents` hiện đủ; tạo/sửa trên web ghi đúng file và Claude Code CLI đọc được. — agent viết tay và agent tạo/sửa qua API đều hiện trong thư viện và trong danh sách subagent của `claude -p`
- [x] Supervisor mặc định được tạo với model tốt nhất khi thư viện chưa có. — `CREWTREE_DIR` mới → `crewtree-supervisor` với `claude-opus-5-5`
- [x] Kịch bản cây 3 tầng (Supervisor → researcher, analyst, lead-coder → 2 implementer) chạy trọn trên tài khoản thật, có ít nhất một lần duyệt quyền, một lần `ask_parent`, một lần chat trực tiếp với node con. — Sonnet + Haiku, 4 lần duyệt, 2 câu hỏi, chat trực tiếp với researcher; code sinh ra pass 12/12 test
- [x] Chạy liên tục 1 giờ không crash; RAM của server không tăng liên tục; agent rảnh tự `suspended` và dựng lại được. — FakeDriver, 3 session × 3 agent, 60 phút (3 phút tải / 2 phút nghỉ): 6.197 tin nhắn, 0 lỗi, 0 crash; agent tự `suspended` mỗi chu kỳ nghỉ, 132/132 lần dựng lại thành công. RSS lúc rảnh 229MB → 206MB sau 1 giờ (152MB khi đo lại), không rò rỉ; đỉnh 671MB lúc tải do `GET /api/sessions/:id` trả toàn bộ ~4.100 tin nhắn (~6MB) mỗi lần — đã sửa: endpoint chi tiết không còn trả tin nhắn, chat được phân trang (xem Phase 7)
- [x] Không có trường hợp hai agent cùng sửa một file mà không bị phát hiện. — scope trùng bị chặn khi giao task; Edit vào file đang bị giữ bị chặn và hiện toast trên UI (chạy thật); sửa qua Bash vào file đang bị giữ được báo `file.conflict` sau khi xảy ra
- [x] Khởi động lại server giữa chừng → session tiếp tục được. — `kill -9` server giữa turn: task đánh dấu `interrupted`, agent `suspended`, gửi tiếp thì agent nhớ ngữ cảnh trước crash
- [x] `crewtree update` → `crewtree rollback` thành công với migration thử. — macOS: update chạy migration, rollback trả lại DB trước migration; bản lỗi migration tự khôi phục. Windows: trong smoke test `release.yml`
- [x] Trang web từ origin khác không gọi được API. — trang trên origin khác (trình duyệt thật) và curl: mọi request `/api`, `/ws` có Origin lạ, `Origin: null`, `Sec-Fetch-Site: cross-site` hay Host lạ đều 403
- [x] Giao diện EN/VI đầy đủ, `i18n:check` pass.

---

## 19. Lộ trình

> **Thứ tự:** làm phần lõi (runtime + điều phối) trước để kiểm chứng kiến trúc sớm, khi chưa có UI đầy đủ thì dùng một trang test tối giản (chỉ có ở chế độ dev). UI quản lý tài nguyên và Composer làm sau.

### Phase 0 — Nền móng và spike (3 ngày)
- [x] Monorepo pnpm + Turborepo, lint/format, `packages/shared`, CI test trên macOS và Windows
- [x] `paths.ts` đa nền tảng; trường `runtime` + interface `AgentDriver` có capabilities
- [x] Fastify khung + **bảo mật local** (127.0.0.1, Host/Origin, token phiên; `pnpm dev` in link `/auth`), Drizzle + migration, `app_settings`, `/api/health`, `/api/settings`, `/api/version`
- [x] Vite + React + Tailwind + shadcn, i18next với `en`/`vi` khung, chèn `__BOOT__` vào `index.html`
- [x] **Spike:**
  - Agent SDK chạy bằng credential `claude login` (không API key); streaming input + resume
  - MCP nội bộ gắn theo từng agent; tool call MCP chờ lâu (5–10 phút) có bị timeout không
  - `supportedModels()`; Claude Code chấp nhận frontmatter lạ; cú pháp `claude plugin …`, `claude mcp add/remove`
  - `settingSources` tách riêng CLAUDE.md / skills / hooks / permissions được không; giới hạn `skills`/`mcpServers` theo agent
  - Tín hiệu rate limit của tài khoản subscription; RAM mỗi tiến trình agent
  - Build `better-sqlite3` cho `win32-arm64` và runner Windows ARM
- Kết quả: `pnpm dev` chạy server + web; báo cáo spike, chốt SdkDriver hay CliDriver → [SPIKE-REPORT.md](./SPIKE-REPORT.md): chọn **SdkDriver**, CliDriver dự phòng

### Phase 1 — Runtime một agent (3 ngày)
- [x] AgentDriver (SdkDriver/CliDriver/FakeDriver), AgentRuntime, eventNormalizer, MCP gắn theo agent
- [x] EventBus, lưu events (gộp delta), WS + gửi bù khi reconnect
- [x] Rate limit → throttled + backoff; quy tắc ngôn ngữ chat; nạp cấu hình Claude Code theo 4 nhóm
- [x] Tắt agent rảnh (`suspended`) + dựng lại bằng resume; `freshContextPerTask`
- [x] Trang test dev-only để chat với 1 agent
- Kết quả: chat với 1 agent, tool call stream realtime, suspend/resume hoạt động

### Phase 2 — Điều phối N tầng (6 ngày)
- [x] TaskManager (state machine có `needs_input`), toàn bộ tool điều phối và tool của agent con (`complete_task`, `ask_parent`, `report_progress`)
- [x] Quyền theo cây, giới hạn depth/total, concurrency chỉ tính agent đang sinh output, huỷ lan xuống, tóm tắt đi lên, `user_interventions`
- [x] Root task cho tin nhắn gửi Supervisor; hàng đợi tin nhắn + Interrupt & send; trạng thái session (active/paused/completed/stopped)
- [x] Kiểm tra `scope` phía server (từ chối scope trùng, sửa ngoài scope → Approval); tự thêm `mcp__crewtree__*` vào allowedTools
- [x] Supervisor mặc định trong scope Crewtree (template Phụ lục A.1, chọn model tốt nhất, thông báo khi tạo); đoạn prompt chèn thêm (Phụ lục A.2, A.3)
- [x] FileLockManager, file_touches, ghi nhận thay đổi qua Bash, snapshot, checkpoint git (ref riêng)
- [x] ApprovalService (rule theo tool + mẫu, browser notification)
- Kết quả: kịch bản cây 3 tầng chạy trọn với FakeDriver (`test/orchestration.e2e.test.ts`) và tài khoản thật qua trang test (Supervisor Sonnet → researcher, analyst có `ask_parent`, lead-coder → implementer tự sinh; có duyệt quyền, "Always allow", chat trực tiếp với node con, checkpoint git)

### Phase 3 — Tài nguyên và Agents (3 ngày)
- [x] ResourceScanner + watcher cho mọi loại, badge nguồn (gồm scope Crewtree), "Move to scope…", built-in chỉ tham khảo, project switcher
- [x] CRUD agent, revision, duplicate, import/export, đổi model hàng loạt
- [x] Trang Agents, Agent Editor (form, CodeMirror, tab File .md, history)
- [x] ModelCatalogService + model picker
- Kết quả: agent sẵn có trong `~/.claude/agents` hiện đủ; tạo/sửa ghi đúng file

### Phase 4 — Composer và AI Generate (3 ngày)
- [x] `<Composer>`: TipTap, chip, `@file`, `#dòng`, `@agent`, `/`, đính kèm, dán ảnh, trạng thái `queued`, nút Interrupt & send
- [x] fs search index, `/api/uploads`
- [x] `<AiGeneratePanel>` + `/api/generate/agent` (generate/improve, diff, apply; meta-prompt Phụ lục A.4)
- [x] Try it trong Agent Editor
- Kết quả: sinh prompt agent từ mô tả ngắn

### Phase 5 — Workspace UI (5 ngày)
- [x] Trang Sessions, dialog New session (dựng cây ban đầu, chọn Supervisor, nâng cao, 4 nhóm cấu hình)
- [x] Canvas React Flow, AgentNode (đủ các trạng thái gồm `queued`, `waiting_children`, `needs_input`, `suspended`), edges, elk layout, thu gọn nhánh, outline, minimap, context menu, kéo thả agent lên node
- [x] Chat Supervisor (tool chips focus node, câu hỏi "Needs your input"), Drawer 5 tab
- [x] Approval Inbox + inline (rule theo mẫu), cảnh báo xung đột file
- [x] Tab Files, File Viewer (View/Diff/chọn dòng/mention/VS Code), tab Changes (gồm `via Bash`)
- [x] Session settings: giới hạn, nhóm cấu hình, số tiến trình + RAM, checkpoint
- Kết quả: trải nghiệm đầy đủ như wireframe

### Phase 6 — Claude Config Manager và Settings (4 ngày)
- [x] Skills, Commands (layout chung, cây file phụ), Memory (cây import, auto memory), MCP (form + test, qua `claude mcp`, che secret), Plugins (bật/tắt, cài/gỡ, marketplace)
- [x] AI Generate cho skill/command/memory/MCP/plugin
- [x] Settings: General (ngôn ngữ, generated content language, theme), Models, Defaults, Limits (`maxConcurrentAgents` chung, thời gian tắt agent rảnh, thời gian giữ events + Clean up), Account
- [x] Bộ chọn ngôn ngữ trên header, `i18n:check` trong CI, hoàn thiện bản dịch `vi`
- [x] Hiển thị token/turn, empty states, theme tối, Ctrl+K command palette

### Phase 7 — CLI, phát hành và cập nhật (7–8 ngày, gồm Windows)
- [x] `apps/cli`: open/stop/status/logs/doctor, daemon, pid, health, `POST /api/shutdown` + token
- [x] Server phục vụ web build, chọn port
- [x] `scripts/pack.ts` + `release.yml` (ma trận macOS + Windows + Linux, `SHA256SUMS`, upload Release) — 5 nền tảng; v0.1.0 phát hành qua job publish với build provenance attestation
- [x] `install.sh` POSIX (phát hiện nền tảng, checksum, thư mục theo version, `current`, PATH, biến môi trường)
- [x] `crewtree update` / `--check` / `--pre` / `rollback`: sao lưu DB, migration, xử lý session đang chạy, giữ 2 bản
- [x] Thông báo bản mới: CLI (cache 1 lần/ngày) và banner web; setting `update.check`
- [x] **Windows:** `install.ps1` (PowerShell, checksum, PATH của user, `crewtree.cmd`, junction `current`), Task Scheduler cho autostart, `doctor` kiểm tra Git Bash, test cài/cập nhật/rollback trên Windows sạch — tất cả chạy trên Windows runner, gồm update → rollback có migration thử, bật/tắt Task Scheduler và chạy trên Node 24 (`scripts/smoke-update.mjs`)
- [x] `autostart` (launchd, Task Scheduler, systemd/XDG), `uninstall` — launchd thật trên runner macOS (arm64, Intel), Task Scheduler trên Windows, systemd/XDG trên Linux; launcher tự tìm Node mỗi lần đăng nhập
- [x] License và supply chain (mục 21): `LICENSE`, `NOTICE`, `TRADEMARKS.md`, `CONTRIBUTING.md` (DCO), `SECURITY.md`, `licenses/`; CI kiểm tra license dependency, gitleaks, DCO; `release.yml` thêm build provenance attestation

- [x] Chạy được trên mọi máy, không gắn với máy build (làm sau vòng MVP):
  - `better-sqlite3` là module native build theo phiên bản Node (ABI), nên bản build trên Node 22 không chạy trên Node 24 và ngược lại (đã tái hiện). Bundle giờ mang sẵn binary cho Node 22/24/25/26 (`server/native/`). Mỗi lần CLI khởi động server, nó chọn binary hợp với Node đang chạy; khi không có sẵn thì tải binary dựng sẵn, và chỉ biên dịch khi cả hai cách đều không được (`apps/cli/src/native.ts`). Đã thử: cài một bản rồi chạy lần lượt Node 22 → 24, và trường hợp không có binary sẵn (tải mất 2 giây). Chưa dùng `better-sqlite3` 13 (N-API) vì bản 13.0.3 còn lỗi segfault trên Node 22 (issue #1514).
  - Autostart không còn ghi cứng đường dẫn Node. `~/.crewtree/autostart.sh` / `autostart.cmd` tìm Node 22+ mỗi lần đăng nhập: Node đã ghi lại lúc bật, rồi `PATH`, nvm, fnm, volta, mise, asdf, Homebrew, `/usr/local`. Sau đó launcher chạy `crewtree serve`. launchd dùng `KeepAlive` nên tự chạy lại khi server crash. Đã thử: đường dẫn Node ghi lại bị xoá và PATH tối giản, launcher vẫn tìm được Node 24 trong nvm.
- [x] Mỗi thư mục dữ liệu chỉ có một server (lỗi do bài smoke trên runner macOS arm64 tìm ra, với launchd thật):
  - Lỗi: bật autostart thì launchd chạy server ngay (`RunAtLoad`). Nếu lúc đó có lệnh `crewtree` khác cũng khởi động server, server thứ hai ghi đè pid file và shutdown token, không lấy được cổng rồi thoát. CLI mất dấu server đang chạy và không dừng được nó.
  - Sửa: pid file giờ là khoá độc quyền (`apps/server/src/instanceLock.ts`), được lấy trước khi mở database và chạy migration. Server đến sau thấy khoá thì thoát với exit 0, nên launchd không chạy lại nó; CLI nhận server đang chạy làm server của mình.
  - Pid file do server bị crash để lại (`kill -9`) được lấy lại ngay. Pid cũ bị một tiến trình khác dùng lại thì server chờ 15 giây xác nhận, rồi lấy lại.
  - Đã thử: 3 server khởi động cùng lúc thì chỉ 1 chạy; `kill -9` rồi khởi động lại; pid bị tái sử dụng.
- [x] Phân trang lịch sử chat (sau soak 1 giờ):
  - `GET /api/sessions/:id` không còn trả `messages`; tin nhắn lưu trữ có endpoint riêng `GET /api/sessions/:id/messages?agent=&before=&limit=`.
  - Chat của Supervisor và chat của node trong drawer tải trang mới nhất trước: 300 sự kiện chat, chỉ gồm các loại cần cho chat (`/events?before=&types=`), và mỗi trang bắt đầu từ một tin nhắn của người dùng để tool call và kết quả nằm cùng trang. Cuộn lên đầu, hoặc bấm "Tải tin nhắn cũ hơn", để tải trang trước; vị trí đọc được giữ nguyên.
  - Trước đây web tải 2.000 sự kiện *cũ nhất*, nên session dài không hiện được tin mới.
  - Thêm index `events(session_agent_id, id)` (migration 0004).
  - Đã thử trên session soak khoảng 4.100 tin: một trang chat 262KB, tải trong 0,01s (trước là 6MB); tải thêm 200 → 400 → 600 tin mà vị trí đọc không đổi; tin mới vẫn tự cuộn xuống cuối.
  - Còn lại: danh sách task trong endpoint chi tiết chưa phân trang (505 task ≈ 1,2MB trong soak, vì mỗi tin gửi thẳng cho node tạo một root task).
  - Linux và WSL (kéo từ Phase 8 lên):
    - `install.sh` nhận Linux x64/arm64, cả glibc lẫn musl;
    - autostart dùng systemd user service, hoặc XDG autostart khi không có systemd; WSL không có systemd thì báo cách bật;
    - `release.yml` build thêm `linux-x64` và `linux-arm64` (ubuntu-24.04-arm), CI chạy test thêm trên `ubuntu-latest`;
    - `release.yml` thêm bước chạy bản cài trên Node 24 (bản được đóng gói bằng Node 22).
    - Phần Linux chưa chạy thử ở máy này (Docker không chạy); CI sẽ kiểm khi push.

### Phase 8 — Mở rộng
- ~~Linux và WSL~~ (đã làm ở Phase 7, xem trên).
- Spike file chạy độc lập (Node SEA / `bun build --compile`) để bỏ yêu cầu Node 22.
- (Tương lai, khi có nhu cầu) Publish npm `crewtree` bằng Trusted Publishing + `--provenance`.
- Mention theo symbol, sửa file trực tiếp trong viewer, template session, UI cho settings.json/hooks, export transcript, worktree tuỳ chọn cho từng agent.

### Phase 9 — Nhiều runtime
- [ ] Spike tài liệu mới nhất của OpenCode, Codex CLI, Gemini CLI
- [ ] `OpenCodeDriver` (ưu tiên đầu): driver, eventNormalizer, ModelCatalog, resource adapter `.opencode/agent`, mapping permission
- [ ] `CodexDriver`, `GeminiCliDriver`
- [ ] UI: chọn runtime trong Agent Editor, badge runtime trên node, ẩn/hiện tính năng theo capabilities
- [ ] FileLock chế độ "phát hiện sau" cho runtime không có pre-tool hook

**Tổng MVP (Phase 0–7): khoảng 8 tuần cho 1 người** (khoảng 35 ngày làm việc + dự phòng).

---

## 20. Rủi ro và việc cần xác minh

| Rủi ro | Hướng xử lý |
|---|---|
| Agent SDK không chạy bằng credential `claude login` | Spike Phase 0; dự phòng CliDriver |
| Điều khoản dùng tài khoản subscription qua công cụ tự viết | Chỉ dùng cá nhân, không phân phối; tự kiểm tra lại điều khoản |
| Rate limit khi nhiều agent chạy song song | `maxConcurrentAgents`, trạng thái throttled, backoff, model nhẹ cho node thực thi |
| Claude Code từ chối frontmatter lạ | File sidecar `.crewtree.json` |
| `supportedModels()` không khả dụng | Fallback alias + custom ID |
| Xung đột file khi làm chung thư mục | Prompt chia scope + FileLockManager + cảnh báo UI; Phase 8 có worktree tuỳ chọn |
| Agent điều phối tự làm thay việc của con | Tool hạn chế cho node điều phối + hướng dẫn trong system prompt |
| Event quá nhiều làm UI giật | Gộp text delta ~50ms, virtualized list, giới hạn bộ nhớ |
| Server khởi động lại giữa chừng | `resume` bằng `sdk_session_id`; task → `interrupted`, cho phép chạy lại |
| Ghi hỏng file trong `~/.claude` | Revision + diff + ghi atomic + rollback |
| Repo private → `curl` không tải được release | Để repo public hoặc dùng repo phát hành riêng (public) chỉ chứa release |
| Module native (`better-sqlite3`) lệch nền tảng | Build ma trận theo nền tảng trong CI; installer kiểm tra OS/arch |
| Cập nhật làm hỏng dữ liệu | Thư mục theo version, sao lưu DB trước migration, `rollback` |
| Khác biệt Windows (path, CRLF, file bị khoá, Git Bash) | `paths.ts`, giữ kiểu xuống dòng, retry khi rename, `doctor` kiểm tra; CI test Windows |
| Runtime khác thiếu hook/permission | Capabilities: tắt tính năng tương ứng, FileLock chuyển sang phát hiện sau |
| Người khác chiếm tên `crewtree` trên npm/GitHub trước khi bạn công khai | Tạo GitHub repo/org `crewtree` sớm; có thể publish một bản placeholder lên npm khi sắp công khai |
| Bản fork đăng lại dưới cùng tên | `TRADEMARKS.md` + điều khoản về tên trong Apache-2.0 + README ghi rõ kênh cài chính thức + release có attestation |
| SDK của Anthropic không cho phân phối lại | Kiểm tra license trước Phase 7; nếu không được thì bộ cài tải SDK riêng thay vì đóng gói sẵn |
| Tool call MCP chờ lâu (`wait_for_tasks`) bị timeout phía Claude Code | Timeout mặc định 300s, agent tự gọi lại; spike Phase 0 đo giới hạn thực tế |
| Nhiều tiến trình agent ngốn RAM | Tắt agent rảnh, giới hạn `maxTotalAgents`, hiển thị RAM trong Session settings |
| Trang web lạ gọi API localhost (DNS rebinding, CSRF) | Mục 15.3: chỉ nghe 127.0.0.1, kiểm tra Host/Origin, cookie phiên |
| Hooks của người dùng gây tác dụng phụ trong agent con | Nhóm Hooks bật/tắt riêng theo session (mục 3.6) |
| Agent riêng của Crewtree bị Claude Code CLI gọi nhầm qua tool `Task` | Lưu ở scope Crewtree `~/.crewtree/agents/` (CLI không đọc) |
| Agent con kết thúc lượt bằng câu hỏi bị hiểu nhầm là xong | `ask_parent` / `complete_task` + nhắc lại khi agent quên gọi |

---

## 21. License, thương hiệu và supply chain

### 21.1 Quyết định
- **License:** Apache-2.0. Mở như MIT nhưng bản fork phải giữ file `NOTICE` (giữ tên tác giả), phải ghi rõ đã sửa gì, không được dùng tên/thương hiệu, và có điều khoản cấp quyền bằng sáng chế.
- **Bản quyền:** đứng tên cá nhân (`Copyright 2026 <Tên bạn>`). Làm trên máy và tài khoản GitHub cá nhân.
- **Không** dùng license hạn chế (AGPL, FSL): dự án cá nhân khó thực thi, tool chạy local nên điều khoản mạng của AGPL ít ý nghĩa, và license hạn chế làm giảm người dùng và người đóng góp.
- Tham khảo: `akitaonrails/ai-memory` (MIT, cá nhân, cargo-deny, checksum, npm provenance, gitleaks) và `topoteretes/cognee` (Apache-2.0, NOTICE, DCO, provenance PyPI, Sigstore).
- Nếu sau này muốn có bản trả phí: Apache-2.0 cho phép làm tính năng đóng mã hoặc dịch vụ trên phần lõi mở; không cần CLA.

### 21.2 File trong repo
```
LICENSE            # Apache-2.0, Copyright 2026 <Tên bạn>
NOTICE             # Crewtree — Copyright 2026 <Tên bạn>; danh sách phần mềm bên thứ ba được đóng gói
TRADEMARKS.md      # code được fork tự do, nhưng bản fork phải đổi tên và logo
CONTRIBUTING.md    # DCO: mọi commit cần dòng Signed-off-by (git commit -s)
SECURITY.md        # cách báo lỗ hổng; cách kiểm tra release bằng `gh attestation verify`
licenses/          # license của phần mềm bên thứ ba được phân phối lại
```
- SPDX header ở đầu mỗi file nguồn: `// SPDX-License-Identifier: Apache-2.0`.
- README ghi rõ **kênh cài đặt chính thức** (GitHub Releases của repo chính thức).

### 21.3 CI và release
| Việc | Công cụ |
|---|---|
| Chặn dependency có license không tương thích | `license-checker` hoặc `pnpm licenses list` với danh sách cho phép (MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, 0BSD, CC0-1.0…) |
| Quét lộ secret | gitleaks (toàn bộ lịch sử) |
| Kiểm tra DCO trên PR | GitHub App DCO hoặc workflow kiểm tra `Signed-off-by` |
| Chứng minh bản phát hành chính thức | `actions/attest-build-provenance` cho mọi file release; người dùng kiểm tra bằng `gh attestation verify <file> --owner <owner>` |
| Toàn vẹn file khi cài | `SHA256SUMS`; `install.sh`/`install.ps1` từ chối cài nếu thiếu hoặc sai checksum |
| npm (tương lai) | Trusted Publishing (OIDC) + `npm publish --provenance` |

### 21.4 Việc cần làm trước khi công khai repo
- [ ] Tạo GitHub repo/org `crewtree` để giữ tên
- [ ] Tìm tên "Crewtree" trên cơ sở dữ liệu nhãn hiệu (USPTO, WIPO Global Brand Database) và Google
- [ ] Kiểm tra tên miền (`crewtree.dev` / `.app` / `.sh`) nếu muốn có trang riêng
- [ ] Kiểm tra license của `@anthropic-ai/claude-agent-sdk` có cho đóng gói kèm không
- [ ] Thêm đủ các file ở mục 21.2 và các bước CI ở mục 21.3

---

## Phụ lục A — Prompt mẫu (bản nháp)

> Bản nháp để định hướng, sẽ tinh chỉnh khi chạy kịch bản thật ở Phase 2. Prompt viết bằng tiếng Anh; quy tắc ngôn ngữ (A.3) quyết định ngôn ngữ trả lời người dùng.

### A.1 Template `~/.crewtree/agents/crewtree-supervisor.md`
```markdown
---
name: crewtree-supervisor
description: Default Crewtree supervisor. Understands the user's goal, splits it into tasks, delegates to child agents, and reports back.
role: supervisor
model: <best model available at creation time>
tools: Read, Grep, Glob
canDelegate: true
delegates: "*"
color: violet
icon: crown
---
You are the Supervisor of a team of AI agents working in the same project directory.

Your job:
1. Understand the user's goal. If it is ambiguous in a way that changes the work, ask the user (ask_parent) before delegating.
2. Call list_agents to see your team. Pick agents by their descriptions. Spawn more only from your allowed list when truly needed.
3. Break the goal into tasks with clear outcomes. For every task that edits files, set `scope` to the files/folders it may touch.
   Never give two running tasks overlapping scopes.
4. Run independent tasks in parallel; run dependent tasks in order.
5. Use wait_for_tasks to collect results. Answer child questions with answer_child. Read full results with get_task_result only when the summary is not enough.
6. Do not do the children's work yourself. You may read files to plan and to verify.
7. When done, give the user a concise report: what was done, by whom, files changed, open issues, suggested next steps.
```

### A.2 Đoạn chèn thêm cho mọi node điều phối (lúc chạy, không ghi vào file)
```
You can delegate. Rules:
- Delegate only to your direct children (list_agents). Spawn only agents from your allowed list.
- Every file-editing task must declare `scope`; running tasks must not have overlapping scopes.
- Keep instructions self-contained: goal, constraints, relevant files, expected output.
- Prefer parallel work for independent tasks. Do not do your children's work yourself.
- When your own task is finished, call complete_task with a summary of your children's results.
```

### A.3 Đoạn chèn thêm cho mọi agent (lúc chạy, không ghi vào file)
```
You are part of a Crewtree session. Your parent: <parent name>. Your current task: <title>.
Task protocol:
- When the task is finished, call complete_task(summary, details?, files?). Keep the summary short and factual.
- If you are blocked by missing information, call ask_parent(question) instead of guessing.
- Use report_progress for meaningful milestones on long tasks.
- Stay within the task scope: <scope>. If you must touch other files, ask_parent first.
Language: reply to the user in the language of their most recent message.
Write code, comments, and files following the project's existing conventions.
```

Với Supervisor, cha là người dùng: phần "Task protocol" được thay bằng "Your final message is shown to the user and closes the request automatically; use ask_parent to ask the user a question."

### A.4 Meta-prompt AI Generate — agent (dàn ý)
- Vai trò: chuyên gia viết định nghĩa agent cho Claude Code.
- Input: mô tả của người dùng, file mẫu đính kèm (nếu có), bản hiện tại (chế độ Improve), danh sách tool và agent sẵn có, ngôn ngữ đầu ra.
- Yêu cầu đầu ra (JSON): `name` (kebab-case, duy nhất), `description` (1–2 câu, nói rõ **khi nào nên giao việc cho agent này**), `systemPrompt` (vai trò, quy trình, ràng buộc, định dạng kết quả), `suggestedTools` (tối thiểu cần thiết), `suggestedModel`, `canDelegate`, `delegates`.
- Ràng buộc: không bịa tool không có; không cấp `Bash`/`Write` nếu mô tả không cần; chế độ Improve giữ ý định gốc và chỉ sửa phần cần sửa.
- Các loại khác (skill, command, memory, MCP, plugin) dùng cùng khung, thay phần định dạng đầu ra.
