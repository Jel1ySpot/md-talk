import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentParser, SessionData, SessionMessage, SessionSummary } from "../types";

interface CodexParserOptions {
  historyFile?: string;
  sessionsRoot?: string;
}

interface HistoryEntry {
  sessionId: string;
  timestamp?: Date;
  text: string;
  line: number;
}

interface SessionAggregate {
  id: string;
  entries: HistoryEntry[];
  startedAt?: Date;
  endedAt?: Date;
  firstText?: string;
}

interface SessionRecord {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

const cleanSnippet = (value?: string): string | undefined => {
  if (!value) return undefined;
  const compact = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 90 ? `${compact.slice(0, 87)}…` : compact;
};

const toDateFromSeconds = (value?: number): Date | undefined => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const textFromContentArray = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (entry && typeof entry === "object" && "type" in entry) {
      const type = (entry as { type?: string }).type;
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string" && ["input_text", "output_text", "text"].includes(type ?? "")) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n").trim();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const extractShellCommand = (record: Record<string, unknown>): string | undefined => {
  const command = record.command;
  if (Array.isArray(command)) {
    return command.map((part) => String(part)).join(" ");
  }
  if (typeof command === "string") {
    return command;
  }
  return undefined;
};

const extractPrimaryText = (record: Record<string, unknown>): string | undefined => {
  const preferredKeys = ["prompt", "input", "text", "query", "message"];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

const normalizeRole = (value?: string): SessionMessage["role"] => {
  if (value === "assistant") return "assistant";
  if (value === "tool") return "tool";
  return "user";
};

const parsePlanDetails = (value: unknown): SessionMessage["plan"] | undefined => {
  if (!isRecord(value)) return undefined;
  const explanation = typeof value.explanation === "string" ? value.explanation : undefined;
  const planEntries = Array.isArray(value.plan) ? value.plan : [];
  const steps: { text: string; status?: string }[] = [];
  for (const entry of planEntries) {
    if (!isRecord(entry)) continue;
    const text = typeof entry.step === "string" ? entry.step : undefined;
    if (!text) continue;
    const status = typeof entry.status === "string" ? entry.status : undefined;
    steps.push({ text, status });
  }

  if (!explanation && steps.length === 0) {
    return undefined;
  }

  return { explanation, steps };
};

const formatToolCallContent = (
  name: string,
  argsValue: unknown,
  rawArguments: string,
): { text: string; toolName: string; type: SessionMessage["type"] } => {
  const record = isRecord(argsValue) ? argsValue : undefined;
  if (name.includes("mcp__")) {
    const argsText = rawArguments || JSON.stringify(argsValue ?? {});
    return { text: argsText, toolName: name, type: "tool-call" };
  }
  if (name === "shell" && record) {
    const command = extractShellCommand(record) ?? "";
    return { text: command, toolName: name, type: "bash" };
  }
  if (record) {
    const content = extractPrimaryText(record);
    if (content) {
      return { text: content, toolName: name, type: "tool-call" };
    }
  }
  return { text: rawArguments, toolName: name, type: "tool-call" };
};

const extractToolOutput = (source: unknown): string => {
  if (typeof source === "string") {
    const parsed = parseJson(source);
    if (parsed && isRecord(parsed)) {
      const output = parsed.output;
      if (typeof output === "string") return output;
      if (Array.isArray(output)) return output.map(String).join("\n");
    }
    return source;
  }

  if (isRecord(source)) {
    const output = source.output;
    if (typeof output === "string") {
      return output;
    }
    if (typeof output === "object" && output) {
      return JSON.stringify(output);
    }
    const stdout = source.stdout;
    if (typeof stdout === "string") {
      return stdout;
    }
    if (typeof source.result === "string") {
      return source.result;
    }
  }

  return "";
};

export class CodexParser implements AgentParser {
  readonly agent = "codex";
  private readonly historyFile: string;
  private readonly sessionsRoot: string;
  private historyCache?: Map<string, SessionAggregate>;
  private readonly sessionPathCache = new Map<string, string | null>();

  constructor(options: CodexParserOptions = {}) {
    const codexDir = join(homedir(), ".codex");
    this.historyFile = options.historyFile ?? join(codexDir, "history.jsonl");
    this.sessionsRoot = options.sessionsRoot ?? join(codexDir, "sessions");
  }

  async listSessions(): Promise<SessionSummary[]> {
    const aggregates = await this.loadHistory();
    const summaries: SessionSummary[] = [];
    for (const aggregate of aggregates.values()) {
      const firstLine = aggregate.entries[0];
      summaries.push({
        id: aggregate.id,
        title: cleanSnippet(aggregate.firstText) ?? aggregate.id,
        description: cleanSnippet(aggregate.firstText),
        startedAt: aggregate.startedAt,
        endedAt: aggregate.endedAt,
        messageCount: aggregate.entries.length,
        sourcePath: firstLine ? `${this.historyFile}#${firstLine.line}` : this.historyFile,
      });
    }
    summaries.sort((a, b) => {
      const left = a.startedAt?.getTime() ?? 0;
      const right = b.startedAt?.getTime() ?? 0;
      return right - left;
    });
    return summaries;
  }

  async loadSession(summary: SessionSummary): Promise<SessionData> {
    const aggregates = await this.loadHistory();
    const aggregate = aggregates.get(summary.id);

    const metadata: Record<string, string> = { historyFile: this.historyFile };
    if (aggregate?.entries.length) {
      metadata.historyLines = String(aggregate.entries.length);
    }
    if (aggregate?.firstText) {
      const trimmed = cleanSnippet(aggregate.firstText);
      if (trimmed) {
        metadata.summary = trimmed;
      }
    }

    const sessionPath = await this.findSessionPath(summary.id);
    if (sessionPath) {
      metadata.sessionFile = sessionPath;
      const session = await this.parseSessionFile(summary, sessionPath, metadata);
      if (session.messages.length) {
        return session;
      }
    }

    const fallbackMessages = aggregate ? this.buildMessagesFromHistory(aggregate.entries) : [];
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

  private async loadHistory(): Promise<Map<string, SessionAggregate>> {
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

    const map = new Map<string, SessionAggregate>();
    const lines = contents.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const payload = JSON.parse(trimmed) as { session_id?: string; ts?: number; text?: string };
        if (!payload.session_id || typeof payload.text !== "string") {
          return;
        }
        const aggregate = map.get(payload.session_id) ?? {
          id: payload.session_id,
          entries: [],
        };
        const timestamp = toDateFromSeconds(payload.ts);
        const entry: HistoryEntry = {
          sessionId: payload.session_id,
          line: index + 1,
          timestamp,
          text: payload.text,
        };
        aggregate.entries.push(entry);
        if (timestamp) {
          if (!aggregate.startedAt || timestamp < aggregate.startedAt) {
            aggregate.startedAt = timestamp;
          }
          if (!aggregate.endedAt || timestamp > aggregate.endedAt) {
            aggregate.endedAt = timestamp;
          }
        }
        if (!aggregate.firstText) {
          aggregate.firstText = payload.text;
        }
        map.set(payload.session_id, aggregate);
      } catch {
        // ignore malformed lines
      }
    });
    this.historyCache = map;
    return map;
  }

