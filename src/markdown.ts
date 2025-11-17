import type { SessionData, SessionMessage } from "./types";

interface RenderOptions {
  includeMetadataFields?: string[];
  displayToolOutput?: boolean;
  title?: string;
}

const formatDate = (value?: Date) => (value ? value.toISOString() : undefined);

const metadataResolvers: Record<string, (session: SessionData) => string | undefined> = {
  agent: (session) => session.agent,
  "session-id": (session) => session.id,
  "started-time": (session) => formatDate(session.startedAt),
  "ended-time": (session) => formatDate(session.endedAt),
  cwd: (session) => session.metadata?.cwd,
  "cli-version": (session) => session.metadata?.cliVersion,
  originator: (session) => session.metadata?.originator,
  summary: (session) => session.metadata?.summary,
};

const resolveMetadataLines = (session: SessionData, fields: string[]): string[] => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const field of fields) {
    if (seen.has(field)) continue;
    seen.add(field);
    const resolver = metadataResolvers[field] ?? (() => session.metadata?.[field]);
    const value = resolver(session);
    if (!value) continue;
    const label = field
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    lines.push(`- ${label}: ${value}`);
  }
  return lines;
};

export const renderSessionMarkdown = (
  session: SessionData,
  options: RenderOptions = {},
): string => {
  const lines: string[] = [];
  const title = options.title?.trim() || session.title || `Session ${session.id}`;
  const includeFields =
    options.includeMetadataFields && options.includeMetadataFields.length
      ? options.includeMetadataFields
      : ["agent", "session-id", "started-time", "cwd"];

  lines.push(`# ${title}`);
  lines.push("");
  const frontMatterLines = resolveMetadataLines(session, includeFields);
  lines.push(...frontMatterLines);
  lines.push("");

  lines.push("## Conversation");
  lines.push("");

  session.messages.forEach((message) => {
    renderMessage(lines, message, options);
  });

  lines.push("");
  return lines.join("\n");
};

const renderMessage = (lines: string[], message: SessionMessage, options: RenderOptions) => {
  const type = message.type ?? "text";
  if (!message.content && !message.plan) {
    return;
  }
  switch (type) {
    case "plan":
      renderPlan(lines, message);
      break;
    case "thinking":
      renderThinking(lines, message);
      break;
    case "bash":
      renderBash(lines, message);
      break;
    case "write-file":
      renderWriteFile(lines, message);
      break;
    case "tool-call":
      renderToolCall(lines, message);
      break;
    case "tool-output":
      renderToolOutput(lines, message, options);
      break;
    case "text":
    default:
      renderText(lines, message);
      break;
  }
};

const renderText = (lines: string[], message: SessionMessage) => {
  const content = (message.content ?? "").trim();
  if (!content) return;
  if (message.role === "user") {
    content.split(/\r?\n/).forEach((line) => lines.push(`> ${line}`));
  } else {
    lines.push(content);
  }
  lines.push("");
};

const renderPlan = (lines: string[], message: SessionMessage) => {
  if (message.content) {
    lines.push(message.content.trim());
  }
  const steps = message.plan?.steps ?? [];
  steps.forEach((step) => {
    const marker = planMarker(step.status);
    lines.push(`- ${marker} ${step.text}`);
  });
  lines.push("");
};

const renderThinking = (lines: string[], message: SessionMessage) => {
  const text = message.content?.trim();
  if (!text) return;
  lines.push(`*${text}*`);
  lines.push("");
};

const renderBash = (lines: string[], message: SessionMessage) => {
  const command = message.content ?? "";
  const trimmed = command.trim();
  if (!trimmed) {
    lines.push("Ran shell command.");
  } else if (trimmed.includes("\n")) {
    lines.push("Ran shell:");
    lines.push("```");
    lines.push(trimmed);
    lines.push("```");
  } else {
    lines.push(`Ran shell: \`${trimmed}\``);
  }
  lines.push("");
};

const renderWriteFile = (lines: string[], message: SessionMessage) => {
  const payload = parseWritePayload(message.content ?? "");
  const fence = codeFenceFor(payload.path, payload.content);
  const target = payload.path ? ` \`${payload.path}\`` : "";
  lines.push(`Wrote file${target}:`);
  lines.push(fence);
  lines.push(payload.content.trimEnd());
  lines.push(fence === '---' ? "---" : "```");
  lines.push("");
};

const renderToolCall = (lines: string[], message: SessionMessage) => {
  const tool = message.toolName ?? message.name ?? "tool";
  const content = (message.content ?? "").trim();
  if (tool.startsWith("mcp__")) {
    lines.push(`MCP call: \`${tool}: ${content}\``);
  } else if (content) {
    lines.push(`Ran ${tool}: ${content}`);
  } else {
    lines.push(`Ran ${tool}`);
  }
  lines.push("");
};

const renderToolOutput = (lines: string[], message: SessionMessage, options: RenderOptions) => {
  if (!options.displayToolOutput) return;
  const trimmed = message.content?.trim();
  if (!trimmed) return;
  lines.push("```");
  lines.push(trimmed);
  lines.push("```");
  lines.push("");
};

const planMarker = (status?: string) => {
  if (!status) return "[ ]";
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[-]";
  return "[ ]";
};

const parseWritePayload = (text: string): { path: string; content: string } => {
  try {
    const parsed = JSON.parse(text) as { path?: string; content?: string };
    return {
      path: typeof parsed.path === "string" ? parsed.path : "",
      content: typeof parsed.content === "string" ? parsed.content : "",
    };
  } catch {
    return { path: "", content: text };
  }
};

const codeFenceFor = (path?: string, content?: string): string => {
  const fileType = fileTypeFromExt(path);
  if (fileType === "markdown") {
    return "---";
  }
  return fileType ? `\`\`\`${fileType}` : "```";
};

const fileTypeFromExt = (path?: string): string | undefined => {
  if (!path) return undefined;
  const lower = path.toLowerCase();
  const match = lower.match(/\.([a-z0-9]+)$/);
  if (!match) return undefined;
  const ext = match[1];
  switch (ext) {
    case "md":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "ts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
      return "javascript";
    case "jsx":
      return "jsx";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
      return "bash";
    case "c":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
      return "cpp";
    case "h":
      return "c";
    case "hpp":
    case "hh":
      return "cpp";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    case "rb":
      return "ruby";
    case "swift":
      return "swift";
    case "kt":
    case "kts":
      return "kotlin";
    case "html":
      return "html";
    case "css":
      return "css";
    case "xml":
      return "xml";
    case "sql":
      return "sql";
    default:
      return undefined;
  }
};

const isMarkdownPath = (path?: string): boolean => {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
};
