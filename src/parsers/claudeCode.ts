import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { AgentParser, SessionData, SessionMessage, SessionSummary } from "../types";

interface ClaudeCodeParserOptions {
  historyFile?: string;
  projectsRoot?: string;
}

interface HistoryRow {
  sessionId?: string;
  project?: string;
  timestamp?: number;
  display?: string;
}

interface HistoryAggregate {
  id: string;
  projectPath?: string;
  projectDir?: string;
  startedAt?: Date;
  endedAt?: Date;
  previews: string[];
  entryCount: number;
}

interface RawSessionRecord {
  type?: string;
  message?: ClaudeMessage;
}

interface ClaudeMessage {
  role?: string;
  content?: string | ClaudeContent[];
}

interface ClaudeContent {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
  thinking?: string;
}

interface ToolUseFormatResult {
  text: string;
  type: SessionMessage["type"];
  plan?: SessionMessage["plan"];
  toolName?: string;
}

const normalizeRole = (value?: string): SessionMessage["role"] => {
  if (value === "assistant") return "assistant";
  if (value === "tool") return "tool";
  return "user";
};

export class ClaudeCodeParser implements AgentParser {
  readonly agent = "claude-code";
  private readonly historyFile: string;
  private readonly projectsRoot: string;
  private historyCache?: Map<string, HistoryAggregate>;

  constructor(options: ClaudeCodeParserOptions = {}) {
    const claudeDir = join(homedir(), ".claude");
    this.historyFile = options.historyFile ?? join(claudeDir, "history.jsonl");
    this.projectsRoot = options.projectsRoot ?? join(claudeDir, "projects");
  }

  parseHistory(content: string, sourcePath?: string): SessionSummary[] {
    const aggregates = this.parseHistoryContent(content);
    return this.buildSummariesFromAggregates(aggregates, sourcePath ?? this.historyFile);
  }

  parseSession(content: string, sourcePath?: string): SessionData {
    const id = this.deriveSessionId(sourcePath);
    const aggregate: HistoryAggregate = { id, previews: [], entryCount: 0 };
    const { messages, startedAt, endedAt } = this.parseSessionContent(content, aggregate);
    const title = messages[0]?.content ?? id;
    const metadata: Record<string, string> = {};
    if (sourcePath) {
      metadata.sessionFile = sourcePath;
    }
    return {
      id,
      agent: this.agent,
      title,
      startedAt,
      endedAt,
      metadata,
      messages,
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const aggregates = await this.loadHistory();
    return this.buildSummariesFromAggregates(aggregates);
  }

  async loadSession(summary: SessionSummary): Promise<SessionData> {
    const aggregates = await this.loadHistory();
    const aggregate = aggregates.get(summary.id);

    const metadata: Record<string, string> = {};
    if (aggregate?.projectPath) {
      metadata.projectPath = aggregate.projectPath;
    }
    const sessionPath = this.buildSessionPath(aggregate);
    if (sessionPath) {
      metadata.sessionFile = sessionPath;
    }

    if (!aggregate || !sessionPath) {
      const fallbackMessages = aggregate ? this.buildMessagesFromHistory(aggregate.previews, summary.id) : [];
      return {
        id: summary.id,
        agent: this.agent,
        title: summary.title,
        startedAt: summary.startedAt ?? aggregate?.startedAt,
        endedAt: summary.endedAt ?? aggregate?.endedAt,
        metadata,
        messages: fallbackMessages,
      };
    }

    const { messages, startedAt, endedAt } = await this.parseSessionFile(sessionPath, aggregate);
    return {
      id: summary.id,
      agent: this.agent,
      title: summary.title,
      startedAt: startedAt ?? aggregate.startedAt,
      endedAt: endedAt ?? aggregate.endedAt,
      metadata,
      messages: messages.length ? messages : this.buildMessagesFromHistory(aggregate.previews, summary.id),
    };
  }

  private async loadHistory(): Promise<Map<string, HistoryAggregate>> {
    if (this.historyCache) {
      return this.historyCache;
    }

    let contents = "";
    try {
      contents = await readFile(this.historyFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.historyCache = new Map();
        return this.historyCache;
      }
      throw error;
    }

    const map = this.parseHistoryContent(contents);
    this.historyCache = map;
    return map;
  }

  private deriveSessionId(inputFile?: string): string {
    if (!inputFile) return "session";
    const file = basename(inputFile);
    const trimmed = file.replace(/\.jsonl$/i, "");
    return trimmed || file || "session";
  }

  private buildSummariesFromAggregates(
    aggregates: Map<string, HistoryAggregate>,
    sourcePath?: string,
  ): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    for (const aggregate of aggregates.values()) {
      const title = aggregate.previews[0] ?? aggregate.id;
      summaries.push({
        id: aggregate.id,
        title,
        description: aggregate.previews.slice(0, 3).join(" "),
        startedAt: aggregate.startedAt,
        endedAt: aggregate.endedAt,
        messageCount: aggregate.entryCount,
        sourcePath,
      });
    }

    summaries.sort((a, b) => {
      const left = a.startedAt?.getTime() ?? 0;
      const right = b.startedAt?.getTime() ?? 0;
      return right - left;
    });
    return summaries;
  }

