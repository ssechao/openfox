/**
 * Unified Agent Execution Loop
 *
 * Extracts the shared execution logic from runPlannerTurn, runBuilderTurn,
 * and executeSubAgent into reusable helpers.
 *
 * - executeToolBatch(): shared tool execution (used by all agent types)
 * - runTopLevelAgentLoop(): replaces duplicated planner/builder turns
 */

import type { InjectedFile, StatsIdentity, ToolCall, ToolMode, ToolResult } from '../../shared/types.js'
import type { ServerMessage } from '../../shared/protocol.js'
import type { LLMClientWithModel } from '../llm/client.js'
import { getModelProfile } from '../llm/profiles.js'
import type { LLMToolDefinition } from '../llm/types.js'
import type { ProviderManager } from '../provider-manager.js'
import type { SessionManager } from '../session/index.js'
import type { ToolRegistry } from '../tools/types.js'
import type { RequestContextMessage, MinimalMessage } from './request-context.js'
import type { RetryPatternConfig } from './auto-patterns.js'
import {
  streamLLMPure,
  consumeStreamGenerator,
  TurnMetrics,
  createMessageStartEvent,
  createMessageDoneEvent,
  createChatDoneEvent,
  evaluateLLMRetry,
  sleepThroughRetryBackoff,
  recordLLMFailure,
  clearLLMFailure,
} from './stream-pure.js'
import { getCurrentContextWindowId, getCurrentWindowMessageOptions } from '../events/index.js'
import { getAllInstructions } from '../context/instructions.js'
import { getEnabledSkillMetadata } from '../skills/registry.js'
import { getRuntimeConfig } from '../runtime-config.js'
import { getGlobalConfigDir } from '../../cli/paths.js'
import {
  createChatMessageUpdatedMessage,
  createChatDoneMessage,
  createChatLLMRetryMessage,
  createChatLLMRetryFailedMessage,
  createChatStatsMessage,
} from '../ws/protocol.js'
import { executeTools, type ToolBatchContext } from './execute-tools.js'
import {
  effectiveContextTokens,
  estimateMessagesTokens,
  estimatePromptTokensForSafety,
  isContextLengthError,
  isNonRetryableLLMError,
  isNonTransientHttpError,
} from './token-budget.js'
import { reduceHistoryForWindow } from './history-reduction.js'
import { settleUnpairedToolCalls } from './unpaired-tool-calls.js'
import { loadAllAgentsDefault, getSubAgents } from '../agents/registry.js'
import { createRetryLimiter, type RetryLimiter } from './retry-limiter.js'
import { drainQueue } from './drain-queue.js'
import { CONTINUE_PROMPT, CONTINUE_AFTER_STREAM_ERROR_PROMPT } from './prompts.js'
import { logger } from '../utils/logger.js'
import type { LLMRetryPolicy } from '../runner/types.js'
import { DEFAULT_LLM_RETRY_POLICY } from '../runner/types.js'
import { serverT } from '../i18n.js'
import { coalesceStreamEvents } from './coalesce-stream.js'

function emitPartialDoneEvents(
  _sessionId: string,
  assistantMsgId: string,
  statsIdentity: import('../../shared/types.js').StatsIdentity,
  mode: import('../../shared/types.js').ToolMode,
  turnMetrics: TurnMetrics,
  append: (event: import('../events/types.js').TurnEvent) => void,
  agentType?: 'sub-agent',
): void {
  const stats = turnMetrics.buildStats(statsIdentity, mode)
  append(
    createMessageDoneEvent(assistantMsgId, {
      stats,
      partial: true,
    }),
  )
  append(createChatDoneEvent(assistantMsgId, 'stopped', stats, agentType))
}

function emitDoneAndBreak(
  assistantMsgId: string,
  segments: import('../../shared/types.js').MessageSegment[] | undefined,
  statsIdentity: import('../../shared/types.js').StatsIdentity,
  mode: import('../../shared/types.js').ToolMode,
  turnMetrics: TurnMetrics,
  append: (event: import('../events/types.js').TurnEvent) => void,
  onMessage: ((msg: ServerMessage) => void) | undefined,
  reason: 'complete' | 'stopped' | 'error' | 'waiting_for_user' | 'truncated' | 'step_done',
  agentType?: 'sub-agent',
): void {
  const stats = turnMetrics.buildStats(statsIdentity, mode)
  append(
    createMessageDoneEvent(assistantMsgId, {
      ...(segments ? { segments } : {}),
      stats,
    }),
  )
  append(createChatDoneEvent(assistantMsgId, reason, stats, agentType))
  if (onMessage) {
    onMessage(
      createChatMessageUpdatedMessage(assistantMsgId, {
        isStreaming: false,
        stats,
      }),
    )
    onMessage(createChatDoneMessage(assistantMsgId, reason, stats, agentType))
  }
}

/**
 * Broadcast the cumulative turn stats to the client as an LLM call completes,
 * so the sidebar can render live numbers while the turn is still running.
 */
function emitLiveTurnStats(
  turnMetrics: TurnMetrics,
  statsIdentity: import('../../shared/types.js').StatsIdentity,
  mode: import('../../shared/types.js').ToolMode,
  onMessage: ((msg: ServerMessage) => void) | undefined,
): void {
  if (!onMessage) return
  onMessage(createChatStatsMessage(turnMetrics.buildStats(statsIdentity, mode)))
}

// ============================================================================
// Types
// ============================================================================

