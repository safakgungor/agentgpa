/** The agent tools AgentGPA reads. */
export type Tool = 'claude-code' | 'codex' | 'cursor';

export const TOOLS: readonly Tool[] = ['claude-code', 'codex', 'cursor'];

/** Tool call categories, the same list the event skeleton uses. */
export type ToolCategory =
  | 'Bash'
  | 'Edit'
  | 'Write'
  | 'Read'
  | 'Search'
  | 'Web'
  | 'Task'
  | 'MCP'
  | 'Todo'
  | 'Notebook'
  | 'Other';

/** Flag bits on tool calls, decided from a shell command on the device. */
export const TOOL_FLAGS = {
  gitCommit: 1,
  prCreate: 2,
  test: 4,
  build: 8,
  deploy: 16,
  install: 2048,
  lint: 4096,
} as const;

/**
 * `approx` marks an event whose own time is unknown: it carries its session's start time
 * (Cursor agent transcripts have no timestamps). Text fields stay on the device.
 */
export interface PromptEvent {
  kind: 'user_prompt';
  ts: number;
  text: string;
  images: number;
  queued?: true;
  approx?: true;
}

export interface ReplyEvent {
  kind: 'assistant_text';
  ts: number;
  text: string;
  model?: string;
  approx?: true;
}

export interface ToolCallEvent {
  kind: 'tool_call';
  ts: number;
  name: string;
  category: ToolCategory;
  sidechain: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  flags?: number;
  error?: true;
  declined?: true;
  approx?: true;
  /** A test command's result, read from its output on the device. */
  testResult?: 'pass' | 'fail';
  /** The language category of the edited file (`LANG_CATEGORIES`), from its extension. */
  langCat?: number;
  /** The call read or named an env, key or credential file. */
  sensitive?: true;
}

export interface InterruptEvent {
  kind: 'interrupt';
  ts: number;
}

/** One model reply's token usage. Replies from subagents are `sidechain`. */
export interface UsageEvent {
  kind: 'usage';
  ts: number;
  model?: string;
  sidechain: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type Event = PromptEvent | ReplyEvent | ToolCallEvent | InterruptEvent | UsageEvent;

export interface Session {
  tool: Tool;
  id: string;
  /** A hash of the project path, never the path itself. */
  projectKey: string;
  /**
   * The project folder's name, kept in memory so redaction can take it out of quotes and the
   * deep read's prompts. It never reaches the skeleton or the payload; the deep read packet
   * carries it only as `projectLabel` makes it.
   */
  projectName?: string;
  startedAt: number;
  endedAt: number;
  models: string[];
  usedPlanMode: boolean;
  /** The tool's version at the session's first event, where the tool records one. */
  version?: string;
  /** Cursor's data format version for the chat (`_v`), not an app version. */
  formatVersion?: number;
  entrypoint?: string;
  /** Permission or sandbox modes seen on prompts and turns, by mode name. */
  permissionModes: Record<string, number>;
  compactions: number;
  /** Slash commands: built-in names count by name, everything else as `custom`. */
  commands: Record<string, number>;
  subagents: number;
  /** Provider message ids, for duplicate detection. */
  messageIds: string[];
  /** Ordered by time. */
  events: Event[];
}

/** What a parser counted. Numbers and names from fixed lists only, so it can be printed. */
export interface ParseStats {
  lines: number;
  malformed: number;
  oversized: number;
  duplicates: number;
  /** Line or record kinds seen, by kind name. */
  kinds: Record<string, number>;
  /** Messages that look like prompts but are not, by reason. */
  notPrompts: Record<string, number>;
}

export interface ParseResult {
  sessions: Session[];
  stats: ParseStats;
}

export interface ParserOptions {
  /** A one-way hash for project paths (SHA-256 hex in the CLI). */
  hash: (text: string) => string;
  /**
   * Sees each tool output while its line is parsed, for the secret scan; the text is never kept
   * on a session.
   */
  onToolOutput?: (text: string, ts: number, category: ToolCategory | undefined) => void;
}
