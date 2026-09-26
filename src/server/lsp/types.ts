import type { Diagnostic } from '../../shared/types.js'
import type { CodeLocation, SymbolInfo, HoverInfo } from './server.js'

// ============================================================================
// Language Configuration
// ============================================================================

export interface LanguageConfig {
  id: string
  name: string
  extensions: string[]
  serverCommand: string
  serverArgs: string[]
  rootPatterns: string[] // Files that indicate project root for this language
  initOptions?: Record<string, unknown>
  /** Map file extension to LSP languageId (e.g., '.tsx' -> 'typescriptreact') */
  languageIds?: Record<string, string>
  /** Installation hint shown to users when the server is not found on PATH */
  installHint?: string
}

// ============================================================================
// LSP Server State
// ============================================================================

export type LspServerState = 'stopped' | 'starting' | 'running' | 'error'

export interface LspServerStatus {
  state: LspServerState
  language: string
  pid?: number
  error?: string
}

// ============================================================================
// Diagnostic Collection
// ============================================================================

export interface DiagnosticCollection {
  path: string
  diagnostics: Diagnostic[]
  timestamp: number
}

// ============================================================================
// LSP Manager Interface
// ============================================================================

export interface LspManagerInterface {
  /**
   * Notify the LSP that a file has changed and get diagnostics
   * Returns diagnostics for the file (may be empty if no issues)
   *
   * When `awaitDiagnostics` is false, the document change is still pushed to
   * the language server (so a later wait returns fresh diagnostics) but the
   * call resolves immediately without blocking on the server round-trip.
   */
  notifyFileChange(path: string, content: string, awaitDiagnostics?: boolean): Promise<Diagnostic[]>

  /**
   * Get current diagnostics for a file without triggering a change
   */
  getDiagnostics(path: string): Diagnostic[]

  /**
   * Check if LSP is available for a given file
   */
  isAvailableFor(path: string): boolean

  /**
   * Get installation hint for a file's language server, if it's not installed
   */
  getInstallHint(path: string): string | null

  /**
   * Find the definition of a symbol at the given position
   */
  getDefinition(path: string, line: number, character: number): Promise<CodeLocation[]>

  /**
   * Find all references to a symbol at the given position
   */
  getReferences(path: string, line: number, character: number): Promise<CodeLocation[]>

  /**
   * Find the type definition of a symbol at the given position
   */
  getTypeDefinition(path: string, line: number, character: number): Promise<CodeLocation[]>

  /**
   * Search workspace for a symbol by name
   */
  findWorkspaceSymbol(query: string): Promise<SymbolInfo[]>

  /**
   * Open a file to seed the LSP server, then search for a workspace symbol.
   * Some LSP servers (e.g., typescript-language-server) only index projects
   * after a file is opened via textDocument/didOpen. This method handles
   * that by opening the given file first, flushing the notification queue,
   * then querying workspace/symbol.
   */
  seedAndFindWorkspaceSymbol(query: string, filePath: string): Promise<SymbolInfo[]>

  /**
   * Get hover information for a symbol at the given position
   */
  getHoverInfo(path: string, line: number, character: number): Promise<HoverInfo | null>

  /**
   * Shutdown all LSP servers
   */
  shutdown(): Promise<void>
}