  private async parseSessionFile(sessionPath: string, aggregate: HistoryAggregate) {
    let contents = "";
    try {
      contents = await readFile(sessionPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { messages: [] as SessionMessage[], startedAt: undefined as Date | undefined, endedAt: undefined as Date | undefined };
      }
      throw error;
    }

    return this.parseSessionContent(contents, aggregate);
  }

  private parseSessionContent(
    contents: string,
    aggregate: HistoryAggregate,
  ): { messages: SessionMessage[]; startedAt?: Date; endedAt?: Date } {
    const lines = contents.split(/\r?\n/);
    const messages: SessionMessage[] = [];
    let startedAt: Date | undefined;
    let endedAt: Date | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: RawSessionRecord;
      try {
        record = JSON.parse(trimmed) as RawSessionRecord;
      } catch {
        continue;
      }

      if (!record || !record.type || !record.message) {
        continue;
      }

      const timestamp = this.toDate((record as { timestamp?: string | number }).timestamp);
      if (timestamp) {
        if (!startedAt) startedAt = timestamp;
        endedAt = timestamp;
      }

      if (record.type !== "user" && record.type !== "assistant") {
        continue;
      }

      const role = record.message.role ?? record.type;
      const normalizedRole = normalizeRole(role);
      const entries = this.normalizeContent(record.message.content);
      let textBuffer: string[] = [];

      const flushText = () => {
        if (!textBuffer.length) return;
        const text = textBuffer.join("\n\n").trim();
        if (text) {
          messages.push({ role: normalizedRole, content: text, timestamp, type: "text" });
        }
        textBuffer = [];
      };

      for (const entry of entries) {
        if (!entry) continue;
        if (entry.type === "text" && typeof entry.text === "string") {
          textBuffer.push(entry.text);
          continue;
        }
        if (entry.type === "thinking") {
          flushText();
          if (entry.thinking && typeof entry.thinking === "string") {
            messages.push({
              role: "assistant",
              content: entry.thinking,
              type: "thinking",
              timestamp,
            });
          }
          continue;
        }
        if (entry.type === "tool_use") {
          flushText();
          const formatted = this.formatToolUse(entry);
          messages.push({
            role: "assistant",
            content: formatted.text,
            type: formatted.type,
            plan: formatted.plan,
            toolName: formatted.toolName ?? entry.name,
            timestamp,
          });
          continue;
        }
        if (entry.type === "tool_result") {
          flushText();
          const output = this.formatToolResult(entry);
          if (output) {
            messages.push({ role: "tool", content: output, type: "tool-output", timestamp });
          }
        }
      }

      flushText();
    }