export interface TopLevelLoopConfig {
  mode: ToolMode
  retryPatterns?: RetryPatternConfig[]
  maxRetriesPerTurn?: number
  /** Function to append events (provided by orchestrator) */
  append: (event: import('../events/types.js').TurnEvent) => void
  sessionManager: SessionManager
  sessionId: string
  llmClient: LLMClientWithModel
  /** Re-resolve the LLM client for each attempt so a mid-turn provider switch
   *  (e.g. during retry backoff) takes effect on the next attempt. Falls back
   *  to `llmClient` when absent. */
  getLLMClient?: (() => LLMClientWithModel) | undefined
  statsIdentity: StatsIdentity
  providerManager?: ProviderManager | undefined
  /** Override model settings (e.g. for sub-agents with model override).
   *  When set, these are used instead of sessionManager.getCurrentModelSettings(). */
  modelSettings?: {
    temperature?: number
    topP?: number
    topK?: number
    maxTokens?: number
    supportsVision?: boolean
    chatTemplateKwargs?: Record<string, unknown>
    queryParams?: Record<string, unknown>
    omitParams?: string[]
  }
  signal?: AbortSignal | undefined
  onMessage?: ((msg: ServerMessage) => void) | undefined
  assembleRequest: (input: {
    workdir: string
    messages: RequestContextMessage[]
    injectedFiles: InjectedFile[]
    promptTools: LLMToolDefinition[]
    toolChoice: 'auto' | 'none' | 'required'
    customInstructions?: string
    skills?: import('../skills/types.js').SkillMetadata[]
  }) => Promise<{
    systemPrompt: string
    messages: MinimalMessage[]
    tools: LLMToolDefinition[]
  }>
  getToolRegistry: () => ToolRegistry
  onToolExecuted?: ((toolCall: ToolCall, result: ToolResult) => void) | undefined
  stopOnStepDone?: boolean
  injectKickoff?: (() => void | Promise<void>) | undefined
  /** Called after auto-compaction completes within the loop, before the next iteration.
   *  Reinjects the agent definition reminder into the new context window. */
  injectAgentReminder?: (() => void) | undefined
  /** Called after a compaction creates a new context window, so the fresh
   *  system prompt + tools become canonical for that window. */
  rebuildCachedContext?: (() => Promise<void> | void) | undefined
  /** When set, assistant messages are tagged with sub-agent metadata for scope isolation. */
  subAgentMetadata?: { subAgentId: string; subAgentType: string }
  /** When set and return_value tool is called, emit done events and break immediately. */
  breakOnReturnValue?: boolean
  /** When set, if the loop would normally break without return_value being called,
   *  inject a nudge and continue. Retries up to maxReturnValueNudges times.
   *  Prevents sub-agents from finishing without passing their result back. */
  requireReturnValue?: boolean
  /** Maximum number of return_value nudges before giving up. Default 10. */
  maxReturnValueNudges?: number
  /** Build conversation messages for the LLM, with image processing applied.
   *  Called each iteration to get fresh context. */
  getConversationMessages: () => Promise<RequestContextMessage[]>
  /** When true, the loop starts in compacting mode (used for manual compaction).
   *  After compaction completes, the loop breaks instead of continuing. */
  initialCompacting?: boolean
  /** When true, only warm up the LLM cache by sending system prompt + tools.
   *  Skips message creation, event emission, tool execution — just prefills the KV cache. */
  warmup?: boolean
  /** Overrides for the LLM-failure retry backoff policy (retried inside streamLLMPure). */
  llmRetryPolicy?: Partial<LLMRetryPolicy>
}

// ============================================================================
// Top-Level Agent Loop (replaces runPlannerTurn / runBuilderTurn)
// ============================================================================

const MAX_TRUNCATION_RETRIES = 3
/**
 * A context overflow buys exactly one output-budget halving. Halving shrinks
 * what the model may WRITE, which only helps when the output side is what tips
 * the request over; a second failure proves the INPUT is too big, and only
 * compaction can fix that.
 */
const MAX_OUTPUT_BUDGET_HALVINGS = 1
/** Guard against an endless shrink loop when reduction stops freeing anything. */
const MAX_HISTORY_REDUCTIONS = 3
const MAX_MALFORMED_TOOL_ATTEMPTS = 3
const OUTPUT_RESERVE_TOKENS = 2048
const COMPACTION_OUTPUT_TOKENS = 8192
const MIN_COMPACTION_OUTPUT_TOKENS = 1024

/**
 * Key identifying a Responses-API conversation chain. Built in exactly one
 * place: the request site and the compaction reset MUST agree, or the reset
 * silently no-ops and the next turn continues from a stale previous_response_id.
 */
export function responsesChainKeyFor(sessionId: string, subAgentType?: string): string {
  return `${sessionId}:${subAgentType ?? 'top'}`
}

