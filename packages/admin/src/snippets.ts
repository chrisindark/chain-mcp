import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  redactConfigSecrets,
  resolveConfigSecrets,
  type SecretResolutionSource,
} from "@chainmcp/config";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface SnippetEnvInstruction {
  readonly variable: string;
  readonly field: string;
  readonly description: string;
  readonly bashExport: string;
  readonly powershellExport: string;
}

export interface ClientSnippetDefinition {
  readonly client: "claude-desktop" | "cursor" | "claude-code";
  readonly filename?: string | undefined;
  readonly configPathGuide?:
    | {
        readonly darwin: string;
        readonly win32: string;
        readonly linux: string;
      }
    | undefined;
  readonly snippet: string;
  readonly json?: Record<string, unknown> | undefined;
}

export interface GenerateSnippetsOptions {
  readonly serverName?: string | undefined;
  readonly configPath?: string | undefined;
  readonly configObject?: unknown | undefined;
  readonly sseUrl?: string | undefined;
  readonly token?: string | undefined;
  readonly transport?: "stdio" | "sse" | undefined;
}

export interface ClientSnippetsResponse {
  readonly ok: boolean;
  readonly serverName: string;
  readonly configPath: string;
  readonly transport: "stdio" | "sse";
  readonly snippets: {
    readonly claudeDesktop: ClientSnippetDefinition;
    readonly cursor: ClientSnippetDefinition;
    readonly claudeCode: ClientSnippetDefinition;
  };
  readonly envInstructions: readonly SnippetEnvInstruction[];
  readonly redactedConfig?: unknown | undefined;
}

function sanitizeAndExtract(
  value: unknown,
  envVars: Set<string>,
  envInstructions: SnippetEnvInstruction[],
  path = "",
): unknown {
  if (typeof value === "string") {
    const matches = value.matchAll(/\$\{([A-Za-z0-9_]+)\}/g);
    for (const match of matches) {
      const v = match[1];
      if (v && !envVars.has(v)) {
        envVars.add(v);
        envInstructions.push({
          variable: v,
          field: path || "environment",
          description: `Environment variable referenced by ${path || "config"}`,
          bashExport: `export ${v}="your-${v.toLowerCase()}-here"`,
          powershellExport: `$env:${v}="your-${v.toLowerCase()}-here"`,
        });
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      sanitizeAndExtract(item, envVars, envInstructions, `${path}[${idx}]`),
    );
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const currentPath = path ? `${path}.${k}` : k;
      const isSensitiveKey =
        /(token|secret|password|api[_-]?key|credential|private[_-]?key|authorization)/i.test(
          k,
        );

      if (typeof v === "string") {
        const isEnvRef = /^\$\{([A-Za-z0-9_]+)\}$/.test(v.trim());
        if (isEnvRef) {
          sanitizeAndExtract(v, envVars, envInstructions, currentPath);
          result[k] = v;
        } else if (isSensitiveKey) {
          result[k] = "[REDACTED]";
        } else {
          result[k] = sanitizeAndExtract(
            v,
            envVars,
            envInstructions,
            currentPath,
          );
        }
      } else {
        result[k] = sanitizeAndExtract(
          v,
          envVars,
          envInstructions,
          currentPath,
        );
      }
    }
    return result;
  }

  return value;
}

