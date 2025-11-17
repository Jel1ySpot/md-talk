export interface SessionSummary {
  id: string;
  title: string;
  startedAt?: Date;
  endedAt?: Date;
  messageCount?: number;
  description?: string;
  /** Optional parser-specific hint about where this session originated. */
  sourcePath?: string;
}

export interface SessionMessage {
  id?: string;
  role: "user" | "assistant" | "tool";
  name?: string;
  content: string;
  timestamp?: Date;
  type: "text" | "plan" | "thinking" | "bash" | "write-file" | "tool-call" | "tool-output";
  toolName?: string;
  plan?: {
    explanation?: string;
    steps: Array<{
      text: string;
      status?: string;
    }>;
  };
}

export interface SessionData {
  id: string;
  agent: string;
  title: string;
  startedAt?: Date;
  endedAt?: Date;
  metadata?: Record<string, string>;
  messages: SessionMessage[];
}

export interface AgentParser {
  readonly agent: string;
  listSessions(): Promise<SessionSummary[]>;
  loadSession(summary: SessionSummary): Promise<SessionData>;
  parseHistory(content: string, sourcePath?: string): SessionSummary[];
  parseSession(content: string, sourcePath?: string): SessionData;
}
