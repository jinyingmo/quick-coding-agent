/** 中文说明：鉴权模块。 */

import { resolve } from 'path'

export type ApiKeyIdentity = {
  token: string
  userId: string
  workspaceId: string
  cwd: string
  memoryDir: string
}

/** 从环境变量 P0_API_KEYS 解析 API Key 身份列表。 */
export function loadApiKeyIdentitiesFromEnv(): ApiKeyIdentity[] {
  const raw = process.env.P0_API_KEYS?.trim()
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('P0_API_KEYS must be a JSON array')
  }

  return parsed.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`P0_API_KEYS[${idx}] must be an object`)
    }
    const obj = item as Record<string, unknown>
    for (const key of ['token', 'userId', 'workspaceId', 'cwd', 'memoryDir']) {
      if (typeof obj[key] !== 'string' || obj[key]!.length === 0) {
        throw new Error(`P0_API_KEYS[${idx}] missing non-empty ${key}`)
      }
    }
    return {
      token: obj.token as string,
      userId: obj.userId as string,
      workspaceId: obj.workspaceId as string,
      cwd: resolve(obj.cwd as string),
      memoryDir: resolve(obj.memoryDir as string),
    }
  })
}

/** 根据 HTTP Authorization Bearer Token 查找对应的 API Key 身份。 */
export function findIdentityByBearerToken(
  authHeader: string | undefined,
  identities: ApiKeyIdentity[],
): ApiKeyIdentity | undefined {
  if (!authHeader) return undefined
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return undefined
  const token = match[1]?.trim()
  if (!token) return undefined
  return identities.find(identity => identity.token === token)
}