  private buildMessagesFromHistory(entries: HistoryEntry[]): SessionMessage[] {
    return entries.map((entry, index) => ({
      id: `${entry.sessionId}-${entry.line}-${index}`,
      role: "user",
      content: entry.text,
      timestamp: entry.timestamp,
      type: "text",
    }));
  }

  private async findSessionPath(sessionId: string): Promise<string | undefined> {
    if (this.sessionPathCache.has(sessionId)) {
      return this.sessionPathCache.get(sessionId) ?? undefined;
    }

    const queue: string[] = [this.sessionsRoot];
    while (queue.length) {
      const current = queue.shift()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
          this.sessionPathCache.set(sessionId, fullPath);
          return fullPath;
        }
      }
    }

    this.sessionPathCache.set(sessionId, null);
    return undefined;
  }

  private async parseSessionFile(
    summary: SessionSummary,
    sessionPath: string,
    metadata: Record<string, string>,
  ): Promise<SessionData> {
    let contents = "";
    try {
      contents = await readFile(sessionPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          id: summary.id,
          agent: this.agent,
          title: summary.title,
          startedAt: summary.startedAt,
          endedAt: summary.endedAt,
          metadata,
          messages: [],
        };
      }
      throw error;
    }

    const messages: SessionMessage[] = [];
    let startedAt = summary.startedAt;
    let endedAt = summary.endedAt;

    const lines = contents.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(trimmed) as SessionRecord;
      } catch {
        continue;
      }

      if (record.type === "session_meta" && record.payload) {
        const payload = record.payload as {
          timestamp?: string;
          cwd?: string;
          cli_version?: string;
          originator?: string;
        };
        const payloadTimestamp = payload.timestamp;
        if (!startedAt && typeof payloadTimestamp === "string") {
          const date = new Date(payloadTimestamp);
          if (!Number.isNaN(date.getTime())) {
            startedAt = date;
          }
        }
        if (typeof payload.cwd === "string") {
          metadata.cwd = payload.cwd;
        }
        if (typeof payload.cli_version === "string") {
          metadata.cliVersion = payload.cli_version;
        }
        if (typeof payload.originator === "string") {
          metadata.originator = payload.originator;
        }
        continue;
      }

      if (record.type !== "response_item" || !record.payload) {
        continue;
      }

      const payload = record.payload as Record<string, unknown>;
      const recordTimestamp = record.timestamp ? new Date(record.timestamp) : undefined;
      if (recordTimestamp && !Number.isNaN(recordTimestamp.getTime())) {
        if (!startedAt) startedAt = recordTimestamp;
        endedAt = recordTimestamp;
      }

      const payloadType = (payload as { type?: string }).type;
      if (payloadType === "message") {
        const text = textFromContentArray((payload as { content?: unknown }).content);
        if (!text) continue;
        const payloadRole = (payload as { role?: string }).role;
        const payloadName = (payload as { name?: string }).name;
        const normalizedRole = normalizeRole(payloadRole);
        const name = typeof payloadName === "string" ? payloadName : undefined;
        messages.push({
          role: normalizedRole,
          name,
          content: text,
          timestamp: recordTimestamp,
          type: "text",
        });
      } else if (payloadType === "function_call") {
        const name =
          typeof (payload as { name?: string }).name === "string"
            ? (payload as { name?: string }).name!
            : "function_call";
        const argsSource = (payload as { arguments?: unknown }).arguments;
        const argsString = typeof argsSource === "string" ? argsSource : JSON.stringify(argsSource ?? {});
        const argsValue = parseJson(argsString);
        if (name === "update_plan") {
          const plan = parsePlanDetails(argsValue);
          const explanation = plan?.explanation ?? "Plan update.";
          const planPayload = plan ?? { explanation, steps: [] };
          messages.push({
            role: "assistant",
            name,
            content: explanation,
            timestamp: recordTimestamp,
            type: "plan",
            plan: planPayload,
          });
        } else {
          const formatted = formatToolCallContent(name, argsValue, argsString);
          messages.push({
            role: "assistant",
            name,
            content: formatted.text,
            timestamp: recordTimestamp,
            type: formatted.type,
            toolName: formatted.toolName,
          });
        }
      } else if (payloadType === "function_call_output") {
        const outputSource = (payload as { output?: unknown }).output;
        const output = extractToolOutput(outputSource);
        if (!output) continue;
        messages.push({
          role: "tool",
          content: output,
          timestamp: recordTimestamp,
          type: "tool-output",
        });
      }
    }

    return {
      id: summary.id,
      agent: this.agent,
      title: summary.title,
      startedAt,
      endedAt,
      metadata,
      messages,
    };
  }
}
