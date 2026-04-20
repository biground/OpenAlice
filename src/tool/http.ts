/**
 * HTTP Fetch AI Tools
 *
 * httpFetch:
 *   通用 HTTP 请求工具，支持 GET/POST/PUT/DELETE。
 *   安全限制：仅允许 localhost/127.0.0.1 请求（防 SSRF）。
 *
 * httpFetchJson:
 *   JSON API 专用，自动设置 Content-Type 和解析 JSON 响应。
 *   同样的 localhost 限制。
 */

import { tool } from 'ai'
import { z } from 'zod'

const MAX_RESPONSE_BYTES = 1_048_576 // 1 MB
const DEFAULT_TIMEOUT_MS = 30_000

/** 允许的 localhost 主机名精确集合（防 SSRF） */
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '[::1]',
  '::ffff:127.0.0.1',
])

/** 校验 URL 是否指向 localhost，拒绝外部请求 */
function assertLocalhost(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`无效的 URL: ${raw}`)
  }

  // URL.hostname 会剥离方括号，如 [::1] → ::1
  // 对 IPv6 映射地址 ::ffff:127.0.0.1 同样进行精确匹配
  const host = parsed.hostname
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`安全限制：仅允许 localhost 请求，拒绝: ${host}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的协议: ${parsed.protocol}`)
  }

  return parsed
}

/** 读取响应体，截断到 MAX_RESPONSE_BYTES */
async function readBodyLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      totalBytes += value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        chunks.push(value.subarray(0, value.byteLength - (totalBytes - MAX_RESPONSE_BYTES)))
        reader.cancel()
        break
      }
      chunks.push(value)
    }
  }

  const merged = new Uint8Array(Math.min(totalBytes, MAX_RESPONSE_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(merged)
}

/** 过滤敏感 headers，不记录到返回值 */
function sanitizeHeaders(headers: Headers): Record<string, string> {
  const SENSITIVE = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key'])
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = SENSITIVE.has(key.toLowerCase()) ? '[REDACTED]' : value
  })
  return result
}

export function createHttpTools() {
  return {
    httpFetch: tool({
      description: `Send an HTTP request to a local service (localhost/127.0.0.1 only).
Useful for calling local REST APIs, health checks, or any HTTP endpoint running on the same machine.
External URLs are blocked for security. Response body is capped at 1 MB.`,
      inputSchema: z.object({
        url: z.string().describe('完整的 URL，例如 http://127.0.0.1:7899/api/v1/health'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('HTTP 方法，默认 GET'),
        headers: z.record(z.string(), z.string()).optional().describe('自定义请求头'),
        body: z.string().optional().describe('请求体（字符串）'),
        timeout: z.number().int().positive().optional().describe('超时毫秒数，默认 30000'),
      }),
      execute: async ({ url, method, headers, body, timeout }) => {
        const parsed = assertLocalhost(url)

        const controller = new AbortController()
        const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        try {
          const response = await fetch(parsed.toString(), {
            method: method ?? 'GET',
            headers: headers as Record<string, string> | undefined,
            body,
            signal: controller.signal,
          })

          const responseBody = await readBodyLimited(response)
          const responseHeaders = sanitizeHeaders(response.headers)

          return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: responseBody,
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          if (message.includes('abort')) {
            return { error: `请求超时 (${timeoutMs}ms)`, url: parsed.toString() }
          }
          return { error: message, url: parsed.toString() }
        } finally {
          clearTimeout(timer)
        }
      },
    }),

    httpFetchJson: tool({
      description: `Send an HTTP request to a local JSON API (localhost/127.0.0.1 only).
Automatically sets Content-Type to application/json and parses JSON responses.
Use this for structured API calls to local services like DSA (daily_stock_analysis).
External URLs are blocked for security. Response body is capped at 1 MB.`,
      inputSchema: z.object({
        url: z.string().describe('完整的 URL，例如 http://127.0.0.1:7899/api/v1/analysis/tasks'),
        method: z.enum(['GET', 'POST']).optional().describe('HTTP 方法，默认 GET'),
        body: z.record(z.string(), z.unknown()).optional().describe('JSON 请求体（对象）'),
        headers: z.record(z.string(), z.string()).optional().describe('额外请求头（Content-Type 已自动设置）'),
      }),
      execute: async ({ url, method, body, headers }) => {
        const parsed = assertLocalhost(url)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

        const mergedHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        }

        try {
          const response = await fetch(parsed.toString(), {
            method: method ?? 'GET',
            headers: mergedHeaders,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          })

          const rawBody = await readBodyLimited(response)

          let data: unknown
          try {
            data = JSON.parse(rawBody)
          } catch {
            return {
              status: response.status,
              statusText: response.statusText,
              error: 'JSON 解析失败',
              rawBody: rawBody.slice(0, 500),
            }
          }

          return {
            status: response.status,
            statusText: response.statusText,
            data,
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          if (message.includes('abort')) {
            return { error: `请求超时 (${DEFAULT_TIMEOUT_MS}ms)`, url: parsed.toString() }
          }
          return { error: message, url: parsed.toString() }
        } finally {
          clearTimeout(timer)
        }
      },
    }),
  }
}
