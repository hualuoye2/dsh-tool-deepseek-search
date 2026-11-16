// dsh-tool-deepseek-search —— 把 DeepSeek 官方检索端点和「全家桶」对话能力暴露成 agent 工具。
//
// 为什么不换 web_search 的 provider，而是另加 tool：
//   DSH 内置的 web_search 走 deepseek-official（Anthropic Messages + 服务端 web_search
//   工具），每搜一次消耗一个完整模型轮次。前两个 tool 直连官方专用检索端点：
//     POST https://api.deepseek.com/v1/tools/search   （按次计费 5 元/1000 次）
//     POST https://api.deepseek.com/v1/tools/fetch    （同价）
//   一次 HTTP 即返回结构化 JSON。两者并存：web_search 保持原样不动，需要结构化字段、
//   站点/日期过滤或低延迟时显式调 deepseek_search / deepseek_fetch。
//
// 2026-11-13 官方开放「全家桶应用 API」后新增两个 tool：
//   deepseek_upload_file —— POST /files，上传 PDF/Office/图片（解析计费）或纯文本/表格
//                           （purpose=user_data，不计费），返回 file_id。
//   deepseek_chat        —— POST /chat/completions + deepseek-flash，声明服务端工具
//                           deepseek_web_search / deepseek_read_url，并在用户消息里用
//                           {type:'file', file_id} 引用文档；一次请求拿回回答 + 引用 + 工具用量。
//   文档：https://api-docs.deepseek.com/zh-cn/guides/build_a_chatbot
//
// 环境约束（AGENTS.md 三点五节，都是踩过的坑）：
//   - 不 import 任何 @deepseek-ai/*（profile 的 node_modules 树里没有运行时包）。
//   - schema 必须落在 DSH 支持的子集内；required 只能是父对象的字符串数组。
//   - 不用顶层 await。
//   - 改完必须重启 DSH 才生效。
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

export const name = 'dsh-tool-deepseek-search'

/** 只依赖 tools 服务；credentials 服务可选（运行时按需解析）。 */
export const inject = ['tools']

const API_BASE = 'https://api.deepseek.com'
const SEARCH_PATH = '/v1/tools/search'
const FETCH_PATH = '/v1/tools/fetch'
const UPLOAD_PATH = '/files'
const CHAT_PATH = '/chat/completions'
const OCR_PATH = '/v1/tools/ocr'
const ASR_PATH = '/v1/tools/asr'
const TTS_PATH = '/v1/tools/tts'
const CRED_REF = 'DEEPSEEK_API_KEY'
const MODEL = 'deepseek-flash'
const DEFAULT_COUNT = 5
const SEARCH_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 300_000
const CHAT_TIMEOUT_MS = 240_000
const OCR_TIMEOUT_MS = 300_000
const ASR_TIMEOUT_MS = 180_000
const TTS_TIMEOUT_MS = 180_000
// 命中风控时的替换文案（官方：已经流式下发的文本无法撤回，必须删掉已展示的回答换成自己的拒答文案）
const DEFAULT_REFUSAL_TEXT = '抱歉，这个问题我无法回答。'

// 文档解析计费的文件类型（解析时按页计费）；其余走 user_data（不计费）。
const PARSED_EXT = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
])
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1',
  '.sql', '.log', '.ini', '.toml', '.sh', '.bat', '.cmd',
  '.xlsx', '.xls', '.epub', '.mobi',
])
const PARSE_MAX_BYTES = 100 * 1024 * 1024
const USER_DATA_MAX_BYTES = 32 * 1024 * 1024

/** 把 count 夹到 1..50。 */
function clampCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_COUNT
  return Math.min(50, Math.max(1, Math.trunc(n)))
}

/** 安全取整数，缺省 0。 */
function num(value) {
  return Number.isFinite(value) ? value : 0
}

/**
 * 解析 DeepSeek API Key。逐次解析（改 key 无需重启）：
 *   1) ctx.credentials 凭据服务（DSH 的权威来源，凭据文件里的 refs 也在这一层）
 *   2) 进程环境变量
 *   3) ~/.dsh/.credentials.yaml 的 refs 段（最后兜底；凭据服务不可用时）
 * @param {object} ctx Cordis 上下文。
 * @returns {Promise<{key:string, source:string}|null>}
 */
async function resolveKey(ctx) {
  try {
    const cred = ctx.credentials
    if (cred && typeof cred.resolve === 'function') {
      const resolved = await cred.resolve(CRED_REF)
      if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return { key: resolved.value, source: `credentials:${resolved.source ?? 'unknown'}` }
      }
    }
  } catch {
    /* 凭据服务未加载或被拒，继续降级 */
  }

  const fromEnv = process.env[CRED_REF]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { key: fromEnv.trim(), source: 'env' }
  }

  try {
    const file = join(homedir(), '.dsh', '.credentials.yaml')
    const text = readFileSync(file, 'utf8')
    const m = text.match(new RegExp(`^\\s*${CRED_REF}\\s*:\\s*(sk-[A-Za-z0-9_-]+)\\s*$`, 'm'))
    if (m) return { key: m[1], source: 'file:refs' }
  } catch {
    /* 文件不存在或不可读 */
  }

  return null
}

const NO_KEY_MESSAGE =
  'DEEPSEEK_API_KEY is not configured. Set it in DSH credentials (reference name DEEPSEEK_API_KEY), ' +
  'in the process environment, or under refs in ~/.dsh/.credentials.yaml.'

/** POST 一个 JSON 请求，返回 { ok, status, body, ms }；网络失败时 ok=false、status=0。 */
async function postJson(path, body, timeoutMs, apiKey) {
  const t0 = Date.now()
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    return { ok: res.ok, status: res.status, body: parsed, raw: text, ms: Date.now() - t0 }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: error instanceof Error ? error.message : String(error),
      ms: Date.now() - t0,
    }
  }
}

