import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { renderSessionMarkdown } from "./markdown";
import { ClaudeCodeParser } from "./parsers/claudeCode";
import { CodexParser } from "./parsers/codex";
import type { AgentParser, SessionSummary } from "./types";

type CliCommand =
  | { type: "list"; agent: string; metadataFields: string[]; showToolOutput: boolean }
  | {
      type: "export";
      agent: string;
      outputPath: string;
      sessionId?: string;
      metadataFields: string[];
      showToolOutput: boolean;
    };

const defaultMetadataFields = ["agent", "session-id", "started-time", "cwd"];

const parseMetadataFields = (raw?: string): string[] => {
  const source = raw ?? defaultMetadataFields.join(",");
  return source
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
};

const usage = `Usage:\n` +
  `  md-talk ls <agent>\n` +
  `  md-talk <agent> [session-id] -o <output.md>\n\n` +
  `Examples:\n` +
  `  md-talk ls codex\n` +
  `  md-talk codex 019a5895-7e77-7073-94e7-6a483d20ec60 -o main.md\n\n` +
  `Options:\n` +
  `  -o, --out <file>          Target markdown path (required for export)\n` +
  `  -s, --session <id>        Session id (optional, falls back to interactive selection)\n` +
  `      --include-metadata    Comma-separated list of metadata fields for the report\n` +
  `      --display-tool-output Include tool outputs in the conversation log\n` +
  `  -h, --help                Show this help message\n`;

const parseCliArgs = (argv: string[]): CliCommand => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      session: { type: "string", short: "s" },
      out: { type: "string", short: "o" },
      "include-metadata": { type: "string" },
      "display-tool-output": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(usage);
    process.exit(0);
  }

  const metadataFields = parseMetadataFields(values["include-metadata"]);
  const showToolOutput = Boolean(values["display-tool-output"]);
  const [first, second] = positionals;
  if (!first) {
    console.error(usage);
    process.exit(1);
  }

  if (first === "ls" || first === "list") {
    if (!second) {
      console.error("Please provide an agent name to list sessions.\n");
      console.error(usage);
      process.exit(1);
    }
    return { type: "list", agent: second.toLowerCase(), metadataFields, showToolOutput };
  }

  const agentName = first.toLowerCase();
  const sessionId = values.session ?? second;
  const outputPath = values.out;
  if (!outputPath) {
    console.error("Please provide an output path using -o <file>.\n");
    console.error(usage);
    process.exit(1);
  }

  return {
    type: "export",
    agent: agentName,
    outputPath,
    sessionId,
    metadataFields,
    showToolOutput,
  };
};

const resolveParser = (agent: string): AgentParser => {
  const entries: Array<{ names: string[]; parser: AgentParser }> = [
    { names: ["codex"], parser: new CodexParser() },
    { names: ["claude", "claude-code"], parser: new ClaudeCodeParser() },
  ];
  const normalized = agent.toLowerCase();
  const match = entries.find((entry) => entry.names.some((name) => name === normalized));
  if (!match) {
    const supported = entries.flatMap((entry) => entry.names);
    throw new Error(`Unknown agent '${agent}'. Supported agents: ${supported.join(", ")}`);
  }
  return match.parser;
};

const printSessions = (agent: string, sessions: SessionSummary[]) => {
  if (!sessions.length) {
    console.log(`No sessions found for agent '${agent}'.`);
    return;
  }

  console.log(`Sessions for agent '${agent}':\n`);
  sessions.forEach((session) => {
    const started = session.startedAt?.toISOString() ?? "unknown start";
    const count = session.messageCount ?? 0;
    console.log(`- ${session.id}`);
    console.log(`  Title: ${session.title}`);
    console.log(`  Started: ${started}`);
    console.log(`  Messages: ${count}`);
    if (session.description) {
      console.log(`  Summary: ${session.description}`);
    }
    console.log("");
  });
};

const promptForSession = async (sessions: SessionSummary[]): Promise<SessionSummary> => {
  if (!sessions.length) {
    throw new Error("No sessions available to select.");
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interactive selection is unavailable. Pass --session <id> instead.");
  }

  console.log("Available sessions:\n");
  sessions.forEach((session, index) => {
    const started = session.startedAt?.toISOString() ?? "unknown time";
    const meta = `${session.messageCount ?? 0} messages`;
    console.log(`[${index}] ${session.title} — ${started} — ${meta}`);
  });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const response = await rl.question("Select a session number: ");
      const index = Number.parseInt(response, 10);
      if (!Number.isNaN(index) && sessions[index]) {
        return sessions[index];
      }
      console.log("Invalid selection. Please enter one of the listed numbers.");
    }
  } finally {
    rl.close();
  }
};

export const runCli = async (argv: string[]) => {
  const args = parseCliArgs(argv);
  const parser = resolveParser(args.agent);
  const sessions = await parser.listSessions();

  if (!sessions.length) {
    if (args.type === "list") {
      printSessions(parser.agent, sessions);
      return;
    }
    throw new Error(`No sessions found for agent '${parser.agent}'. Check the logs directory.`);
  }

  if (args.type === "list") {
    printSessions(parser.agent, sessions);
    return;
  }

  let summary: SessionSummary;
  if (args.sessionId) {
    const match = sessions.find((session) => session.id === args.sessionId);
    if (!match) {
      throw new Error(`Session '${args.sessionId}' not found for agent '${parser.agent}'.`);
    }
    summary = match;
  } else {
    summary = await promptForSession(sessions);
  }

  const session = await parser.loadSession(summary);
  const markdown = renderSessionMarkdown(session, {
    includeMetadataFields: args.metadataFields,
    displayToolOutput: args.showToolOutput,
  });
  const outputFile = resolve(process.cwd(), args.outputPath);
  await writeFile(outputFile, markdown, "utf8");
  console.log(`Session exported to ${outputFile}`);
};