export async function generateClientExportSnippets(
  options: GenerateSnippetsOptions = {},
): Promise<ClientSnippetsResponse> {
  const rawName = options.serverName || "chainmcp";
  const serverName = rawName.replace(/[^a-zA-Z0-9_-]/g, "-") || "chainmcp";
  const transport = options.transport ?? (options.sseUrl ? "sse" : "stdio");
  const configPath = options.configPath
    ? resolve(options.configPath)
    : "chainmcp.config.yaml";

  const envVars = new Set<string>();
  const envInstructions: SnippetEnvInstruction[] = [];
  let effectiveConfig = options.configObject;

  if (!effectiveConfig && options.configPath) {
    try {
      if (await pathExists(options.configPath)) {
        const text = await readFile(options.configPath, "utf8");
        try {
          effectiveConfig = JSON.parse(text);
        } catch {
          // If YAML or non-JSON, extract ${VAR} patterns with regex
          const matches = text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g);
          for (const match of matches) {
            const v = match[1];
            if (v && !envVars.has(v)) {
              envVars.add(v);
              envInstructions.push({
                variable: v,
                field: "environment",
                description: `Environment variable referenced in ${configPath}`,
                bashExport: `export ${v}="your-${v.toLowerCase()}-here"`,
                powershellExport: `$env:${v}="your-${v.toLowerCase()}-here"`,
              });
            }
          }
        }
      }
    } catch {
      // Ignore file read error
    }
  }

  let redactedConfig: unknown | undefined;
  if (effectiveConfig && typeof effectiveConfig === "object") {
    // 1. Redact schema-level configuration using @chainmcp/config
    const schemaRedacted = redactConfigSecrets(effectiveConfig);

    // 2. Discover official secret sources using safe proxy environment
    const proxyEnv = new Proxy({} as Record<string, string>, {
      get: (_target, prop) => (typeof prop === "string" ? `[${prop}]` : ""),
    });

    let sources: readonly SecretResolutionSource[] = [];
    try {
      const resolved = resolveConfigSecrets(effectiveConfig, {
        env: proxyEnv,
      });
      sources = resolved.sources;
    } catch {
      // ignore resolution issues
    }

    for (const source of sources) {
      for (const v of source.variables) {
        if (!envVars.has(v)) {
          envVars.add(v);
          envInstructions.push({
            variable: v,
            field: source.field,
            description: `Environment variable referenced by ${source.field}`,
            bashExport: `export ${v}="your-${v.toLowerCase()}-here"`,
            powershellExport: `$env:${v}="your-${v.toLowerCase()}-here"`,
          });
        }
      }
    }

    // 3. Deep-traverse and redact any generic sensitive fields and discover arbitrary ${VAR} refs
    redactedConfig = sanitizeAndExtract(
      schemaRedacted,
      envVars,
      envInstructions,
    );
  }

  if (options.token) {
    if (!envVars.has("CHAINMCP_TOKEN")) {
      envVars.add("CHAINMCP_TOKEN");
      envInstructions.push({
        variable: "CHAINMCP_TOKEN",
        field: "auth.token",
        description: "Authentication token for ChainMcp server / gateway",
        bashExport: `export CHAINMCP_TOKEN="your-chainmcp-token-here"`,
        powershellExport: `$env:CHAINMCP_TOKEN="your-chainmcp-token-here"`,
      });
    }
  }

  const claudeEnv: Record<string, string> = {};
  const cursorEnv: Record<string, string> = {};
  for (const v of envVars) {
    claudeEnv[v] = `\${${v}}`;
    cursorEnv[v] = `\${env:${v}}`;
  }

  // 1. Claude Desktop
  let claudeJson: Record<string, unknown>;
  if (transport === "sse") {
    claudeJson = {
      mcpServers: {
        [serverName]: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            options.sseUrl || "http://127.0.0.1:3341/sse",
          ],
          ...(Object.keys(claudeEnv).length > 0 ? { env: claudeEnv } : {}),
        },
      },
    };
  } else {
    claudeJson = {
      mcpServers: {
        [serverName]: {
          command: "npx",
          args: ["-y", "@chainmcp/cli", "serve", "--config", configPath],
          ...(Object.keys(claudeEnv).length > 0 ? { env: claudeEnv } : {}),
        },
      },
    };
  }

  const claudeDesktop: ClientSnippetDefinition = {
    client: "claude-desktop",
    filename: "claude_desktop_config.json",
    configPathGuide: {
      darwin: "~/Library/Application Support/Claude/claude_desktop_config.json",
      win32: "%APPDATA%\\Claude\\claude_desktop_config.json",
      linux: "~/.config/Claude/claude_desktop_config.json",
    },
    snippet: JSON.stringify(claudeJson, null, 2),
    json: claudeJson,
  };

  // 2. Cursor
  let cursorJson: Record<string, unknown>;
  if (transport === "sse") {
    cursorJson = {
      mcpServers: {
        [serverName]: {
          url: options.sseUrl || "http://127.0.0.1:3341/sse",
          headers: {
            Authorization: "Bearer ${env:CHAINMCP_TOKEN}",
          },
        },
      },
    };
  } else {
    cursorJson = {
      mcpServers: {
        [serverName]: {
          command: "npx",
          args: ["-y", "@chainmcp/cli", "serve", "--config", configPath],
          ...(Object.keys(cursorEnv).length > 0 ? { env: cursorEnv } : {}),
        },
      },
    };
  }

  const cursor: ClientSnippetDefinition = {
    client: "cursor",
    filename: ".cursor/mcp.json",
    configPathGuide: {
      darwin: ".cursor/mcp.json",
      win32: ".cursor\\mcp.json",
      linux: ".cursor/mcp.json",
    },
    snippet: JSON.stringify(cursorJson, null, 2),
    json: cursorJson,
  };

  // 3. Claude Code CLI
  let claudeCodeCmd: string;
  if (transport === "sse") {
    claudeCodeCmd = `claude mcp add ${serverName} "${options.sseUrl || "http://127.0.0.1:3341/sse"}"`;
  } else {
    const envFlags = [...envVars].map((v) => `-e ${v}="\${${v}}"`).join(" ");
    claudeCodeCmd = `claude mcp add ${serverName}${envFlags ? ` ${envFlags}` : ""} -- npx -y @chainmcp/cli serve --config "${configPath}"`;
  }

  const claudeCode: ClientSnippetDefinition = {
    client: "claude-code",
    snippet: claudeCodeCmd,
  };

  return {
    ok: true,
    serverName,
    configPath,
    transport,
    snippets: {
      claudeDesktop,
      cursor,
      claudeCode,
    },
    envInstructions,
    ...(redactedConfig !== undefined ? { redactedConfig } : {}),
  };
}
