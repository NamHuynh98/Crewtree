# Báo cáo spike Phase 0

> Ngày chạy: 31/10/2026 · macOS (Apple Silicon) · Claude Code 2.1.314 · `@anthropic-ai/claude-agent-sdk` 0.3.312 · Node 24
> Tài khoản: đăng nhập bằng `claude login` (gói Claude Team), **không** có `ANTHROPIC_API_KEY` hay token trong biến môi trường.

## Kết luận

**Chọn `SdkDriver` làm driver mặc định.** SDK chạy được bằng credential của `claude login`, có streaming input, resume, MCP chạy chung tiến trình và callback duyệt quyền. `CliDriver` giữ làm dự phòng: runtime tự chuyển sang khi SDK lỗi trước khi sinh output.

## Kết quả từng mục (PLAN.md 19 — Phase 0)

| # | Spike | Kết quả | Hệ quả |
|---|---|---|---|
| 1 | Agent SDK chạy bằng credential `claude login` | ✅ Chạy thật nhiều lượt với Opus/Haiku; `accountInfo()` trả `subscriptionType: Claude Team` | Không cần API key |
| 2 | Streaming input + resume | ✅ Gửi nhiều tin trong một phiên; resume theo `sdk_session_id` sau khi **khởi động lại server** và sau khi agent bị **suspend** (tiến trình đã tắt) — agent nhớ đúng nội dung trước | Dùng cho tắt agent rảnh và khôi phục sau restart |
| 3 | MCP nội bộ gắn theo từng agent | ✅ Agent gọi `mcp__crewtree__report_progress` của chính nó, được tự duyệt qua `allowedTools: ['mcp__crewtree__*']` | Kiến trúc tool điều phối của Phase 2 khả thi |
| 4 | Tool MCP chờ lâu có bị timeout không | ✅ Tool trong tiến trình chờ **7 phút** vẫn trả kết quả (`is_error=false`). Mặc định không giới hạn (theo `sdk.d.ts`), chỉnh được bằng trường `timeout` của server | Đặt `timeout: 660_000` cho server `crewtree` (vừa trên mức tối đa 600s của `wait_for_tasks`) để handler bị treo không giữ agent mãi |
| 5 | `supportedModels()` | ✅ Trả 13 model, gồm alias (`default`, `opus`, `sonnet`, `haiku`, `fable`) và ID cụ thể; mỗi dòng có `resolvedModel` (vd. `opus` → `claude-opus-5-5`), `supportsEffort` | ModelCatalogService (Phase 3) dùng trực tiếp; chọn "model tốt nhất" cho Supervisor (Phase 2) dựa trên `resolvedModel` |
| 6 | Claude Code chấp nhận frontmatter lạ | ✅ Agent có `runtime`, `canDelegate`, `delegates`, `icon`, `color`, `role`, `freshContextPerTask` vẫn được `supportedAgents()` liệt kê bình thường | **Không cần** file sidecar `.crewtree.json` |
| 7 | Cú pháp `claude plugin …`, `claude mcp …` | ✅ `claude plugin install\|uninstall\|enable\|disable\|list\|update\|validate\|marketplace (add\|list\|remove\|update)`; `claude mcp add [--transport http\|sse] [-e KEY=v] [-H header] [--scope] <name> <cmd\|url>`, `add-json`, `remove`, `list`, `get` | Dùng cho Plugins / MCP (Phase 6) |
| 8 | `settingSources` tách riêng 4 nhóm cấu hình | ❌ Chỉ có `user` / `project` / `local`, không tách CLAUDE.md / skills / hooks / permissions | Đã làm phương án thay thế trong `runtime/claudeConfig.ts`: CLAUDE.md tắt bằng `claudeMdExcludes`, hooks bằng `disableAllHooks`, skills bằng `skills: []` + tắt từng plugin. **Giới hạn:** rule permission chỉ tắt được khi CLAUDE.md và Skills cũng tắt (khi đó bỏ hẳn file settings) — các trường hợp khác giữ rule và ghi cảnh báo. Không bao giờ dùng `bypassPermissions` |
| 9 | Giới hạn `skills` / `mcpServers` theo agent | ✅ (theo tài liệu, chưa chạy thật) `skills: string[]` giới hạn skill của phiên; `mcpServers` + `strictMcpConfig: true` chỉ dùng các server được truyền vào, bỏ qua `.mcp.json` / settings / plugin | Phase 3: đọc cấu hình các server có tên trong `mcpServers` của agent rồi truyền vào kèm `strictMcpConfig` |
| 10 | Tín hiệu rate limit của tài khoản subscription | ⚠️ Lấy từ type của SDK, **chưa gặp thực tế**: `rate_limit_event` với `rate_limit_info.status` (`allowed` / `allowed_warning` / `rejected`) + `resetsAt`, `rateLimitType`; và `system/api_retry` có `error_status: 429`, `retry_delay_ms` (SDK tự retry) | Đã cài trong `AgentRuntime`: chỉ `rejected` mới chuyển `throttled`; retry tin nhắn với backoff (30s → tối đa 15 phút) hoặc tới `resetsAt` |
| 11 | RAM mỗi tiến trình agent | ✅ Lúc rảnh: tiến trình `claude` ~**222 MB** + tiến trình phụ `node` ~44 MB; server Crewtree ~80 MB | 10 agent ≈ 2,6 GB → tắt agent rảnh (`idleSuspendMinutes`, mặc định 5) là cần thiết; đã kiểm chứng tiến trình thật sự tắt khi `suspended` |
| 12 | `better-sqlite3` cho `win32-arm64` và runner Windows ARM | ✅ Bản 11.10.0 có prebuild `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64` cho **Node 22** (ABI 127). GitHub Actions có runner `windows-11-arm` | Ma trận release có thể gồm `win32-arm64`. ⚠️ Không có prebuild cho Node 24 (ABI 137): trên Node 24 phải build từ source (cần toolchain) → installer nên yêu cầu Node 22, hoặc nâng `better-sqlite3` trước Phase 7 |

