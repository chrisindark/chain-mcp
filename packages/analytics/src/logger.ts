import type {
  Logger,
  LogLevel,
  LogRecord,
  LogCorrelationContext,
} from "@chainmcp/core";
import { redactValue, type RedactionOptions } from "./redaction.js";
import { type LogSink, ConsoleSink } from "./sinks.js";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LoggerOptions {
  /** Minimum log level to record. Defaults to 'info'. */
  level?: LogLevel | undefined;
  /** Primary sink for diagnostic logs. Defaults to new ConsoleSink(). */
  diagnosticSink?: LogSink | undefined;
  /** Dedicated sink for security/audit logs. Optional; if not provided, audit logs also flow to diagnosticSink. */
  auditSink?: LogSink | undefined;
  /** Redaction configuration. */
  redaction?: RedactionOptions | undefined;
  /** Default correlation context attached to all records. */
  defaultContext?: LogCorrelationContext | undefined;
  /** Clock source. Defaults to Date.now. */
  now?: (() => number) | undefined;
}

export class StructuredLogger implements Logger {
  private readonly minLevelSeverity: number;
  private readonly diagnosticSink: LogSink;
  private readonly auditSink: LogSink | undefined;
  private readonly redactionOptions: RedactionOptions | undefined;
  private readonly baseContext: LogCorrelationContext;
  private readonly now: () => number;

  constructor(options?: LoggerOptions) {
    const level = options?.level ?? "info";
    this.minLevelSeverity = LOG_LEVEL_SEVERITY[level] ?? 20;
    this.diagnosticSink = options?.diagnosticSink ?? new ConsoleSink();
    this.auditSink = options?.auditSink;
    this.redactionOptions = options?.redaction;
    this.baseContext = options?.defaultContext ?? {};
    this.now = options?.now ?? Date.now;
  }

  private dispatch(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    category: "diagnostic" | "audit",
    explicitContext?: Record<string, unknown>,
  ): void {
    const severity = LOG_LEVEL_SEVERITY[level];
    if (severity < this.minLevelSeverity && category !== "audit") {
      return;
    }

    const mergedContext = {
      ...this.baseContext,
      ...explicitContext,
    };

    const redactedContext = redactValue(
      mergedContext,
      this.redactionOptions,
    ) as LogCorrelationContext;

    const record: LogRecord = {
      level,
      message,
      timestamp: this.now(),
      category,
      context: redactedContext,
    };

    // Route to audit sink if audit category
    if (category === "audit" && this.auditSink) {
      try {
        void Promise.resolve(this.auditSink.emit(record)).catch(() => {});
      } catch {
        // Sink failure isolation
      }
    }

    // Always route to diagnostic sink if within log level
    if (severity >= this.minLevelSeverity) {
      try {
        void Promise.resolve(this.diagnosticSink.emit(record)).catch(() => {});
      } catch {
        // Sink failure isolation
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.dispatch("debug", message, "diagnostic", context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.dispatch("info", message, "diagnostic", context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.dispatch("warn", message, "diagnostic", context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.dispatch("error", message, "diagnostic", context);
  }

  audit(message: string, context?: Record<string, unknown>): void {
    // Audit events default to info level but are tagged category: 'audit'
    this.dispatch("info", message, "audit", context);
  }

  child(context: Record<string, unknown>): StructuredLogger {
    return new StructuredLogger({
      level: Object.keys(LOG_LEVEL_SEVERITY).find(
        (lvl) => LOG_LEVEL_SEVERITY[lvl as LogLevel] === this.minLevelSeverity,
      ) as LogLevel,
      diagnosticSink: this.diagnosticSink,
      auditSink: this.auditSink,
      redaction: this.redactionOptions,
      defaultContext: {
        ...this.baseContext,
        ...context,
      },
      now: this.now,
    });
  }
}

export function createLogger(options?: LoggerOptions): StructuredLogger {
  return new StructuredLogger(options);
}