export async function runTopLevelAgentLoop(
  config: TopLevelLoopConfig,
  turnMetrics: TurnMetrics,
): Promise<{ returnValueContent?: string; returnValueResult?: string; failed?: { error: string } }> {
  const { mode, sessionManager, sessionId, llmClient, signal, onMessage, statsIdentity } = config
  const append = config.append
  const agentType = config.subAgentMetadata ? ('sub-agent' as const) : undefined
  const chainKey = responsesChainKeyFor(sessionId, config.subAgentMetadata?.subAgentType)
  // Fresh per attempt when a resolver is provided (provider switch mid-turn).
  const resolveClient = () => config.getLLMClient?.() ?? llmClient

  const retryLimiter: RetryLimiter = createRetryLimiter(config.maxRetriesPerTurn ?? 10)
  let truncationRetryCount = 0
  let contextRetryCount = 0
  let historyReductionTarget: number | undefined
  let historyReductionAttempts = 0
  /** Reduction computed while deciding to retry — reused instead of redone. */
  let pendingReducedMessages: RequestContextMessage[] | undefined
  /** Last folded gauge; cleared whenever an event could have changed it. */
  let lastMeasuredState: ReturnType<SessionManager['getContextState']> | undefined
  /** Tool calls whose synthetic answer already cost the stored chain. */
  const chainInvalidatedForCalls = new Set<string>()
  let malformedToolAttempts = 0
  let pendingToolResultTokens = 0
  let returnValueContent: string | undefined
  let returnValueResult: string | undefined
  let currentMaxTokensOverride: number | undefined
  let lastPatternMatch: { pattern: string; field: string; matchedContent: string } | undefined
  let compacting = config.initialCompacting ?? false
  let preflightCompactionPending = !compacting
  let compactAfterTools = false
  let finalizingAfterStepDone = false
  let kickoffInjected = false
  let returnValueNudgeCount = 0
  /**
   * Drop the provider-side stored conversation for this turn.
   *
   * Any message injected OUTSIDE the plain assistant→tool→assistant flow makes
   * that stored context diverge from local history, and providers refuse the
   * mismatch: a native context still ending on an unconfirmed tool call rejects
   * the replay (409), and Claude-native tool output rejects a queued user
   * message (400). Dropping the chain turns the next request into a plain
   * full-history one, which is always accepted.
   */
  const invalidateStoredChain = () => {
    resolveClient().resetResponsesChain?.(chainKey)
  }
  const failLLM = (error: string, attempts: number) => {
    append({ type: 'chat.error', data: { error, recoverable: true } })
    if (!config.subAgentMetadata) {
      recordLLMFailure(sessionId)
      onMessage?.(createChatLLMRetryFailedMessage(error, attempts))
    }
    return { failed: { error } }
  }

  agentLoop: for (;;) {
    if (signal?.aborted) throw new Error('Aborted')

    // Warmup mode: just assemble the request to populate the cache, then fire a
    // minimal LLM call to prefill the KV cache. No events, no messages, no tools.
    if (config.warmup) {
      const session = sessionManager.requireSession(sessionId)
      const runtimeConfig = getRuntimeConfig()
      const configDir = getGlobalConfigDir(runtimeConfig.mode ?? 'production')
      const skills = await getEnabledSkillMetadata(configDir, sessionManager.getProjectWorkdir(sessionId))
      const { content: instructionContent } = await getAllInstructions(session.workdir, session.projectId)
      const toolRegistry = config.getToolRegistry()

      const assembledRequest = await config.assembleRequest({
        workdir: session.workdir,
        messages: [],
        injectedFiles: [],
        promptTools: toolRegistry.definitions,
        toolChoice: 'none',
        ...(instructionContent ? { customInstructions: instructionContent } : {}),
        ...(skills.length > 0 ? { skills } : {}),
      })

      const modelSettings = sessionManager.getCurrentModelSettings(sessionId, config.mode)

      await resolveClient().complete({
        sessionId,
        messages: [{ role: 'system', content: assembledRequest.systemPrompt }],
        tools: assembledRequest.tools,
        maxTokens: 1,
        temperature: 0,
        ...(modelSettings ? { modelSettings } : {}),
      })

      return {}
    }

    // Pause gate: block before the next LLM request if the user requested a
    // pause. The current (in-flight) request is never aborted — the pause only
    // takes effect here, at the request boundary.
    const pauseOutcome = await sessionManager.enterPauseGate(sessionId, signal)
    if (pauseOutcome === 'aborted') {
      throw new Error('Aborted')
    }

    const session = sessionManager.requireSession(sessionId)
    const runtimeConfig = getRuntimeConfig()

    // Reading the gauge folds the WHOLE event store, so it is read once per
    // iteration, shared with the budget computation below, and reused from the
    // measurement the previous iteration already took. Only a completed LLM
    // call (or a compaction, which clears the cache) moves these numbers —
    // tool events in between cannot, so re-folding for them is pure waste.
    const contextState = lastMeasuredState ?? sessionManager.getContextState(sessionId)
    lastMeasuredState = contextState
    const contextWindow = sessionManager.getCurrentModelContext(sessionId, config.mode)

    // Compaction gate, re-evaluated on EVERY iteration. Two readings of the
    // gauge are wrong here, and both end in a request the model refuses:
    //  - `currentTokens` is the last measurement REPORTED BY THE PROVIDER, so a
    //    tool result appended since is invisible to it. A single large result
    //    can therefore double the request while the gauge still reads "safe".
    //  - the window must be the one THIS request will use. A tracked window left
    //    over from a wider model turns 99% full into a harmless-looking 26%.
    if (!compacting) {
      if (contextState.currentTokensKnown !== false) preflightCompactionPending = false
      const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
      if (
        contextState.currentTokensKnown !== false &&
        contextState.canCompact &&
        shouldCompact(
          effectiveContextTokens(contextState, pendingToolResultTokens, () => contextState.currentTokens),
          contextWindow,
          sessionManager.getModelCompactionThreshold(sessionId, config.mode) ??
            runtimeConfig.context.compactionThreshold,
        )
      ) {
        appendCompactionPrompt(sessionId, append)
        invalidateStoredChain()
        compacting = true
      }
    }

    // Inject kickoff prompt (e.g., builder kickoff) on first iteration
    if (retryLimiter.count() === 0 && !kickoffInjected) {
      kickoffInjected = true
      await config.injectKickoff?.()
    }

    const { content: instructionContent, files } = await getAllInstructions(session.workdir, session.projectId)
    if (signal?.aborted) throw new Error('Aborted')

    const injectedFiles: InjectedFile[] = files.map((f) => ({
      path: f.path,
      content: f.content ?? '',
      source: f.source,
    }))

    const toolRegistry = config.getToolRegistry()
    const currentWindowMessageOptions = getCurrentWindowMessageOptions(sessionId)

    // ---- LLM round with automatic failure retry ----
    // Case 1: a request fails before any content → retry the same request with
    // exponential backoff; nothing is written (message.start deferred).
    // Case 2: the stream fails mid-flight → keep the partial content, finalize
    // its bubble, append ONE visible continuation prompt, then retry against
    // the enriched context. History only ever grows — no tombstones.
    const retryPolicy: LLMRetryPolicy = { ...DEFAULT_LLM_RETRY_POLICY, ...config.llmRetryPolicy }
    let requestFailures = 0
    let requestFirstFailureAt = 0
    let continuationAppended = false
    let previousContextTokens: number
    let result!: import('./stream-pure.js').PureStreamResult
    let assistantMsgId: string
    let assistantMessageStarted = false

    for (;;) {
      // Resolve fresh per attempt: resolveClient() supports provider switches
      // mid-turn (retries/truncation use a re-resolved client). The same client
      // backs the profile default (used by the maxTokens fallback sites below)
      // and the actual LLM call.
      const attemptClient = resolveClient()
      const profileDefaultMaxTokens = getModelProfile(attemptClient.getModel()).defaultMaxTokens

      let requestMessages = await config.getConversationMessages()

      // The format-retry continuation is appended once per round (not on
      // LLM-error retries) — its persisted copy feeds later context rebuilds.
      if (requestFailures === 0 && retryLimiter.count() > 0) {
        const continueMsgId = crypto.randomUUID()
        const continueContent = lastPatternMatch
          ? `Your previous response was interrupted because it matched pattern "${lastPatternMatch.pattern}" in ${lastPatternMatch.field}.\nMatched content:\n${lastPatternMatch.matchedContent}\n\n${CONTINUE_PROMPT}`
          : CONTINUE_PROMPT
        append(
          createMessageStartEvent(continueMsgId, 'user', continueContent, {
            ...(currentWindowMessageOptions ?? {}),
            isSystemGenerated: true,
            messageKind: 'correction',
          }),
        )
        append({ type: 'message.done', data: { messageId: continueMsgId } })
        requestMessages.push({ role: 'user', content: continueContent, source: 'history' })
      }

      // Close any tool call the history left hanging BEFORE the request goes
      // out. Every user message injected off the plain assistant → tool →
      // assistant path (continuation, compaction prompt, drained queue) can
      // otherwise land right behind an unanswered call, a shape providers
      // refuse outright. Settling is unconditional: cheap, idempotent, and the
      // only way the invariant holds for injection sites added later.
      const settlement = settleUnpairedToolCalls(requestMessages)
      if (settlement.settled > 0) {
        requestMessages = settlement.messages
        // The repair is request-only, so the same break is re-detected on every
        // rebuild. Dropping the stored chain each time would cost the session
        // its provider-side continuity for good — do it once per broken call.
        const unseen = settlement.settledCallIds.filter((id) => !chainInvalidatedForCalls.has(id))
        if (unseen.length > 0) {
          for (const id of unseen) chainInvalidatedForCalls.add(id)
          invalidateStoredChain()
        }
      }

      // Set only after a request was refused for being too large: resending the
      // identical history can only fail again, so the oldest raw tool results
      // are truncated until the request fits.
      if (historyReductionTarget !== undefined) {
        const reduction =
          pendingReducedMessages?.length === requestMessages.length
            ? { messages: pendingReducedMessages, truncated: 0 }
            : reduceHistoryForWindow(requestMessages, historyReductionTarget)
        requestMessages = reduction.messages
        pendingReducedMessages = undefined
        logger.info('Reduced history to fit the context window', {
          sessionId,
          targetTokens: historyReductionTarget,
          truncatedToolResults: reduction.truncated,
        })
      }

      const configDir = getGlobalConfigDir(runtimeConfig.mode ?? 'production')
      const skills = await getEnabledSkillMetadata(configDir, sessionManager.getProjectWorkdir(sessionId))
      if (signal?.aborted) throw new Error('Aborted')

      const requestToolChoice = compacting || finalizingAfterStepDone ? 'none' : 'auto'
      const assembledRequest = await config.assembleRequest({
        workdir: session.workdir,
        messages: requestMessages,
        injectedFiles,
        promptTools: compacting ? [] : toolRegistry.definitions,
        toolChoice: requestToolChoice,
        ...(instructionContent ? { customInstructions: instructionContent } : {}),
        ...(skills.length > 0 ? { skills } : {}),
      })

      const currentTokensForBudget =
        contextState.currentTokensKnown === false
          ? estimatePromptTokensForSafety(
              assembledRequest.systemPrompt,
              assembledRequest.messages,
              assembledRequest.tools,
            )
          : contextState.currentTokens
      if (!compacting && preflightCompactionPending) {
        preflightCompactionPending = false
        const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
        if (
          shouldCompact(
            currentTokensForBudget,
            contextWindow,
            sessionManager.getModelCompactionThreshold(sessionId, config.mode) ??
              runtimeConfig.context.compactionThreshold,
          )
        ) {
          appendCompactionPrompt(sessionId, append)
          invalidateStoredChain()
          compacting = true
          continue agentLoop
        }
      }

      assistantMsgId = crypto.randomUUID()
      // The assistant message.start is DEFERRED until the first streamed event:
      // a request that fails before any content (case 1) leaves nothing behind.
      assistantMessageStarted = false
      const ensureAssistantMessage = () => {
        if (assistantMessageStarted) return
        assistantMessageStarted = true
        append(
          createMessageStartEvent(assistantMsgId, 'assistant', undefined, {
            ...(currentWindowMessageOptions ?? {}),
            ...(config.subAgentMetadata
              ? { subAgentId: config.subAgentMetadata.subAgentId, subAgentType: config.subAgentMetadata.subAgentType }
              : {}),
          }),
        )
      }

      previousContextTokens = currentTokensForBudget

      let availableForOutput = Math.max(
        256,
        contextWindow - currentTokensForBudget - pendingToolResultTokens - OUTPUT_RESERVE_TOKENS,
      )

      let modelSettings = config.modelSettings ?? sessionManager.getCurrentModelSettings(sessionId, config.mode)
      if (modelSettings && currentMaxTokensOverride !== undefined) {
        modelSettings = { ...modelSettings, maxTokens: currentMaxTokensOverride }
      }

      if (modelSettings) {
        const requestedMaxTokens = modelSettings.maxTokens ?? profileDefaultMaxTokens
        modelSettings = { ...modelSettings, maxTokens: Math.min(requestedMaxTokens, availableForOutput) }
      }

      if (compacting) {
        // A session with no headroom left is exactly the one that needs a
        // summary most — refusing here leaves the user with no way out. Free
        // room instead of giving up, and only fail when nothing can be freed.
        if (availableForOutput < MIN_COMPACTION_OUTPUT_TOKENS) {
          const reductionTarget = Math.max(
            MIN_COMPACTION_OUTPUT_TOKENS,
            contextWindow - COMPACTION_OUTPUT_TOKENS - OUTPUT_RESERVE_TOKENS,
          )
          const reduction = reduceHistoryForWindow(requestMessages, reductionTarget)
          if (historyReductionAttempts < MAX_HISTORY_REDUCTIONS && reduction.changed) {
            historyReductionAttempts += 1
            historyReductionTarget = reductionTarget
            pendingReducedMessages = reduction.messages
            continue
          }
          // Nothing left to shrink: fall back to what we are ACTUALLY about to
          // send. The gauge measures a history the summary request no longer
          // carries, so it can forbid a request that would fit comfortably.
          const assembledHeadroom =
            contextWindow -
            estimatePromptTokensForSafety(
              assembledRequest.systemPrompt,
              assembledRequest.messages,
              assembledRequest.tools,
            ) -
            OUTPUT_RESERVE_TOKENS
          if (assembledHeadroom < MIN_COMPACTION_OUTPUT_TOKENS) {
            return failLLM(
              serverT({
                en: 'Not enough context headroom to summarize safely. History was preserved; compact earlier or reduce the input.',
                fr: 'Marge de contexte insuffisante pour résumer correctement. Historique conservé ; compactez plus tôt ou réduisez les entrées.',
              }),
              0,
            )
          }
          availableForOutput = assembledHeadroom
        }
        modelSettings = { ...modelSettings, maxTokens: Math.min(COMPACTION_OUTPUT_TOKENS, availableForOutput) }
      }

      // Build set of sub-agent IDs so streamLLMPure can show the correct
      // tool name in preparing events instead of hallucinated aliases.
      const allAgents = await loadAllAgentsDefault(sessionManager.getProjectWorkdir(sessionId))
      const subAgentAliases = new Set(getSubAgents(allAgents).map((a) => a.metadata.id))

      const attemptAbort = new AbortController()
      const streamGen = streamLLMPure({
        messageId: assistantMsgId,
        systemPrompt: assembledRequest.systemPrompt,
        llmClient: attemptClient,
        sessionId,
        messages: assembledRequest.messages,
        tools: compacting ? [] : assembledRequest.tools,
        toolChoice: requestToolChoice,
        ...(compacting && /^(claude-|gpt-)/i.test(attemptClient.getModel()) ? { reasoningEffort: 'low' as const } : {}),
        signal: signal ? AbortSignal.any([signal, attemptAbort.signal]) : attemptAbort.signal,
        subAgentAliases,
        responsesChainKey: chainKey,
        ...(config.retryPatterns ? { retryPatterns: config.retryPatterns } : {}),
        ...(modelSettings && { modelSettings }),
      })

      const bufferedStream = coalesceStreamEvents(streamGen)
      let attemptResult
      try {
        attemptResult = await consumeStreamGenerator(bufferedStream, (event) => {
          ensureAssistantMessage()
          append(event)
        })
      } catch (error) {
        // A callback can fail while the coalescer has an outstanding read.
        // Abort that read before closing the iterator, otherwise return() waits
        // indefinitely behind it and the producer outlives the turn.
        attemptAbort.abort()
        await bufferedStream.return(undefined as never)
        throw error
      }

      if (!attemptResult.error) {
        // The request went through: later turns start from the full history
        // again, any reduction applied here was a one-off rescue. The budget
        // resets with it — a turn that spent its rescues early must still be
        // able to survive a genuine overflow fifty iterations later.
        historyReductionTarget = undefined
        historyReductionAttempts = 0
        pendingReducedMessages = undefined
        result = attemptResult
        break
      }

      // ---- LLM failure ----
      // Deterministic failures: a Responses turn that produced no actionable
      // output, or a non-transient 4xx that would just re-hit the same wall.
      // Context-length errors are excluded — they retry with a smaller budget.
      const overflowed = isContextLengthError(attemptResult.error)
      const failWithoutRetry =
        !overflowed &&
        (compacting || isNonRetryableLLMError(attemptResult.error) || isNonTransientHttpError(attemptResult.error))
      // Case 2: content was streamed → finalize the partial bubble. When the
      // failure is retryable, append ONE visible continuation prompt so the
      // retry rebuilds context from the partial response. A deterministic
      // failure stops here without injecting a prompt that will never be sent.
      if (assistantMessageStarted && !continuationAppended) {
        append(createMessageDoneEvent(assistantMsgId, { partial: true }))
        onMessage?.(createChatMessageUpdatedMessage(assistantMsgId, { isStreaming: false, partial: true }))
        if (!failWithoutRetry) {
          const continueMsgId = crypto.randomUUID()
          append(
            createMessageStartEvent(continueMsgId, 'user', CONTINUE_AFTER_STREAM_ERROR_PROMPT, {
              ...(currentWindowMessageOptions ?? {}),
              isSystemGenerated: true,
              messageKind: 'correction',
            }),
          )
          append({ type: 'message.done', data: { messageId: continueMsgId } })
          invalidateStoredChain()
          continuationAppended = true
        }
      }

      if (signal?.aborted) throw new Error('Aborted')

      // Context overflow: the prompt (including tool results) plus the requested
      // maxTokens exceeds the model's window. The error is deterministic, so
      // handle it immediately instead of waiting out backoff.
      if (overflowed) {
        // The output budget gets ONE halving: it is the only part of the
        // request we can shrink without touching history.
        if (!compacting && contextRetryCount < MAX_OUTPUT_BUDGET_HALVINGS) {
          contextRetryCount += 1
          const currentMax = modelSettings?.maxTokens ?? currentMaxTokensOverride ?? profileDefaultMaxTokens
          currentMaxTokensOverride = Math.max(256, Math.floor(currentMax / 2))
          continue
        }
        // Still refused: the INPUT is what does not fit, and no output budget
        // can fix that. Summarize instead of burning the remaining retries.
        if (!compacting) {
          const { appendCompactionPrompt } = await import('../context/compactor.js')
          appendCompactionPrompt(sessionId, append)
          invalidateStoredChain()
          compacting = true
          contextRetryCount = 0
          currentMaxTokensOverride = undefined
          continue agentLoop
        }
        // Already summarizing: the summary request itself is too large, so it
        // has to be rebuilt on a smaller history — resending it verbatim would
        // hit the exact same wall.
        const reductionTarget = Math.floor(estimateMessagesTokens(requestMessages) / 2)
        const reduction = reduceHistoryForWindow(requestMessages, reductionTarget)
        if (historyReductionAttempts < MAX_HISTORY_REDUCTIONS && reduction.changed) {
          historyReductionAttempts += 1
          historyReductionTarget = reductionTarget
          pendingReducedMessages = reduction.messages
          continue
        }
        // Nothing left to shrink. The raw provider string is jargon to the
        // user, so keep it for the logs and say what can actually be done.
        logger.error('Compaction request still exceeds the context window', {
          sessionId,
          error: attemptResult.error,
        })
        return failLLM(
          serverT({
            en: 'This conversation is too large to summarize, even after shrinking it. History was preserved — start a new session to continue.',
            fr: 'Cette conversation est trop volumineuse pour être résumée, même après réduction. Historique conservé — démarrez une nouvelle session pour continuer.',
          }),
          1,
        )
      }

      // Deterministic request failures cannot succeed on an automatic retry —
      // a Responses backend that completed without answer text or a tool call
      // is the first such case. Fail immediately instead of burning the retry
      // window (transient 429/5xx/network errors keep the backoff policy).
      if (failWithoutRetry) {
        return failLLM(attemptResult.error, 1)
      }

      // Backoff decision — the shared LLMRetryPolicy (same defaults as workflows).
      requestFailures += 1
      if (requestFirstFailureAt === 0) {
        requestFirstFailureAt = Date.now()
      }
      const decision = evaluateLLMRetry(requestFailures, requestFirstFailureAt, Date.now(), retryPolicy)
      if (!decision.retry) {
        return failLLM(attemptResult.error, requestFailures)
      }
      if (!config.subAgentMetadata) {
        config.onMessage?.(createChatLLMRetryMessage(decision.attempt, decision.delayMs, attemptResult.error))
      }
      const waitResult = await sleepThroughRetryBackoff(decision.delayMs, sessionId, signal)
      if (waitResult === 'aborted') throw new Error('Aborted')
      // Loop: rebuild the request — case 1 uses the same context, case 2 picks
      // up the persisted partial + continuation.
    }

    if (
      compacting &&
      (result.patternMatch || result.finishReason !== 'stop' || result.toolCalls.length > 0 || !result.content?.trim())
    ) {
      if (assistantMessageStarted) append(createMessageDoneEvent(assistantMsgId, { partial: true }))
      return failLLM(
        serverT({
          en: 'Compaction did not produce a complete text summary. History was preserved; no automatic retry.',
          fr: 'La compaction n’a pas produit de résumé textuel complet. Historique conservé ; aucune relance automatique.',
        }),
        1,
      )
    }

    // Success — clear any recorded failure so a later chat.retry is rejected.
    if (!config.subAgentMetadata) {
      clearLLMFailure(sessionId)
    }

    // Check if a retry pattern matched mid-stream
    if (result.patternMatch) {
      if (!retryLimiter.canRetry()) {
        append({
          type: 'chat.error',
          data: {
            error: serverT(
              {
                en: 'Auto-retry limit exceeded after {{count}} retries',
                fr: 'Limite de relance automatique dépassée après {{count}} tentatives',
              },
              { count: retryLimiter.maxRetries() },
            ),
            recoverable: false,
          },
        })
        append(createChatDoneEvent(assistantMsgId, 'error', undefined, agentType))
        throw new Error('Auto-retry limit exceeded')
      }
      retryLimiter.increment()
      lastPatternMatch = {
        pattern: result.patternMatch.pattern,
        field: result.patternMatch.field,
        matchedContent: result.patternMatch.matchedContent,
      }

      // Emit pattern.retry event
      append({
        type: 'pattern.retry',
        data: {
          messageId: assistantMsgId,
          pattern: result.patternMatch.pattern,
          field: result.patternMatch.field,
          attempt: retryLimiter.count(),
          maxAttempts: retryLimiter.maxRetries(),
          matchedContent: result.patternMatch.matchedContent,
        },
      })

      // Emit system message showing what matched
      const matchMsgId = crypto.randomUUID()
      const matchMessage = `Pattern "${result.patternMatch.pattern}" matched — auto-retry #${retryLimiter.count()}`
      append(
        createMessageStartEvent(matchMsgId, 'user', matchMessage, {
          ...(currentWindowMessageOptions ?? {}),
          isSystemGenerated: true,
          messageKind: 'correction',
        }),
      )
      append({ type: 'message.done', data: { messageId: matchMsgId } })

      continue
    }

    if (result.aborted) {
      // Only finalize if the assistant message was actually started (a turn
      // aborted during the backoff wait never created one).
      if (assistantMessageStarted) {
        emitPartialDoneEvents(sessionId, assistantMsgId, statsIdentity, mode, turnMetrics, append, agentType)
      }
      throw new Error('Aborted')
    }

    // The retry loop above guarantees `result` has no error — record usage and
    // update the context size.
    turnMetrics.addLLMCall(
      result.timing,
      result.usage.promptTokens,
      result.usage.completionTokens,
      previousContextTokens,
      result.modelParams,
    )
    // Stream the running turn totals to the client so the sidebar can build
    // dynamically as each LLM call completes. Sub-agent turns run inside the
    // parent turn — their stats would clobber the parent's live numbers, so
    // only top-level turns broadcast.
    if (!config.subAgentMetadata) {
      emitLiveTurnStats(turnMetrics, statsIdentity, mode, config.onMessage)
    }
    sessionManager.setCurrentContextSize(
      sessionId,
      result.usage.promptTokens,
      result.usage.completionTokens,
      config.subAgentMetadata?.subAgentId,
      config.mode,
    )
    pendingToolResultTokens = 0
    currentMaxTokensOverride = undefined

    // Check compaction threshold with fresh promptTokens from LLM.
    // When exceeded, append compaction prompt and let the next iteration
    // handle summarization — same agent, same loop, no nested call.
    if (!compacting) {
      // Re-read: the call above recorded a fresh measurement. The window stays
      // the one resolved for this turn (see the gate at the top of the loop).
      const measuredState = sessionManager.getContextState(sessionId)
      lastMeasuredState = measuredState
      const { shouldCompact, appendCompactionPrompt } = await import('../context/compactor.js')
      if (
        compactAfterTools ||
        shouldCompact(
          effectiveContextTokens(measuredState, pendingToolResultTokens, () => measuredState.currentTokens),
          contextWindow,
          sessionManager.getModelCompactionThreshold(sessionId, config.mode) ??
            runtimeConfig.context.compactionThreshold,
        )
      ) {
        if (result.toolCalls.length > 0) {
          compactAfterTools = true
        } else {
          appendCompactionPrompt(sessionId, append)
          invalidateStoredChain()
          compacting = true
          compactAfterTools = false
          continue
        }
      }
    }

    if (!compacting && result.finishReason === 'length' && result.toolCalls.length === 0) {
      if (truncationRetryCount < MAX_TRUNCATION_RETRIES) {
        truncationRetryCount += 1
        const currentMaxTokens =
          result.modelParams?.maxTokens ?? getModelProfile(resolveClient().getModel()).defaultMaxTokens
        const promptTokens = result.usage.promptTokens
        const newMaxTokens = Math.min(
          Math.floor(currentMaxTokens * 1.5),
          Math.max(256, contextWindow - promptTokens - OUTPUT_RESERVE_TOKENS),
        )
        currentMaxTokensOverride = newMaxTokens
        // Finalize the truncated assistant message so the frontend properly closes it
        const interimStats = turnMetrics.buildStats(statsIdentity, mode)
        append(
          createMessageDoneEvent(assistantMsgId, {
            segments: result.segments,
            stats: interimStats,
          }),
        )
        // Tell the frontend to fold the streaming message back into messages
        onMessage?.(createChatMessageUpdatedMessage(assistantMsgId, { isStreaming: false }))
        // Emit continue message to event store so getConversationMessages picks it up next iteration
        // We don't broadcast it via WebSocket, so the frontend won't see it
        const continueMsgId = crypto.randomUUID()
        append(
          createMessageStartEvent(
            continueMsgId,
            'user',
            'Continue your previous response exactly where you left off.',
            {
              ...(currentWindowMessageOptions ?? {}),
              isSystemGenerated: true,
            },
          ),
        )
        append({ type: 'message.done', data: { messageId: continueMsgId } })
        continue
      } else {
        // Exhausted retries, emit truncated
        const stats = turnMetrics.buildStats(statsIdentity, mode)
        append(
          createMessageDoneEvent(assistantMsgId, {
            segments: result.segments,
            stats,
            partial: true,
          }),
        )
        append(createChatDoneEvent(assistantMsgId, 'truncated', stats, agentType))
        break
      }
    }

    // Tool arguments whose JSON never closed are a CUT-OFF response, not a
    // formatting fault: the model wrote valid JSON and ran out of budget. The
    // cure is a bigger output budget — treating it as a format error instead
    // stops the session after three strikes while the budget never moves. The
    // call is still executed so its error result settles the tool_call pair.
    //
    // The exemption lasts EXACTLY as long as the budget can still grow: once
    // the truncation retries are spent, a response that keeps coming back cut
    // off has to fall through to the malformed-tool valve. Nothing else caps
    // this loop, so an unconditional exemption would burn tokens forever.
    const truncatedToolCall =
      !compacting &&
      result.finishReason === 'length' &&
      result.toolCalls.length > 0 &&
      result.toolCalls.every((call) => call.parseError) &&
      truncationRetryCount < MAX_TRUNCATION_RETRIES
    if (truncatedToolCall) {
      truncationRetryCount += 1
      const currentMaxTokens =
        result.modelParams?.maxTokens ?? getModelProfile(resolveClient().getModel()).defaultMaxTokens
      currentMaxTokensOverride = Math.min(
        Math.floor(currentMaxTokens * 1.5),
        Math.max(256, contextWindow - result.usage.promptTokens - OUTPUT_RESERVE_TOKENS),
      )
    }

    if (result.toolCalls.length > 0) {
      append(
        createMessageDoneEvent(assistantMsgId, {
          segments: result.segments,
        }),
      )

      try {
        const batchContext: ToolBatchContext = {
          toolRegistry,
          sessionManager,
          sessionId,
          workdir: sessionManager.getEffectiveWorkdir(sessionId),
          turnMetrics,
          signal,
          onMessage,
          llmClient: resolveClient(),
          statsIdentity,
          onToolExecuted: config.onToolExecuted,
        }
        if (session.dangerLevel) {
          batchContext.dangerLevel = session.dangerLevel
        }
        if (config.subAgentMetadata) {
          batchContext.isSubAgent = true
        }
        if (config.providerManager) {
          batchContext.providerManager = config.providerManager
        }
        batchContext.agentTimeout = getRuntimeConfig().agent.toolTimeout
        const batchResult = await executeTools(assistantMsgId, result.toolCalls, batchContext, append)
        pendingToolResultTokens = estimateMessagesTokens(batchResult.toolMessages)
        // Invalid JSON must never become an unbounded model/tool recovery loop.
        // Keep the failed tool results in history, allowing two correction turns.
        malformedToolAttempts =
          !truncatedToolCall && result.toolCalls.some((call) => call.parseError) ? malformedToolAttempts + 1 : 0
        if (malformedToolAttempts >= MAX_MALFORMED_TOOL_ATTEMPTS) {
          const error = serverT({
            en: 'Stopped after three consecutive responses with malformed tool arguments. You can resume this session.',
            fr: 'Arrêt après trois réponses consécutives avec des arguments d’outil invalides. Vous pouvez reprendre cette session.',
          })
          append(createChatDoneEvent(assistantMsgId, 'error', undefined, agentType))
          return failLLM(error, malformedToolAttempts)
        }
        if (batchResult.stepDoneCalled) {
          if (config.stopOnStepDone) {
            emitDoneAndBreak(
              assistantMsgId,
              result.segments,
              statsIdentity,
              mode,
              turnMetrics,
              append,
              onMessage,
              'step_done',
              agentType,
            )
            break
          }
          finalizingAfterStepDone = true
          retryLimiter.reset()
          continue
        }
        if (batchResult.returnValueContent) {
          returnValueContent = batchResult.returnValueContent
          returnValueResult = batchResult.returnValueResult
          if (config.breakOnReturnValue) {
            emitDoneAndBreak(
              assistantMsgId,
              result.segments,
              statsIdentity,
              mode,
              turnMetrics,
              append,
              onMessage,
              'complete',
              agentType,
            )
            break
          }
        }
        if (batchResult.returnValueResult) {
          returnValueResult = batchResult.returnValueResult
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Aborted') {
          emitPartialDoneEvents(sessionId, assistantMsgId, statsIdentity, mode, turnMetrics, append, agentType)
          throw error
        }
        throw error
      }

      if (signal?.aborted) {
        emitPartialDoneEvents(sessionId, assistantMsgId, statsIdentity, mode, turnMetrics, append, agentType)
        throw new Error('Aborted')
      }

      if (!config.subAgentMetadata) {
        const drained = drainQueue(sessionManager, sessionId, append, onMessage)
        if (drained.hasMessages) invalidateStoredChain()
      }

      retryLimiter.reset()
      continue
    }

    if (compacting) {
      const summary = result.content.trim()

      // The new context window starts fresh — apply the current system prompt
      // + tools so they are canonical and never stale there. Best-effort: a
      // rebuild failure must not break the compaction itself.
      try {
        await config.rebuildCachedContext?.()
      } catch (error) {
        logger.error('Failed to rebuild cached context after compaction', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }

      // Compaction rewrites the context, so the stored Responses-API conversation no
      // longer matches the local history — invalidate the chain so the next request
      // re-primes from the (post-compaction) history as a first request.
      resolveClient().resetResponsesChain?.(chainKey)

      const closedWindowId = getCurrentContextWindowId(sessionId) ?? ''
      const newWindowId = crypto.randomUUID()
      const tokenCountAtClose = result.usage.promptTokens

      append({
        type: 'context.compacted',
        data: { closedWindowId, newWindowId, beforeTokens: tokenCountAtClose, afterTokens: 0, summary },
      })

      append({
        type: 'message.start',
        data: {
          messageId: assistantMsgId,
          role: 'assistant',
          content: summary,
          contextWindowId: newWindowId,
          isCompactionSummary: true,
        },
      })
      append(createMessageDoneEvent(assistantMsgId, { stats: turnMetrics.buildStats(statsIdentity, mode) }))
      append(createChatDoneEvent(assistantMsgId, 'complete', undefined, agentType))

      // Reinject the agent reminder into the new window
      config.injectAgentReminder?.()
      compacting = false
      // context.compacted rewrote the window: the cached gauge is meaningless.
      lastMeasuredState = undefined

      // Manual compaction (initialCompacting) is a one-shot operation — break after done.
      // Auto-compaction continues the loop for subsequent user messages.
      if (config.initialCompacting) break
      continue
    }

    // If sub-agent finished without calling return_value, nudge and retry
    if (config.requireReturnValue && !returnValueContent) {
      const maxNudges = config.maxReturnValueNudges ?? 10
      if (returnValueNudgeCount < maxNudges) {
        returnValueNudgeCount++
        const nudgeMsgId = crypto.randomUUID()
        append(
          createMessageStartEvent(
            nudgeMsgId,
            'user',
            'You must call return_value with a summary of your findings before finishing. Call return_value now.',
            {
              ...(currentWindowMessageOptions ?? {}),
              isSystemGenerated: true,
              messageKind: 'correction',
              ...(config.subAgentMetadata
                ? { subAgentId: config.subAgentMetadata.subAgentId, subAgentType: config.subAgentMetadata.subAgentType }
                : {}),
            },
          ),
        )
        append({ type: 'message.done', data: { messageId: nudgeMsgId } })
        continue
      }
    }

    const stats = turnMetrics.buildStats(statsIdentity, mode)
    append(
      createMessageDoneEvent(assistantMsgId, {
        segments: result.segments,
        stats,
      }),
    )
    append(createChatDoneEvent(assistantMsgId, finalizingAfterStepDone ? 'step_done' : 'complete', stats, agentType))

    break
  }

  return {
    ...(returnValueContent ? { returnValueContent } : {}),
    ...(returnValueResult ? { returnValueResult } : {}),
  }
}

export { CONTINUE_PROMPT, CONTINUE_AFTER_STREAM_ERROR_PROMPT } from './prompts.js'