## Phát hiện thêm khi chạy thật

- **Grep/Glob trong bản native:** agent không khai báo `tools` (thừa hưởng tất cả) không có tool `Glob` và tự dùng `Bash ls` thay thế. Theo `sdk.d.ts`, bản native chỉ có Grep/Glob khi được liệt kê trong `tools` hoặc `allowedTools`. Agent khai báo `tools: Read, Grep, Glob` (như Supervisor mặc định) thì dùng được bình thường. → Agent Editor (Phase 3) nên gợi ý liệt kê rõ `tools`.
- **`allowedTools` của SDK là danh sách tool được duyệt tự động**, không phải danh sách tool được dùng (danh sách tool được dùng là option `tools`). PLAN.md 3.2 ghi "allowedTools = tools của agent + `mcp__crewtree__*`"; nếu làm đúng như vậy thì Edit/Bash bỏ qua Approval. Code hiện tại: `tools` = frontmatter `tools`, `allowedTools` = `['mcp__crewtree__*']`.
- **Usage của lượt bị interrupt bằng 0** trong `result`, dù đã tốn token → `total_tokens` hơi thấp hơn thực tế. Cần lưu ý khi áp `maxTokens` ở Phase 2.
- **Message `assistant` là từng khối nội dung**, không phải hết lượt; lượt chỉ kết thúc ở message `result` (đây là nguyên nhân lỗi trạng thái ở bản Phase 1 đầu tiên).

## Cách chạy lại

Các script spike là script dùng một lần, không nằm trong repo:
- Tool MCP chờ lâu: `createSdkMcpServer` với một tool `await sleep(seconds)`, gọi bằng `query({ model: 'haiku', tools: [], settingSources: [] })`.
- Model / agent / tài khoản / RAM: `query()` với prompt không bao giờ gửi, gọi `supportedModels()`, `supportedAgents()`, `accountInfo()` (không tốn token) và đo cây tiến trình con bằng `ps`.