/** POST 一个 multipart/form-data（文件上传），返回 { ok, status, body, raw, ms }。 */
async function postForm(path, form, timeoutMs, apiKey) {
  const t0 = Date.now()
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    return { ok: res.ok, status: res.status, body: parsed, raw: text, ms: Date.now() - t0 }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: error instanceof Error ? error.message : String(error),
      ms: Date.now() - t0,
    }
  }
}

/** POST 一段 JSON，拿回二进制（TTS 音频）。返回 { ok, status, bytes, type, raw, ms }。 */
async function postBinary(path, body, timeoutMs, apiKey) {
  const t0 = Date.now()
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || type.includes('application/json')) {
      // 出错时服务端回 JSON（例如 Content Exists Risk）
      const text = await res.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      return { ok: false, status: res.status, bytes: null, type, raw: text.slice(0, 800), body: parsed, ms: Date.now() - t0 }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, status: res.status, bytes: buf, type, raw: '', body: null, ms: Date.now() - t0 }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      bytes: null,
      type: '',
      raw: error instanceof Error ? error.message : String(error),
      body: null,
      ms: Date.now() - t0,
    }
  }
}

/** 把一条 Search 结果归一化成固定形状（空值统一成空串，数字缺省成 -1）。 */
function normalizeResult(item) {
  return {
    title: typeof item?.title === 'string' ? item.title : '',
    url: typeof item?.url === 'string' ? item.url : '',
    snippet: typeof item?.snippet === 'string' ? item.snippet : '',
    summary: typeof item?.summary === 'string' ? item.summary : '',
    content: typeof item?.content === 'string' ? item.content : '',
    site_name: typeof item?.site_name === 'string' ? item.site_name : '',
    date: typeof item?.date === 'string' ? item.date : '',
    authority: Number.isFinite(item?.authority) ? item.authority : -1,
    rerank_score: Number.isFinite(item?.rerank_score) ? item.rerank_score : -1,
  }
}

/** Search 结果的可读渲染（模型真正读到的文本）。 */
function renderSearch(args, value) {
  if (value && value.error) {
    return [{ type: 'text', text: `deepseek_search 失败：${value.error}` }]
  }
  const results = Array.isArray(value?.results) ? value.results : []
  if (results.length === 0) {
    return [{ type: 'text', text: `deepseek_search「${args?.query ?? ''}」没有结果。` }]
  }
  const lines = [`deepseek_search「${value.query}」返回 ${results.length} 条，用时 ${value.ms}ms：`]
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    lines.push(`   ${r.date || '日期未知'} | authority=${r.authority} | rerank=${r.rerank_score}${r.site_name ? ` | ${r.site_name}` : ''}`)
    const summary = r.summary || r.snippet
    if (summary) lines.push(`   ${summary.slice(0, 400)}${summary.length > 400 ? '…' : ''}`)
    if (r.content) lines.push(`   [正文 ${r.content.length} 字，已随结果返回]`)
  })
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Fetch 结果的可读渲染。 */
function renderFetch(args, value) {
  if (value && value.error) {
    return [{ type: 'text', text: `deepseek_fetch 失败：${value.error}` }]
  }
  const content = typeof value?.content === 'string' ? value.content : ''
  const head = content.slice(0, 1_500)
  const tail = content.length > head.length ? `\n…（正文共 ${content.length} 字，以上为前 1500 字）` : ''
  return [{ type: 'text', text: `deepseek_fetch ${value.url}\n标题：${value.title || '(无)'}\n\n${head}${tail}` }]
}

/** 上传结果的可读渲染。 */
function renderUpload(args, value) {
  if (value && value.error) {
    return [{ type: 'text', text: `deepseek_upload_file 失败：${value.error}` }]
  }
  return [
    {
      type: 'text',
      text:
        `已上传 ${value.filename}（${value.bytes} B，purpose=${value.purpose}，用时 ${value.ms}ms）\n` +
        `file_id: ${value.file_id}\n` +
        `把它传给 deepseek_chat 的 file_ids 即可让模型基于该文档回答。`,
    },
  ]
}

