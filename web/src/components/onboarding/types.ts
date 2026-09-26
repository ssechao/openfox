import type { Backend } from '../../stores/config'
export { getBackendDisplayName } from '../../stores/config'

export interface ProviderInfo {
  id: string
  name: string
  url: string
  backend: Backend
  model: string | null
  apiKey?: string
  isLocal?: boolean
  thinkingField?: string
  sendReasoningInMessages?: boolean
  authAdapter?: string
  transportAdapter?: string
  credentialRef?: string
  preset?: string
  logo?: string
  icon?: string
  models?: Array<{
    id: string
    contextWindow: number
    supportsVision?: boolean
    thinkingEnabled?: boolean
    thinkingLevel?: string
    nonThinkingEnabled?: boolean
  }>
}