    return { messages, startedAt, endedAt };
  }

  private parseHistoryContent(contents: string): Map<string, HistoryAggregate> {
    const map = new Map<string, HistoryAggregate>();
    const lines = contents.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: HistoryRow;
      try {
        payload = JSON.parse(trimmed) as HistoryRow;
      } catch {
        continue;
      }
      if (!payload.sessionId) continue;
      const aggregate = map.get(payload.sessionId) ?? {
        id: payload.sessionId,
        previews: [],
        entryCount: 0,
      };
      aggregate.entryCount += 1;
      if (payload.project && !aggregate.projectPath) {
        aggregate.projectPath = payload.project;
        aggregate.projectDir = this.sanitizeProjectPath(payload.project);
      }
      if (payload.display && !aggregate.previews.includes(payload.display)) {
        aggregate.previews.push(payload.display);
      }
      const timestamp = this.toDate(payload.timestamp);
      if (timestamp) {
        if (!aggregate.startedAt || timestamp < aggregate.startedAt) {
          aggregate.startedAt = timestamp;
        }
        if (!aggregate.endedAt || timestamp > aggregate.endedAt) {
          aggregate.endedAt = timestamp;
        }
      }
      map.set(payload.sessionId, aggregate);
    }
    return map;
  }

  private buildSessionPath(aggregate?: HistoryAggregate): string | undefined {
    if (!aggregate?.projectDir) return undefined;
    return join(this.projectsRoot, aggregate.projectDir, `${aggregate.id}.jsonl`);
  }

  private buildMessagesFromHistory(previews: string[], sessionId: string): SessionMessage[] {
    return previews.map((text, index) => ({
      id: `${sessionId}-${index}`,
      role: "user",
      content: text,
      type: "text",
    }));
  }

  private sanitizeProjectPath(project: string): string {
    const normalized = project.trim().replace(/\\/g, "/");
    const withoutLeading = normalized.replace(/^\//, "");
    const replaced = withoutLeading.replace(/[:]/g, "-").replace(/\//g, "-");
    return `-${replaced}`;
  }

  private toDate(value?: number | string): Date | undefined {
    if (value === undefined) return undefined;
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private normalizeContent(content?: string | ClaudeContent[]): ClaudeContent[] {
    if (!content) return [];
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (Array.isArray(content)) {
      return content;
    }
    return [];
  }

  private formatToolUse(entry: ClaudeContent): ToolUseFormatResult {
    const toolName = entry.name ?? "tool";
    const inputString = entry.input && Object.keys(entry.input).length ? JSON.stringify(entry.input) : "";
    const lower = toolName.toLowerCase();

    if (lower === "write") {
      return {
        text: this.serializeWritePayload(entry.input),
        type: "write-file",
        toolName,
      };
    }
    if (lower === "bash" || lower === "shell") {
      const command = this.extractCommand(entry.input) ?? inputString;
      return { text: command, type: "bash", toolName };
    }
    if (lower.startsWith("todo")) {
      const plan = this.formatTodoPlan(entry.input);
      return {
        text: plan?.explanation ?? "Todo update",
        type: "plan",
        plan,
        toolName,
      };
    }
    if (toolName.startsWith("mcp__")) {
      return { text: inputString, type: "tool-call", toolName };
    }
    return inputString
      ? { text: inputString, type: "tool-call", toolName }
      : { text: "", type: "tool-call", toolName };
  }

  private extractCommand(input?: Record<string, unknown>): string | undefined {
    if (!input) return undefined;
    const raw = (input as { command?: unknown }).command;
    if (!raw) return undefined;
    if (typeof raw === "string") {
      return raw;
    }
    if (Array.isArray(raw)) {
      return raw.map((part) => String(part)).join(" ");
    }
    return undefined;
  }

  private serializeWritePayload(input?: Record<string, unknown>): string {
    const path = input && typeof input.file_path === "string" ? input.file_path : "";
    const content = input && typeof input.content === "string" ? input.content : "";
    return JSON.stringify({ path, content });
  }

  private formatToolResult(entry: ClaudeContent): string {
    const { content } = entry;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const formatted: string[] = [];
      for (const part of content) {
        if (!part) continue;
        if (typeof part === "string") {
          formatted.push(part);
          continue;
        }
        if (typeof part === "object") {
          const type = (part as { type?: string }).type;
          if (type === "thinking") {
            continue;
          }
          if (type === "text" && typeof (part as { text?: string }).text === "string") {
            formatted.push((part as { text: string }).text);
            continue;
          }
          if ("content" in part) {
            const nested = (part as { content?: unknown }).content;
            if (typeof nested === "string") {
              formatted.push(nested);
              continue;
            }
            if (Array.isArray(nested)) {
              formatted.push(
                nested.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n"),
              );
              continue;
            }
          }
          formatted.push(JSON.stringify(part));
        }
      }
      return formatted.join("\n");
    }
    if (content && typeof content === "object") {
      if ("text" in content && typeof (content as { text?: string }).text === "string") {
        return (content as { text: string }).text;
      }
      return JSON.stringify(content);
    }
    return "";
  }

  private formatTodoPlan(input?: Record<string, unknown>): SessionMessage["plan"] | undefined {
    if (!input) return undefined;
    const todos = Array.isArray((input as { todos?: unknown }).todos)
      ? ((input as { todos?: unknown[] }).todos as Array<Record<string, unknown>>)
      : [];
    if (!todos.length) {
      return undefined;
    }
    const steps = todos.map((todo) => {
      const text =
        typeof todo.activeForm === "string"
          ? todo.activeForm
          : typeof todo.content === "string"
            ? todo.content
            : JSON.stringify(todo);
      const status = typeof todo.status === "string" ? todo.status : undefined;
      return { text, status };
    });
    return {
      explanation: "Todo list",
      steps,
    };
  }
}
