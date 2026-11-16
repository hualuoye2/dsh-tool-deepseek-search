// 自测：用 DSH 自己的真实 schema 校验器 + 真实 API 调用，验证四个工具的注册与执行。
//
// 为什么不用假校验器：AGENTS.md 记过，只把工具定义塞进 Map 的替身会掩盖
// "工具注册在真实运行时必然失败"（schema 不在支持子集内）。这里直接用 dsh-tools 导出的
// assertSupportedJsonSchema / validateJsonSchemaValue。
//
// 计费：Search 2 条 + Fetch 1 次 + user_data 上传（免费，不计费）+ 两次对话（token 费）。
// 不跑 text_recognition / rich_layout_recognition 上传，避免按页解析费。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { apply, createSseParser, createStreamState, reduceStreamChunk, finalizeStream } from '../index.mjs'

const validatorsPath =
  'C:\\Users\\常绚\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js'
const v = await import(pathToFileURL(validatorsPath).href)

const registered = new Map()
const ctx = {
  tools: {
    register(def) {
      if (registered.has(def.name)) throw new Error('duplicate tool: ' + def.name)
      registered.set(def.name, def)
    },
  },
}

apply(ctx)
console.log('registered tools:', [...registered.keys()].join(', '))

let failures = 0
const expect = (label, ok, detail) => {
  if (ok) {
    console.log(`PASS ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    failures++
    console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

for (const def of registered.values()) {
  try {
    v.assertSupportedJsonSchema(def.parameters)
    v.assertSupportedJsonSchema(def.output.schema)
    console.log('schema OK:', def.name)
  } catch (error) {
    failures++
    console.log('schema FAIL:', def.name, '-', error.message)
  }
}

// ---- 1. 原有：结构化搜索 ----
const search = registered.get('deepseek_search')
const out = await search.execute({ query: 'DeepSeek V4 发布', count: 2 })
const violations = v.validateJsonSchemaValue(search.output.schema, out, '')
if (violations.length > 0) {
  failures++
  console.log('search output violations:', violations)
}
expect('deepseek_search 返回结果', !out.error && out.count > 0, `count=${out.count} ms=${out.ms} error=${out.error ?? 'none'}`)

// ---- 2. 原有：抓正文 ----
const fetchTool = registered.get('deepseek_fetch')
const page = await fetchTool.execute({ url: 'https://api-docs.deepseek.com/zh-cn/guides/search/' })
const fViolations = v.validateJsonSchemaValue(fetchTool.output.schema, page, '')
if (fViolations.length > 0) {
  failures++
  console.log('fetch output violations:', fViolations)
}
expect('deepseek_fetch 取回正文', !page.error && page.chars > 200, `chars=${page.chars} ms=${page.ms} error=${page.error ?? 'none'}`)

// ---- 3. 新增：文件上传（user_data，不计费）----
const dir = 'D:\\deepseek\\_quarantine\\ds-selftest'
mkdirSync(dir, { recursive: true })
const sample = `${dir}\\sample.md`
writeFileSync(sample, '# 自测样本\n\n暗号是 ORION-7391。只回答这一句：暗号是 ORION-7391。\n', 'utf8')

const uploadTool = registered.get('deepseek_upload_file')
const up = await uploadTool.execute({ path: sample })
const uViolations = v.validateJsonSchemaValue(uploadTool.output.schema, up, '')
if (uViolations.length > 0) {
  failures++
  console.log('upload output violations:', uViolations)
}
expect(
  'deepseek_upload_file 拿到 file_id',
  !up.error && typeof up.file_id === 'string' && up.file_id.startsWith('file-api-'),
  `file_id=${up.file_id ?? '-'} purpose=${up.purpose} bytes=${up.bytes} ms=${up.ms} error=${up.error ?? 'none'}`,
)
console.log('  upload file_id:', up.file_id, '| purpose:', up.purpose, '| bytes:', up.bytes)

// ---- 4. 新增：对话引用文档（不联网，只花 token）----
const chatTool = registered.get('deepseek_chat')
const byFile = await chatTool.execute({
  prompt: '这份文档里写的暗号是什么？只回答暗号本身。',
  file_ids: up.file_id ? [up.file_id] : [],
  search: false,
  read_links: false,
  max_tokens: 128,
})
const cViolations = v.validateJsonSchemaValue(chatTool.output.schema, byFile, '')
if (cViolations.length > 0) {
  failures++
  console.log('chat output violations:', cViolations)
}
expect(
  'deepseek_chat 读到上传的文档（含暗号）',
  !byFile.error && byFile.answer.includes('ORION-7391'),
  `finish=${byFile.finish_reason} chars=${byFile.chars} ms=${byFile.ms} error=${byFile.error ?? 'none'}`,
)
console.log('  answer:', (byFile.answer ?? '').slice(0, 160).replace(/\n/g, ' '))
console.log('  usage:', JSON.stringify(byFile.usage))

// ---- 5. 新增：内嵌联网搜索（服务端工具 + 引用 + 计费用量）----
const bySearch = await chatTool.execute({
  prompt: '用一句话说明 DeepSeek 全家桶应用 API 是哪天发布的，并给出官方文档链接。',
  search: true,
  read_links: false,
  max_tokens: 300,
})
expect(
  'deepseek_chat 内嵌联网搜索有回答与引用',
  !bySearch.error && bySearch.answer.length > 0 && Array.isArray(bySearch.citations),
  `finish=${bySearch.finish_reason} chars=${bySearch.chars} citations=${bySearch.citations?.length ?? 0} ms=${bySearch.ms} error=${bySearch.error ?? 'none'}`,
)
console.log('  answer:', (bySearch.answer ?? '').slice(0, 200).replace(/\n/g, ' '))
console.log('  citations:', JSON.stringify((bySearch.citations ?? []).slice(0, 3)))
console.log('  calls:', JSON.stringify((bySearch.calls ?? []).slice(0, 3)))
console.log('  usage:', JSON.stringify(bySearch.usage))

// ---- 6. 新增：OCR（图片 → 文本）----
const ocrTool = registered.get('deepseek_ocr')
const ocrPath = 'D:\\deepseek\\_quarantine\\ds-selftest\\ocr-sample.png'
const ocr = await ocrTool.execute({ path: ocrPath, save_to: 'D:\\deepseek\\_quarantine\\ds-selftest\\ocr-result.txt' })
const oViolations = v.validateJsonSchemaValue(ocrTool.output.schema, ocr, '')
if (oViolations.length > 0) {
  failures++
  console.log('ocr output violations:', oViolations)
}
const ocrText = (ocr.pages ?? []).map((p) => p.text).join('\n')
expect(
  'deepseek_ocr 识别出图片里的文字',
  !ocr.error && /ORION|OCR|全家桶|自测/i.test(ocrText),
  `pages=${ocr.page_count} chars=${ocr.chars} saved=${ocr.saved_to || '-'} ms=${ocr.ms} error=${ocr.error ?? 'none'}`,
)
console.log('  ocr text:', ocrText.slice(0, 200).replace(/\n/g, ' | '))

// ---- 7. 新增：TTS（文本 → 音频文件）----
const speakTool = registered.get('deepseek_speak')
const wavPath = 'D:\\deepseek\\_quarantine\\ds-selftest\\tts-selftest.wav'
const wav = await speakTool.execute({
  text: '全家桶接口自测，暗号 ORION 七三九一。',
  voice_id: 'stella',
  format: 'wav',
  output: wavPath,
})
const wViolations = v.validateJsonSchemaValue(speakTool.output.schema, wav, '')
if (wViolations.length > 0) {
  failures++
  console.log('tts output violations:', wViolations)
}
let riff = ''
try {
  riff = readFileSync(wavPath).subarray(0, 4).toString('latin1')
} catch {
  riff = '(missing)'
}
expect(
  'deepseek_speak 写出可用的 WAV',
  !wav.error && wav.bytes > 5_000 && riff === 'RIFF',
  `bytes=${wav.bytes} riff=${riff} billable=${wav.billable_chars} ms=${wav.ms} error=${wav.error ?? 'none'}`,
)

// ---- 8. 新增：ASR（把刚合成的音频转回文字，闭环）----
const asrTool = registered.get('deepseek_transcribe')
const asr = await asrTool.execute({ path: wavPath })
const aViolations = v.validateJsonSchemaValue(asrTool.output.schema, asr, '')
if (aViolations.length > 0) {
  failures++
  console.log('asr output violations:', aViolations)
}
expect(
  'deepseek_transcribe 转写回原文关键词',
  !asr.error && /全家桶|ORION|暗号/i.test(asr.text ?? ''),
  `duration=${asr.duration_ms}ms chars=${asr.chars} ms=${asr.ms} error=${asr.error ?? 'none'}`,
)
console.log('  asr text:', (asr.text ?? '').slice(0, 160))

// ---- 9. 流式 SSE 解析：夹具测试（不花钱，先证明解析器本身对）----
const parser = createSseParser()
const ev1 = parser.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"con')
expect(
  'SSE 解析：分片在 JSON 中间切断也不丢事件',
  ev1.length === 1 && ev1[0].chunk?.choices?.[0]?.delta?.content === '你',
  `events=${ev1.length}`,
)
const ev2 = parser.push('tent":"好"}}]}\n\ndata: [DONE]\n\n')
expect(
  'SSE 解析：补全剩余分片并识别 [DONE]',
  ev2.length === 2 && ev2[0].chunk?.choices?.[0]?.delta?.content === '好' && ev2[1].done === true,
  `events=${ev2.length}`,
)

// ---- 10. 拒答夹具：已流出的文本必须被丢弃、换成拒答文案 ----
const partial = '这是一段不该展示的回答'
const refusalState = createStreamState()
reduceStreamChunk(refusalState, { choices: [{ delta: { content: partial.slice(0, 4) } }] })
reduceStreamChunk(refusalState, { choices: [{ delta: { content: partial.slice(4) } }] })
reduceStreamChunk(refusalState, {
  choices: [{ delta: { refusal: 'The following images were blocked by content moderation: messages.1.content.0' }, finish_reason: 'content_filter' }],
  usage: { prompt_tokens: 12, completion_tokens: 30, completion_tokens_details: { safety_tokens: 30 } },
})
const refusal = finalizeStream(refusalState, '【拒答】这个问题我不能回答。')
const refusalRender = registered.get('deepseek_chat').output.render({}, refusal)[0].text
expect(
  '拒答：丢弃已流出文本、换文案、保留审核用量',
  refusal.refused === true &&
    refusal.answer === '【拒答】这个问题我不能回答。' &&
    refusal.discarded_chars === partial.length &&
    refusal.usage.safety_tokens === 30 &&
    /丢弃.*11 字/.test(refusalRender),
  `refused=${refusal.refused} discarded=${refusal.discarded_chars}/${partial.length} safety_tokens=${refusal.usage.safety_tokens}`,
)
console.log('  refusal render:', refusalRender.split('\n')[0])

// ---- 11. 正常夹具：流式最后一帧的 annotations / server_tool_calls 要能取到 ----
const okState = createStreamState()
reduceStreamChunk(okState, { choices: [{ delta: { content: '答案' } }] })
reduceStreamChunk(okState, {
  choices: [{
    delta: {
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/a', title: 'A', start_index: 0, end_index: 2 } }],
      server_tool_calls: [{
        index: 0,
        calls: [{
          type: 'deepseek_web_search', kind: 'search', status: 'completed',
          action: { type: 'search', queries: ['q'] },
          sources: [{ url: 'https://example.com/a', title: 'A', site_name: 'Example' }],
        }],
      }],
    },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, server_tool_use: { tool_search: 1 } },
})
const okStream = finalizeStream(okState, 'x')
expect(
  '流式收尾：引用与工具调用从最后一帧解析出来',
  okStream.refused === false && okStream.answer === '答案' && okStream.citations.length === 1 &&
    okStream.calls.length === 1 && okStream.usage.tool_search === 1,
  `citations=${okStream.citations.length} calls=${okStream.calls.length} tool_search=${okStream.usage.tool_search}`,
)

// ---- 12. 真实流式调用（不联网、不开安全审核，只烧 token）----
// 注意：deepseek-flash 在 Chat Completions 里默认会先输出 reasoning_content，
// max_tokens 太小会整轮只拿到思考、content 为空（实测 max_tokens=64 时 finish=length 且 chars=0）。
const streamed = await chatTool.execute({
  prompt: '用一句话说明你是什么模型。',
  search: false,
  read_links: false,
  stream: true,
  max_tokens: 512,
})
expect(
  'deepseek_chat 真实流式调用可用',
  !streamed.error && streamed.stream === true && streamed.answer.length > 0 && streamed.finish_reason === 'stop',
  `chunks=${streamed.streamed_chunks} chars=${streamed.chars} reasoning=${streamed.reasoning_chars} finish=${streamed.finish_reason} ms=${streamed.ms} error=${streamed.error ?? 'none'}`,
)

// ---- 13. safety_check=high 的真实请求：正常内容不误拒，且能拿到 safety_tokens ----
const safe = await chatTool.execute({
  prompt: '用一句话解释什么是 HTTP 缓存。',
  search: false,
  read_links: false,
  safety: 'high',
  max_tokens: 300,
})
expect(
  'safety_check=high 正常回答不误拒',
  !safe.error && safe.refused === false && safe.answer.length > 0,
  `finish=${safe.finish_reason} chars=${safe.chars} safety_tokens=${safe.usage?.safety_tokens} ms=${safe.ms} error=${safe.error ?? 'none'}`,
)
console.log('  safety answer:', (safe.answer ?? '').slice(0, 100).replace(/\n/g, ' '))

console.log(failures === 0 ? '\nSELFTEST: PASS' : `\nSELFTEST: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