/** 对话结果的可读渲染：正文 + 引用 + 工具用量。 */
function renderChat(args, value) {
  if (value && value.error) {
    return [{ type: 'text', text: `deepseek_chat 失败：${value.error}` }]
  }
  const lines = []
  if (value.refused) {
    const discarded = Number.isFinite(value.discarded_chars) ? value.discarded_chars : 0
    lines.push(
      `【内容审核拒答：finish_reason=content_filter，已丢弃${discarded > 0 ? `已流出的 ${discarded} 字` : '空回答'}，改为展示拒答文案】`,
    )
    if (value.refusal_detail) lines.push(`服务端说明：${value.refusal_detail}`)
  }
  lines.push(value.answer || '(空回答)')
  if (value.answer === '' && value.reasoning_chars > 0) {
    lines.push(
      `（本轮只有思考内容、没有正文：${value.reasoning_chars} 字思考在 finish_reason=${value.finish_reason} 时被截断，` +
        `max_tokens 调大即可拿到正文）`,
    )
  }
  if (Array.isArray(value.citations) && value.citations.length > 0) {
    lines.push('', `引用（${value.citations.length} 条）：`)
    value.citations.slice(0, 20).forEach((c, i) => {
      lines.push(`  [${i + 1}] ${c.title || c.url} — ${c.url}`)
    })
  }
  if (Array.isArray(value.calls) && value.calls.length > 0) {
    lines.push('', `服务端工具调用（${value.calls.length} 次）：`)
    value.calls.slice(0, 20).forEach((c) => {
      const what = c.kind === 'read_link' || c.kind === 'open_page'
        ? `打开 ${c.url ?? ''}`
        : Array.isArray(c.queries) && c.queries.length > 0
          ? `搜索 ${c.queries.join(' / ')}`
          : c.kind ?? c.type ?? ''
      const src = Array.isArray(c.sources) && c.sources.length > 0 ? `（${c.sources.length} 条结果）` : ''
      lines.push(`  - ${c.type} [${c.status}] ${what}${src}`)
    })
  }
  const u = value.usage ?? {}
  lines.push(
    '',
    `用量：输入 ${u.input_tokens} / 输出 ${u.output_tokens} tokens${u.safety_tokens ? `（其中安全审核 ${u.safety_tokens}）` : ''}；` +
      `计费搜索 ${u.tool_search} 次、抓取 ${u.tool_fetch} 次、图片搜索 ${u.tool_image_search} 次；用时 ${value.ms}ms` +
      `${value.stream ? `；流式 ${value.streamed_chunks} 个 chunk` : ''}`,
  )
  if (value.title) lines.push(`建议会话标题：${value.title}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** OCR 结果的可读渲染：逐页文本，超长按页截断。 */
function renderOcr(args, value) {
  if (value && value.error) {
    return [{ type: 'text', text: `deepseek_ocr 失败：${value.error}` }]
  }
  const pages = Array.isArray(value.pages) ? value.pages : []
  const lines = [`deepseek_ocr：${value.page_count} 页，purpose=${value.purpose}，用时 ${value.ms}ms`]
  if (value.saved_to) lines.push(`完整文本已写入：${value.saved_to}（${value.chars} 字）`)
  pages.forEach((p, i) => {
    const text = typeof p.text === 'string' ? p.text : ''
    lines.push('', `--- 第 ${i + 1} 页（finish_reason=${p.finish_reason || 'stop'}）---`)
    lines.push(text.length > 3_000 ? `${text.slice(0, 3_000)}\n…（本页共 ${text.length} 字，已截断）` : text)
  })
  return [{ type: 'text', text: lines.join('\n') }]
}

/** ASR 结果的可读渲染。 */
function renderTranscribe(args, value) {
  if (value && value.error) {
    return [{ type: 'text', text: `deepseek_transcribe 失败：${value.error}` }]
  }
  return [
    {
      type: 'text',
      text: `deepseek_transcribe：${value.duration_ms} ms 音频 → ${value.chars} 字（用时 ${value.ms}ms）\n\n${value.text}`,
    },
  ]
}

/** TTS 结果的可读渲染。 */
function renderSpeak(args, value) {
  if (value && value.error) {
    return [{ type: 'text', text: `deepseek_speak 失败：${value.error}` }]
  }
  return [
    {
      type: 'text',
      text:
        `已合成音频：${value.path}\n` +
        `${value.bytes} 字节，格式 ${value.format}，音色 ${value.voice_id}，计费字符 ${value.billable_chars}，用时 ${value.ms}ms`,
    },
  ]
}

/** 宽松 object schema：返回形状含可选字段与空值，由 render 负责可读性。 */
const LOOSE_OBJECT = { type: 'object', additionalProperties: true, properties: {} }

/**
 * 构造 deepseek_search 工具。
 * @param {object} ctx Cordis 上下文。
 */
function makeSearchTool(ctx) {
  return {
    name: 'deepseek_search',
    description:
      'Search the web through the DeepSeek official Search API (POST https://api.deepseek.com/v1/tools/search). ' +
      'One HTTP call, 5 CNY per 1000 successful requests (failures and empty results are free). ' +
      'Returns structured results: title, url, snippet (100-200 chars), summary (600-800 chars, best for reading), ' +
      'published date (RFC3339), authority (0-4, >=3 is highly authoritative), rerank_score (0-3, >=1.5 is good). ' +
      'Query supports operators: site:github.com, -site:example.com, "exact phrase", lang:zh,en, after:2025, before:2026-06. ' +
      'Use it when you need ranked, dated or site-filtered results, or lower latency than the built-in web_search. ' +
      'For full page text use deepseek_fetch or web_fetch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Search query, 1-128 Unicode chars. Supports site:/lang:/after:/before:/"phrase" operators.',
        },
        count: {
          type: 'integer',
          description: 'Number of results, 1-50. Default 5. Does not change the per-request price.',
        },
        need_content: {
          type: 'boolean',
          description: 'When true, each result also carries the full page content (much larger output).',
        },
        ori_question: {
          type: 'string',
          description: 'Original user question, 1-128 chars, helps the search understand intent.',
        },
      },
    },
    output: {
      schema: LOOSE_OBJECT,
      render: renderSearch,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query.length === 0) {
        return { query: '', count: 0, results: [], error: 'query is required', ms: 0 }
      }
      if (query.length > 128) {
        return { query, count: 0, results: [], error: 'query must be at most 128 chars', ms: 0 }
      }
      const resolved = await resolveKey(ctx)
      if (resolved === null) {
        return { query, count: 0, results: [], error: NO_KEY_MESSAGE, ms: 0 }
      }
      const body = { query, count: clampCount(args?.count) }
      if (args?.need_content === true) body.need_content = true
      if (typeof args?.ori_question === 'string' && args.ori_question.trim().length > 0) {
        body.ori_question = args.ori_question.trim().slice(0, 128)
      }
      const r = await postJson(SEARCH_PATH, body, SEARCH_TIMEOUT_MS, resolved.key)
      if (!r.ok) {
        const detail = r.body?.error?.message ?? r.raw.slice(0, 500)
        return { query, count: 0, results: [], error: `HTTP ${r.status}: ${detail}`, ms: r.ms }
      }
      const raw = Array.isArray(r.body?.results) ? r.body.results : []
      return {
        query,
        count: raw.length,
        results: raw.map(normalizeResult),
        ms: r.ms,
        source: resolved.source,
      }
    },
  }
}

/**
 * 构造 deepseek_fetch 工具。
 * @param {object} ctx Cordis 上下文。
 */
function makeFetchTool(ctx) {
  return {
    name: 'deepseek_fetch',
    description:
      'Fetch one web page through the DeepSeek official Fetch API (POST https://api.deepseek.com/v1/tools/fetch) ' +
      'and return its title plus Markdown content. 5 CNY per 1000 successful fetches; a 4xx that yields no content is free. ' +
      'Use it when web_fetch is blocked (e.g. SSRF/fake-ip guard) or when you need clean Markdown. ' +
      '403 means the request was refused by the safety policy; 404 means no extractable content. Do not retry 4xx.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'HTTP(S) URL, at most 8192 chars, with a host and no credentials in it.',
        },
      },
    },
    output: {
      schema: LOOSE_OBJECT,
      render: renderFetch,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const url = typeof args?.url === 'string' ? args.url.trim() : ''
      if (!/^https?:\/\/\S+$/i.test(url)) {
        return { url, title: '', content: '', chars: 0, error: 'url must be an http(s) URL', ms: 0 }
      }
      const resolved = await resolveKey(ctx)
      if (resolved === null) {
        return { url, title: '', content: '', chars: 0, error: NO_KEY_MESSAGE, ms: 0 }
      }
      const r = await postJson(FETCH_PATH, { url }, FETCH_TIMEOUT_MS, resolved.key)
      if (!r.ok) {
        const detail = r.body?.error?.message ?? r.raw.slice(0, 500)
        return { url, title: '', content: '', chars: 0, error: `HTTP ${r.status}: ${detail}`, ms: r.ms }
      }
      const content = typeof r.body?.content === 'string' ? r.body.content : ''
      return {
        url,
        title: typeof r.body?.title === 'string' ? r.body.title : '',
        content,
        chars: content.length,
        ms: r.ms,
        source: resolved.source,
      }
    },
  }
}

/** 按扩展名推断 purpose：解析类（按页计费）还是 user_data（不计费）。 */
function autoPurpose(file) {
  const ext = extname(file).toLowerCase()
  if (PARSED_EXT.has(ext)) return 'text_recognition'
  if (TEXT_EXT.has(ext)) return 'user_data'
  return 'text_recognition'
}

/**
 * 上传并解析一个本地文件，返回 { file_id, filename, bytes, purpose, ms } 或 { error }。
 * purpose 必须放在 multipart 的 file 字段之前（服务端要求）。
 */
async function uploadFile(ctx, filePath, purposeArg) {
  const resolved = await resolveKey(ctx)
  if (resolved === null) return { error: NO_KEY_MESSAGE, ms: 0 }

  let info
  try {
    info = statSync(filePath)
  } catch (error) {
    return { error: `cannot stat ${filePath}: ${error.code ?? error.message}`, ms: 0 }
  }
  if (!info.isFile()) return { error: `${filePath} is not a regular file`, ms: 0 }

  const purpose = purposeArg && purposeArg !== 'auto' ? purposeArg : autoPurpose(filePath)
  const limit = purpose === 'user_data' ? USER_DATA_MAX_BYTES : PARSE_MAX_BYTES
  if (info.size > limit) {
    return { error: `${filePath} is ${info.size} B, over the ${limit} B limit for purpose=${purpose}`, ms: 0 }
  }

  const filename = basename(filePath)
  const data = await readFile(filePath)
  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', new Blob([data]), filename)

  const r = await postForm(UPLOAD_PATH, form, UPLOAD_TIMEOUT_MS, resolved.key)
  if (!r.ok) {
    const detail = r.body?.error?.message ?? r.raw.slice(0, 500)
    return { error: `HTTP ${r.status}: ${detail}`, ms: r.ms }
  }
  const id = r.body?.id
  if (typeof id !== 'string' || id.length === 0) {
    return { error: `unexpected upload response: ${r.raw.slice(0, 300)}`, ms: r.ms }
  }
  return {
    file_id: id,
    filename: typeof r.body?.filename === 'string' ? r.body.filename : filename,
    bytes: num(r.body?.bytes) || info.size,
    purpose: typeof r.body?.purpose === 'string' ? r.body.purpose : purpose,
    ms: r.ms,
    source: resolved.source,
  }
}

/**
 * 构造 deepseek_upload_file 工具。
 * @param {object} ctx Cordis 上下文。
 */
function makeUploadTool(ctx) {
  return {
    name: 'deepseek_upload_file',
    description:
      'Upload one local file to the DeepSeek Files API (POST https://api.deepseek.com/files) and return a file_id ' +
      'that deepseek_chat can reference. PDF/Word/PowerPoint/images are parsed at upload time (purpose=text_recognition ' +
      'or rich_layout_recognition, billed per page, 120s parse timeout). Plain text/CSV/JSON/code and XLSX/XLS/EPUB/MOBI ' +
      'are sent as user_data (converted to Markdown server-side, NOT billed, 32 MiB limit). Max 100 MiB per file, ' +
      '1000 pages, 20 documents per chat request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Absolute local file path (Windows path is fine).',
        },
        purpose: {
          type: 'string',
          enum: ['auto', 'text_recognition', 'rich_layout_recognition', 'user_data'],
          description:
            'auto (default): by extension. text_recognition: text only, billable per page. ' +
            'rich_layout_recognition: text + cropped figures, billable per page. user_data: text/tables/ebooks, free.',
        },
      },
    },
    output: {
      schema: LOOSE_OBJECT,
      render: renderUpload,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = typeof args?.path === 'string' ? args.path.trim() : ''
      if (path.length === 0) return { error: 'path is required', ms: 0 }
      const purpose = typeof args?.purpose === 'string' ? args.purpose : 'auto'
      return await uploadFile(ctx, path, purpose)
    },
  }
}

/** 从 Chat Completions 响应里抽引用。 */
function pickCitations(message) {
  const out = []
  for (const a of Array.isArray(message?.annotations) ? message.annotations : []) {
    if (a?.type !== 'url_citation') continue
    const c = a.url_citation ?? {}
    out.push({
      url: typeof c.url === 'string' ? c.url : '',
      title: typeof c.title === 'string' ? c.title : '',
      start_index: num(c.start_index),
      end_index: num(c.end_index),
    })
  }
  return out
}

/** 从 server_tool_calls 抽出「调用」列表（展平步），保留展示用字段。 */
function pickCalls(message) {
  const out = []
  for (const step of Array.isArray(message?.server_tool_calls) ? message.server_tool_calls : []) {
    for (const call of Array.isArray(step?.calls) ? step.calls : []) {
      out.push({
        type: typeof call?.type === 'string' ? call.type : '',
        kind: typeof call?.kind === 'string' ? call.kind : '',
        status: typeof call?.status === 'string' ? call.status : '',
        queries: Array.isArray(call?.action?.queries) ? call.action.queries.filter((q) => typeof q === 'string') : [],
        url:
          typeof call?.action?.url === 'string'
            ? call.action.url
            : typeof call?.page?.url === 'string'
              ? call.page.url
              : '',
        sources: (Array.isArray(call?.sources) ? call.sources : []).slice(0, 8).map((s) => ({
          title: typeof s?.title === 'string' ? s.title : '',
          url: typeof s?.url === 'string' ? s.url : '',
          site_name: typeof s?.site_name === 'string' ? s.site_name : '',
          published_at: typeof s?.published_at === 'string' ? s.published_at : '',
        })),
        error_code: typeof call?.error?.code === 'string' ? call.error.code : '',
      })
    }
  }
  return out
}

/** 增量 SSE 解析器：把网络分片拼成行，逐行解析 `data: {...}`，容忍任意切分点。 */
export function createSseParser() {
  let buf = ''
  return {
    push(text) {
      buf += text
      const events = []
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            events.push({ done: true })
          } else if (payload.length > 0) {
            try {
              events.push({ chunk: JSON.parse(payload) })
            } catch {
              /* 非 JSON 行（保活空白、注释）忽略 */
            }
          }
        }
        idx = buf.indexOf('\n')
      }
      return events
    },
  }
}

/** 流式累积状态（纯数据，便于用固定 SSE 夹具做单元测试）。 */
export function createStreamState() {
  return {
    content: '',
    reasoningChars: 0,
    finish: '',
    annotations: [],
    serverToolCalls: [],
    refusalDetail: '',
    title: '',
    usage: null,
    chunks: 0,
  }
}

/** 把一条 SSE chunk 合并进状态（只改状态，不碰网络）。 */
export function reduceStreamChunk(state, chunk) {
  state.chunks++
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null
  if (choice) {
    const d = choice.delta ?? {}
    if (typeof d.content === 'string') state.content += d.content
    if (typeof d.reasoning_content === 'string') state.reasoningChars += d.reasoning_content.length
    if (typeof d.refusal === 'string') state.refusalDetail = d.refusal
    if (typeof d.title === 'string' && d.title.length > 0) state.title = d.title
    if (Array.isArray(d.annotations)) state.annotations = d.annotations
    if (Array.isArray(d.server_tool_calls)) state.serverToolCalls = d.server_tool_calls
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) state.finish = choice.finish_reason
  }
  if (chunk?.usage) state.usage = chunk.usage
  return state
}

/**
 * 流式收尾：命中 content_filter 时丢弃已经流出的文本，改用拒答文案。
 * 官方口径：已经下发的文本无法撤回，客户端必须删掉已展示的回答。
 */
export function finalizeStream(state, refusalText) {
  const refused = state.finish === 'content_filter'
  const streamed = state.content
  const answer = refused ? refusalText : streamed
  const usage = state.usage ?? {}
  const stu = usage.server_tool_use ?? {}
  const result = {
    answer,
    chars: answer.length,
    finish_reason: state.finish,
    refused,
    truncated: state.finish === 'length',
    discarded_chars: refused ? streamed.length : 0,
    streamed_chunks: state.chunks,
    citations: pickCitations({ annotations: state.annotations }),
    calls: pickCalls({ server_tool_calls: state.serverToolCalls }),
    usage: {
      input_tokens: num(usage.prompt_tokens ?? usage.input_tokens),
      output_tokens: num(usage.completion_tokens ?? usage.output_tokens),
      safety_tokens: num(usage.completion_tokens_details?.safety_tokens ?? usage.output_tokens_details?.safety_tokens),
      tool_search: num(stu.tool_search),
      tool_fetch: num(stu.tool_fetch),
      tool_image_search: num(stu.tool_image_search),
    },
    stream: true,
  }
  if (state.refusalDetail) result.refusal_detail = state.refusalDetail
  if (state.title) result.title = state.title
  if (state.reasoningChars > 0) result.reasoning_chars = state.reasoningChars
  return result
}

/** 发一个流式对话请求，逐个 chunk 交给 onChunk；返回 { ok, status, raw, ms }。 */
async function streamChatRequest(body, timeoutMs, apiKey, onChunk) {
  const t0 = Date.now()
  try {
    const res = await fetch(API_BASE + CHAT_PATH, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok || !res.body) {
      const text = await res.text()
      return { ok: false, status: res.status, raw: text, ms: Date.now() - t0 }
    }
    const parser = createSseParser()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (event.chunk) onChunk(event.chunk)
      }
    }
    return { ok: true, status: res.status, raw: '', ms: Date.now() - t0 }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      raw: error instanceof Error ? error.message : String(error),
      ms: Date.now() - t0,
    }
  }
}

/**
 * 构造 deepseek_chat 工具：deepseek-flash + 服务端联网工具 + 文件引用。
 * @param {object} ctx Cordis 上下文。
 */
function makeChatTool(ctx) {
  return {
    name: 'deepseek_chat',
    description:
      'One-shot DeepSeek chat completion on deepseek-flash with the server-side "full app" tools. ' +
      'Set search=true to declare deepseek_web_search (model searches the web itself and cites sources; with ' +
      'think=true this becomes deep-thinking search with multi-step open_page/find_in_page), read_links=true to declare ' +
      'deepseek_read_url (model reads URLs present in the prompt), and pass file_ids from deepseek_upload_file to attach ' +
      'documents. Search/fetch are billed per call (5 CNY per 1000); tokens are billed separately. ' +
      'Returns the answer text, url citations, the server-side calls with their sources, and billable tool usage.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'User message. Include URLs here when read_links is true (only the last user message is scanned).',
        },
        search: {
          type: 'boolean',
          description: 'Declare the deepseek_web_search tool. Default true.',
        },
        read_links: {
          type: 'boolean',
          description: 'Declare the deepseek_read_url tool. Default true. Only URLs in the prompt are read.',
        },
        think: {
          type: 'boolean',
          description: 'Enable thinking mode (deep-thinking search with search=true). Default false.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Local file paths to upload first (convenience; prefer file_ids when reusing a document).',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'file_id values returned by deepseek_upload_file, referenced as {type:"file"} parts.',
        },
        file_purpose: {
          type: 'string',
          enum: ['auto', 'text_recognition', 'rich_layout_recognition', 'user_data'],
          description: 'Purpose used when uploading items from files. Default auto (by extension).',
        },
        safety: {
          type: 'string',
          enum: ['none', 'high'],
          description: 'none (default) or high: enable the model safety check; a refusal returns finish_reason=content_filter.',
        },
        title: {
          type: 'boolean',
          description: 'Ask the server to also generate a short conversation title. Default false.',
        },
        max_tokens: {
          type: 'integer',
          description: 'Cap output length per reasoning step (not the whole turn). Optional.',
        },
        stream: {
          type: 'boolean',
          description: 'Use SSE streaming (stream:true) and reassemble the answer locally. Default false.',
        },
        refusal_text: {
          type: 'string',
          description:
            'Text returned instead of the answer when the turn ends with finish_reason=content_filter. ' +
            'Default: a short Chinese refusal. Already-streamed text is discarded, as the official docs require.',
        },
      },
    },
    output: {
      schema: LOOSE_OBJECT,
      render: renderChat,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) return { answer: '', error: 'prompt is required', ms: 0 }

      const resolved = await resolveKey(ctx)
      if (resolved === null) return { answer: '', error: NO_KEY_MESSAGE, ms: 0 }

      const refusalText =
        typeof args?.refusal_text === 'string' && args.refusal_text.trim().length > 0
          ? args.refusal_text.trim()
          : DEFAULT_REFUSAL_TEXT

      // 先把本地文件上传，拿到 file_id。
      const fileIds = (Array.isArray(args?.file_ids) ? args.file_ids : []).filter((v) => typeof v === 'string' && v.trim())
      const paths = (Array.isArray(args?.files) ? args.files : []).filter((v) => typeof v === 'string' && v.trim())
      const uploads = []
      for (const p of paths) {
        const up = await uploadFile(ctx, p, typeof args?.file_purpose === 'string' ? args.file_purpose : 'auto')
        if (up.error) {
          return { answer: '', error: `upload ${p} failed: ${up.error}`, ms: 0, uploads }
        }
        uploads.push({ file_id: up.file_id, filename: up.filename, purpose: up.purpose })
        fileIds.push(up.file_id)
      }
      if (fileIds.length > 20) {
        return { answer: '', error: `at most 20 documents per request (got ${fileIds.length})`, ms: 0, uploads }
      }

      const parts = []
      for (const id of fileIds) parts.push({ type: 'file', file_id: id })
      if (parts.length > 0) parts.push({ type: 'text', text: prompt })

      const streaming = args?.stream === true
      const body = {
        model: MODEL,
        messages: [{ role: 'user', content: parts.length > 0 ? parts : prompt }],
        stream: streaming,
      }
      const tools = []
      if (args?.search !== false) tools.push({ type: 'deepseek_web_search' })
      if (args?.read_links !== false) tools.push({ type: 'deepseek_read_url' })
      if (tools.length > 0) body.tools = tools
      if (args?.think === true) body.thinking = { type: 'enabled' }
      if (args?.safety === 'high') body.safety_check = { level: 'high' }
      if (args?.title === true) body.title = { enabled: true }
      if (Number.isFinite(args?.max_tokens) && args.max_tokens > 0) body.max_tokens = Math.trunc(args.max_tokens)

      if (streaming) {
        const state = createStreamState()
        const r = await streamChatRequest(body, CHAT_TIMEOUT_MS, resolved.key, (chunk) => reduceStreamChunk(state, chunk))
        if (!r.ok) {
          return { answer: '', error: `HTTP ${r.status}: ${r.raw.slice(0, 800)}`, ms: r.ms, uploads }
        }
        const result = finalizeStream(state, refusalText)
        result.model = MODEL
        result.ms = r.ms
        result.source = resolved.source
        if (uploads.length > 0) result.uploads = uploads
        return result
      }

      const r = await postJson(CHAT_PATH, body, CHAT_TIMEOUT_MS, resolved.key)
      if (!r.ok) {
        const detail = r.body?.error?.message ?? r.raw.slice(0, 800)
        return { answer: '', error: `HTTP ${r.status}: ${detail}`, ms: r.ms, uploads }
      }

      const choice = Array.isArray(r.body?.choices) ? r.body.choices[0] : null
      const message = choice?.message ?? {}
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : ''
      const refused = finishReason === 'content_filter'
      const rawAnswer = typeof message.content === 'string' ? message.content : ''
      const answer = refused ? refusalText : rawAnswer
      const usage = r.body?.usage ?? {}
      const stu = usage.server_tool_use ?? {}
      const result = {
        answer,
        chars: answer.length,
        finish_reason: finishReason,
        refused,
        discarded_chars: 0,
        citations: pickCitations(message),
        calls: pickCalls(message),
        usage: {
          input_tokens: num(usage.prompt_tokens ?? usage.input_tokens),
          output_tokens: num(usage.completion_tokens ?? usage.output_tokens),
          safety_tokens: num(usage.completion_tokens_details?.safety_tokens ?? usage.output_tokens_details?.safety_tokens),
          tool_search: num(stu.tool_search),
          tool_fetch: num(stu.tool_fetch),
          tool_image_search: num(stu.tool_image_search),
        },
        model: typeof r.body?.model === 'string' ? r.body.model : MODEL,
        ms: r.ms,
        source: resolved.source,
      }
      if (typeof message.refusal === 'string' && message.refusal.length > 0) result.refusal_detail = message.refusal
      if (typeof message.title === 'string' && message.title.length > 0) result.title = message.title
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        result.reasoning_chars = message.reasoning_content.length
      }
      if (uploads.length > 0) result.uploads = uploads
      return result
    },
  }
}

/**
 * 构造 deepseek_ocr 工具：POST /v1/tools/ocr（multipart），逐页返回识别文本。
 * @param {object} ctx Cordis 上下文。
 */
function makeOcrTool(ctx) {
  return {
    name: 'deepseek_ocr',
    description:
      'Run OCR on a local PDF/Word/PowerPoint/image via POST https://api.deepseek.com/v1/tools/ocr (multipart: purpose ' +
      'then file). Billed 1.5 CNY per 1000 successful pages; failure/timeout is free. Returns pages[] with raw model ' +
      'output. purpose=text_recognition extracts text only (Word/PowerPoint without images are extracted directly); ' +
      'rich_layout_recognition keeps layout markers such as <|ref|>..<|/ref|><|box|>[[x1,y1,x2,y2]]<|/box|> whose ' +
      'coordinates are normalized to 0-1000 of the page size. Limits: 100 MiB, 1000 pages, 180s total. Use this when ' +
      'you only need the text; use deepseek_upload_file + deepseek_chat when the model should answer about the file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Absolute local file path (PDF, DOC/DOCX, PPT/PPTX, PNG/JPEG/WebP/GIF/BMP/TIFF).',
        },
        purpose: {
          type: 'string',
          enum: ['text_recognition', 'rich_layout_recognition'],
          description:
            'text_recognition (default): text only, images dropped, Word/PowerPoint text extracted directly. ' +
            'rich_layout_recognition: page-by-page recognition with layout markers and coordinates.',
        },
        save_to: {
          type: 'string',
          description: 'Optional local path; the full multi-page text is also written there as UTF-8 (useful for long docs).',
        },
      },
    },
    output: {
      schema: LOOSE_OBJECT,
      render: renderOcr,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = typeof args?.path === 'string' ? args.path.trim() : ''
      if (path.length === 0) return { pages: [], page_count: 0, error: 'path is required', ms: 0 }

      let info
      try {
        info = statSync(path)
      } catch (error) {
        return { pages: [], page_count: 0, error: `cannot stat ${path}: ${error.code ?? error.message}`, ms: 0 }
      }
      if (!info.isFile()) return { pages: [], page_count: 0, error: `${path} is not a regular file`, ms: 0 }
      if (info.size > PARSE_MAX_BYTES) {
        return { pages: [], page_count: 0, error: `${path} is ${info.size} B, over the 100 MiB OCR limit`, ms: 0 }
      }

      const resolved = await resolveKey(ctx)
      if (resolved === null) return { pages: [], page_count: 0, error: NO_KEY_MESSAGE, ms: 0 }

      const purpose = args?.purpose === 'rich_layout_recognition' ? 'rich_layout_recognition' : 'text_recognition'
      const data = await readFile(path)
      const form = new FormData()
      form.append('purpose', purpose)
      form.append('file', new Blob([data]), basename(path))

      const r = await postForm(OCR_PATH, form, OCR_TIMEOUT_MS, resolved.key)
      if (!r.ok) {
        const detail = r.body?.error?.message ?? r.raw.slice(0, 500)
        return { pages: [], page_count: 0, error: `HTTP ${r.status}: ${detail}`, ms: r.ms }
      }
      if (r.body?.error) {
        // 识别已开始后失败：HTTP 200 但响应体是错误对象
        return { pages: [], page_count: 0, error: `OCR error: ${r.body.error.message ?? r.raw.slice(0, 300)}`, ms: r.ms }
      }

      const pages = (Array.isArray(r.body?.pages) ? r.body.pages : []).map((p, i) => ({
        index: Number.isFinite(p?.index) ? p.index : i,
        text: typeof p?.text === 'string' ? p.text : '',
        finish_reason: typeof p?.finish_reason === 'string' ? p.finish_reason : 'stop',
      }))
      const full = pages.map((p) => p.text).join('\n\n')

      let saved_to = ''
      if (typeof args?.save_to === 'string' && args.save_to.trim().length > 0) {
        const target = resolve(args.save_to.trim())
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, full, 'utf8')
        saved_to = target
      }

      return {
        page_count: pages.length,
        purpose: typeof r.body?.purpose === 'string' ? r.body.purpose : purpose,
        pages,
        chars: full.length,
        saved_to,
        usage: {
          input_tokens: num(r.body?.usage?.input_tokens),
          output_tokens: num(r.body?.usage?.output_tokens),
        },
        ms: r.ms,
        source: resolved.source,
      }
    },
  }
}

/**
 * 构造 deepseek_transcribe 工具：POST /v1/tools/asr（multipart），整段转写。
 * @param {object} ctx Cordis 上下文。
 */
function makeTranscribeTool(ctx) {
  return {
    name: 'deepseek_transcribe',
    description:
      'Transcribe one audio file via POST https://api.deepseek.com/v1/tools/asr (multipart field "file"). ' +
      'Accepts 16-bit PCM WAV (8000/16000/22050/24000/32000/44100/48000 Hz) or Ogg Opus, mono or stereo (only the left ' +
      'channel is recognized), at most 8 MiB and 120 seconds. Language is auto-detected (zh/yue/en/ja/ko/de/fr/es/...). ' +
      'Billed per second of audio (0.39 CNY/hour during the 5x promo). Returns text and duration_ms. No streaming.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Absolute local path to a 16-bit PCM WAV or Ogg Opus file (<= 8 MiB, <= 120 s).',
        },
      },
    },
    output: {
      schema: LOOSE_OBJECT,
      render: renderTranscribe,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = typeof args?.path === 'string' ? args.path.trim() : ''
      if (path.length === 0) return { text: '', chars: 0, error: 'path is required', ms: 0 }

      let info
      try {
        info = statSync(path)
      } catch (error) {
        return { text: '', chars: 0, error: `cannot stat ${path}: ${error.code ?? error.message}`, ms: 0 }
      }
      if (!info.isFile()) return { text: '', chars: 0, error: `${path} is not a regular file`, ms: 0 }
      if (info.size > 8 * 1024 * 1024) {
        return { text: '', chars: 0, error: `${path} is ${info.size} B, over the 8 MiB ASR limit`, ms: 0 }
      }

      const resolved = await resolveKey(ctx)
      if (resolved === null) return { text: '', chars: 0, error: NO_KEY_MESSAGE, ms: 0 }

      const data = await readFile(path)
      const form = new FormData()
      form.append('file', new Blob([data]), basename(path))

      const r = await postForm(ASR_PATH, form, ASR_TIMEOUT_MS, resolved.key)
      if (!r.ok) {
        const detail = r.body?.error?.message ?? r.raw.slice(0, 500)
        return { text: '', chars: 0, error: `HTTP ${r.status}: ${detail}`, ms: r.ms }
      }
      const text = typeof r.body?.text === 'string' ? r.body.text : ''
      return {
        text,
        chars: text.length,
        duration_ms: num(r.body?.duration_ms),
        bytes: info.size,
        ms: r.ms,
        source: resolved.source,
      }
    },
  }
}

/** 计费字符：汉字算 2，其他算 1（官方口径）。 */
function billableChars(text) {
  let n = 0
  for (const ch of text) n += /[\u3400-\u9fff\uf900-\ufaff]/.test(ch) ? 2 : 1
  return n
}

/**
 * 构造 deepseek_speak 工具：POST /v1/tools/tts（JSON → 音频字节落盘）。
 * @param {object} ctx Cordis 上下文。
 */
function makeSpeakTool(ctx) {
  return {
    name: 'deepseek_speak',
    description:
      'Synthesize speech from text via POST https://api.deepseek.com/v1/tools/tts and save the audio to a local file. ' +
      'voice_id: stella (female, default) or tide (male). format: wav (default) or pcm (24 kHz 16-bit mono raw). ' +
      'filter_markdown defaults to true (strips Markdown before reading). At most 10,000 billable characters ' +
      '(a CJK char counts as 2) and a 64 KiB request body; up to 30 minutes of audio per request. ' +
      'Billed 1.5 CNY per 10,000 characters during the 5x promo. No speed control, no resume.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'Text to read. Cannot be empty; at most 10,000 billable characters, 64 KiB body.',
        },
        voice_id: {
          type: 'string',
          enum: ['stella', 'tide'],
          description: 'Voice: stella (female, default) or tide (male).',
        },
        format: {
          type: 'string',
          enum: ['wav', 'pcm'],
          description: 'wav (default, audio/wav) or pcm (24 kHz 16-bit mono raw; you must wrap it yourself).',
        },
        filter_markdown: {
          type: 'boolean',
          description: 'Strip Markdown before reading. Default true.',
        },
        output: {
          type: 'string',
          description:
            'Local output path. Default: <cwd>\\_quarantine\\ds-tts\\tts-<timestamp>.<format>. Parent dirs are created.',
        },
      },
    },
    output: {
      schema: LOOSE_OBJECT,
      render: renderSpeak,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text : ''
      if (text.trim().length === 0) return { path: '', bytes: 0, error: 'text is required', ms: 0 }
      const billed = billableChars(text)
      if (billed > 10_000) {
        return { path: '', bytes: 0, error: `text is ${billed} billable chars, over the 10,000 limit`, ms: 0 }
      }

      const resolved = await resolveKey(ctx)
      if (resolved === null) return { path: '', bytes: 0, error: NO_KEY_MESSAGE, ms: 0 }

      const format = args?.format === 'pcm' ? 'pcm' : 'wav'
      const voice = args?.voice_id === 'tide' ? 'tide' : 'stella'
      const body = { text, voice_id: voice, format }
      if (args?.filter_markdown === false) body.filter_markdown = false

      const r = await postBinary(TTS_PATH, body, TTS_TIMEOUT_MS, resolved.key)
      if (!r.ok) {
        const detail = r.body?.error?.message ?? r.raw.slice(0, 500)
        return { path: '', bytes: 0, error: `HTTP ${r.status}: ${detail}`, ms: r.ms }
      }
      if (!r.bytes || r.bytes.length === 0) {
        return { path: '', bytes: 0, error: 'empty audio response', ms: r.ms }
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target =
        typeof args?.output === 'string' && args.output.trim().length > 0
          ? resolve(args.output.trim())
          : join(process.cwd(), '_quarantine', 'ds-tts', `tts-${stamp}.${format}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, r.bytes)

      return {
        path: target,
        bytes: r.bytes.length,
        format,
        voice_id: voice,
        billable_chars: billed,
        content_type: r.type,
        ms: r.ms,
        source: resolved.source,
      }
    },
  }
}

/**
 * 挂载插件：注册七个工具。
 * @param {object} ctx Cordis 上下文。
 */
export function apply(ctx) {
  ctx.tools.register(makeSearchTool(ctx))
  ctx.tools.register(makeFetchTool(ctx))
  ctx.tools.register(makeUploadTool(ctx))
  ctx.tools.register(makeChatTool(ctx))
  ctx.tools.register(makeOcrTool(ctx))
  ctx.tools.register(makeTranscribeTool(ctx))
  ctx.tools.register(makeSpeakTool(ctx))
}
