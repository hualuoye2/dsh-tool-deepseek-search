> **独立发布版**：本仓库从个人 DSH 工作区 `D:\deepseek` 抽离，只包含版本控制白名单里的源码与文档；
> 模型、音频、凭据、构建产物与机器数据未包含。文中 `D:\deepseek\...` 路径按本仓库根目录理解。
>
# dsh-tool-deepseek-search

把 DeepSeek 官方检索端点与「全家桶应用 API」暴露成 DSH agent 的七个工具：

| 工具 | 端点 | 用途 | 计费 |
| --- | --- | --- | --- |
| `deepseek_search` | `POST /v1/tools/search` | 结构化网页搜索 | 5 元/千次（失败/空结果免费） |
| `deepseek_fetch` | `POST /v1/tools/fetch` | 单页正文（Markdown） | 5 元/千次 |
| `deepseek_upload_file` | `POST /files` | 上传 PDF/Office/图片（解析）或文本/表格/电子书（`user_data`）→ `file_id` | 解析类按页；`user_data` 免费 |
| `deepseek_chat` | `POST /chat/completions` | `deepseek-flash` + 服务端 `deepseek_web_search` / `deepseek_read_url` + 文档引用，一次拿回回答、引用与工具用量 | token 费 + 搜索/抓取按次 |
| `deepseek_ocr` | `POST /v1/tools/ocr` | 文档/图片逐页 OCR，返回每页文本（可选落盘） | 1.5 元/千页 |
| `deepseek_transcribe` | `POST /v1/tools/asr` | 整段音频转文字（16-bit PCM WAV / Ogg Opus，≤8 MiB、≤120 s） | 0.39 元/小时（限时 5 折） |
| `deepseek_speak` | `POST /v1/tools/tts` | 文本合成语音并落盘（`stella` 女声 / `tide` 男声，wav/pcm） | 1.5 元/万字符（限时 5 折） |

端点前缀均为 `https://api.deepseek.com`。

## 为什么另加 tool，而不是换 `web_search` 的 provider

DSH 内置的 `web_search` 走 `deepseek-official`（Anthropic Messages + 服务端 `web_search`），
**每搜一次消耗一个完整模型轮次**。`deepseek_search` / `deepseek_fetch` 直连官方专用检索端点，
**一次 HTTP** 返回结构化 JSON。

两者并存：

- 日常搜索继续用 `web_search`；
- 需要 `authority` / `date` / `rerank_score`、`site:` / `lang:` / `after:` 过滤，或要低延迟时，
  显式调 `deepseek_search`；
- `web_fetch` 被 SSRF/fake-ip 挡掉时，用 `deepseek_fetch` 取正文；
- 需要「像 App 一样」由模型自己搜索、打开网页、按图引用作答时用 `deepseek_chat`（它的
  `server_tool_calls` 与 `annotations` 就是网页端的搜索卡片与引用角标）。

## `deepseek_chat` 的开关

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `search` | `true` | 声明 `deepseek_web_search`；`think: true` 时升级为深度思考搜索（多步 `open_page` / `find_in_page`） |
| `read_links` | `true` | 声明 `deepseek_read_url`，只读**最后一条用户消息**里的链接 |
| `think` | `false` | 开思考（`thinking: {type: enabled}`） |
| `files` / `file_ids` | — | 本地路径（先上传）或已有 `file_id`，作为 `{type:"file"}` 内容块引用 |
| `safety` | `none` | `high` 开内容安全校验；命中返回 `finish_reason=content_filter` |
| `title` | `false` | 让服务端顺带生成会话标题 |
| `max_tokens` | — | 限制**每步推理**的输出长度，不是整轮总量 |
| `stream` | `false` | 用 SSE 流式接收并在本地重新拼装 |
| `refusal_text` | 内置中文短句 | 命中 `finish_reason=content_filter` 时替换回答的文案 |

被官方明确忽略的参数（`temperature`、`top_p`、`seed` 等）没有暴露，避免“传了以为生效”。

## 拒答与流式

官方口径（[模型内容安全](https://api-docs.deepseek.com/zh-cn/guides/safety.md#handling-refusals)）：
开了 `safety_check` 后，**输出结束时连接不会立刻关闭**，服务端还要对完整输出做一次审核，之后仍可能
以拒答收尾；而**已经流式下发的文本无法撤回**，客户端必须删掉已展示的回答、换成自己的拒答文案。

本插件按这个规则实现：

| 场景 | 行为 |
| --- | --- |
| 非流式命中拒答 | `finish_reason=content_filter`，`content` 为空 → 返回 `refused: true` + `answer = refusal_text` |
| 流式命中拒答 | 已流出的正文**丢弃**（记在 `discarded_chars`），`answer = refusal_text` |
| 拒答说明 | 图片被拦时服务端给 `message.refusal` / `delta.refusal` → 返回 `refusal_detail` |
| 审核用量 | `usage.safety_tokens`（官方：审核 token 计入输出 token，单独列在 `completion_tokens_details.safety_tokens`） |
| 渲染 | 首行明确写「已丢弃已流出的 N 字，改为展示拒答文案」 |

拒绝原因服务端不会给（除图片拦截那种说明），所以插件也不编原因。

## 语音与 OCR

- `deepseek_ocr`：`text_recognition` 只取文字（不含图的 Word/PPT 直接抽文本）；`rich_layout_recognition`
  保留 `<|ref|>…<|/ref|><|box|>[[x1,y1,x2,y2]]<|/box|>` 标记，坐标按页宽高归一化到 0–1000。
  长文档用 `save_to` 把全文落盘，避免撑爆上下文。限制：100 MiB / 1000 页 / 总时长 180 s。
- `deepseek_transcribe`：一次发完整音频，返回 `text` 与 `duration_ms`；语种自动识别，只认左声道。
- `deepseek_speak`：`text` 最多 10,000 计费字符（汉字算 2），`output` 省略时写到
  `<cwd>\_quarantine\ds-tts\tts-<时间戳>.<format>`；`format: pcm` 是 24 kHz/16-bit/单声道裸流，
  要自己封 WAV 头。不支持语速调节与断点续传。

## 文件上传的两条路

| `purpose` | 适用 | 计费 / 限制 |
| --- | --- | --- |
| `text_recognition` | PDF / Word / PPT / 图片，只要文字 | 按页计费，解析超时 120s，单文件 ≤100 MiB、≤1000 页 |
| `rich_layout_recognition` | 需要看图（图表、幻灯片） | 同上；裁出的图计入输入 token 与图片上限 |
| `user_data` | txt/md/csv/json/代码、xlsx/xls/epub/mobi | **免费**，原文件 ≤32 MiB；表格与电子书服务端转 Markdown |

`purpose` 必须排在 multipart 的 `file` 字段**之前**，服务端对顺序敏感（本插件用 `FormData`
按顺序 append）。`auto` 按扩展名推断：解析类 → `text_recognition`，文本/表格/电子书 → `user_data`。

每个对话请求最多引用 20 个文档，合计 ≤8 MiB 文字；同一个 `file_id` 引用多次按多次计算。
文档只能通过 `file_id` 引用，不支持直接传内容或 URL。

## 凭据

逐次解析，改 key 不用重启。顺序：

1. `ctx.credentials`（DSH 凭据服务，引用名 `DEEPSEEK_API_KEY`）
2. 进程环境变量 `DEEPSEEK_API_KEY`
3. `~/.dsh/.credentials.yaml` 的 `refs` 段（兜底）

## 仓库位置与安装

源在 `D:\deepseek\dsh-tool-deepseek-search\`。

安装到桌面 profile 的三步（本机已做）：

1. 复制到 `~/.dsh/plugin-src/dsh-tool-deepseek-search`
2. 在 `~/.dsh/profiles/desktop/node_modules/` 建 junction 指向它
3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: tool-deepseek-search
      name: dsh-tool-deepseek-search
```

改动前的 patch 备份：`cordis.patch.yml.bak-before-deepseek-search`。

⚠️ 改完 `index.mjs` 必须**重启 DSH**（宿主侧插件模块不会热重载）。

## 验证

```powershell
node --check index.mjs
node test\selftest.mjs
```

`selftest.mjs` 用 DSH 自己的 `assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验七个
schema，并真实跑一遍：搜索 2 条 + 抓 1 页 + 上传一个 `user_data` 样本（免费）+ 两次对话
（一次带文档引用、一次带内嵌联网搜索）+ OCR 一张中英混排图 + TTS 合成一段语音 + 用 ASR 把这段
语音转回文字（闭环）+ SSE 解析与拒答的夹具测试 + 一次真实流式调用。2026-11-14 实测
**14/14 PASS**，总花费约 0.05 元。

拒答**只用夹具验证**（构造 `finish_reason=content_filter` 的流式帧）：真去触发风控既有风险也不稳定，
不拿它当测试项。

最近一次实测读数：

```
PASS deepseek_search 返回结果 — count=2 ms=603
PASS deepseek_fetch 取回正文 — chars=5756 ms=185
PASS deepseek_upload_file 拿到 file_id — purpose=user_data bytes=83 ms=237
PASS deepseek_chat 读到上传的文档（含暗号） — answer=ORION-7391 ms=994
PASS deepseek_chat 内嵌联网搜索 — citations=1 tool_search=2 ms=3640
PASS deepseek_ocr 识别出图片里的文字 — pages=1 chars=37 ms=2439（读出「全家桶接口自测 / ORION-7391 2026 / OCR SAMPLE 42」）
PASS deepseek_speak 写出可用的 WAV — bytes=241964 riff=RIFF billable=35 ms=1858
PASS deepseek_transcribe 转写回原文关键词 — duration=5040ms chars=21 ms=1759（「全家桶接口自测暗号：ORION 7391.」）
PASS SSE 解析：分片在 JSON 中间切断也不丢事件 — events=1
PASS SSE 解析：补全剩余分片并识别 [DONE] — events=2
PASS 拒答：丢弃已流出文本、换文案、保留审核用量 — discarded=11/11 safety_tokens=30
PASS 流式收尾：引用与工具调用从最后一帧解析出来 — citations=1 calls=1 tool_search=1
PASS deepseek_chat 真实流式调用可用 — chunks=111 chars=38 reasoning=219 finish=stop ms=976
PASS safety_check=high 正常回答不误拒 — finish=stop chars=85 safety_tokens=0 ms=1742
```

## 已知限制

- `deepseek_fetch` 返回的 Markdown 带转义反斜杠（`\#`、`\-`、`\:`），是 API 原样输出。
- `need_content: true` 时正文会随每条结果返回，输出很大，默认关闭。
- Fetch 的 4xx 不要重试：403 = 安全策略拒绝，404 = 无可提取正文。
- `deepseek_chat` 是**一次性**调用，不维护多轮状态；多轮要自己把上一轮的
  `server_tool_calls` / `annotations` 原样回传（本插件不保存会话）。
- 上传的原始文件与解析结果**不支持下载**，也没有删除接口；`file_id` 可跨会话复用直到过期。
- ⚠️ **`deepseek-flash` 在 Chat Completions 里默认先输出 `reasoning_content`**（实测：不传
  `thinking` 也会思考）。`max_tokens` 太小会整轮只拿到思考、正文为空且 `finish_reason=length`
  （实测 `max_tokens=64` → `chunks=66 / chars=0`）。流式结果里 `reasoning_chars` 就是思考字数；
  渲染会在正文为空时明确提示「只有思考内容」。要正文就把 `max_tokens` 调到 512 以上。
- 拒答的**真实触发**没有做成自动测试（有风险且不稳定）；插件对拒答的处理由夹具测试保证：
  丢弃已流出文本、替换文案、保留 `safety_tokens` 与 `refusal_detail`。
- 官方没有给「关闭思考」的 Chat Completions 参数，所以本插件也无法强制关掉；想省 token 只能
  调小 `max_tokens`，但要注意上一条的截断行为。
