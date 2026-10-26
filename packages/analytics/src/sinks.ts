import type { LogRecord } from "@chainmcp/core";

export interface LogSink {
  emit(record: LogRecord): void | Promise<void>;
}

export class MemorySink implements LogSink {
  private readonly buffer: LogRecord[] = [];
  readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = Math.max(1, options?.maxRecords ?? 1_000);
  }

  emit(record: LogRecord): void {
    if (this.buffer.length >= this.maxRecords) {
      this.buffer.shift();
    }
    this.buffer.push(record);
  }

  getRecords(): readonly LogRecord[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }

  find(predicate: (record: LogRecord) => boolean): LogRecord[] {
    return this.buffer.filter(predicate);
  }
}

export interface ConsoleSinkOptions {
  /**
   * Formatting mode: 'json' emits NDJSON lines; 'pretty' emits human-readable text.
   * Defaults to 'json'.
   */
  format?: "json" | "pretty";
  /** Injectable write functions for stdout/stderr (e.g. for testing). */
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export class ConsoleSink implements LogSink {
  private readonly format: "json" | "pretty";
  private readonly stdout: (msg: string) => void;
  private readonly stderr: (msg: string) => void;

  constructor(options?: ConsoleSinkOptions) {
    this.format = options?.format ?? "json";
    this.stdout =
      options?.stdout ??
      ((msg: string) => {
        process.stdout.write(msg + "\n");
      });
    this.stderr =
      options?.stderr ??
      ((msg: string) => {
        process.stderr.write(msg + "\n");
      });
  }

  emit(record: LogRecord): void {
    const isError = record.level === "error" || record.level === "warn";
    const write = isError ? this.stderr : this.stdout;

    if (this.format === "json") {
      try {
        const line = JSON.stringify(record);
        write(line);
      } catch {
        // Fallback if stringify fails
        write(
          JSON.stringify({
            level: record.level,
            message: record.message,
            timestamp: record.timestamp,
          }),
        );
      }
    } else {
      const time = new Date(record.timestamp).toISOString();
      const cat = record.category ? ` [${record.category.toUpperCase()}]` : "";
      const ctx = record.context ? ` ${JSON.stringify(record.context)}` : "";
      write(
        `[${time}] ${record.level.toUpperCase()}${cat}: ${record.message}${ctx}`,
      );
    }
  }
}

export class MultiSink implements LogSink {
  private readonly sinks: readonly LogSink[];

  constructor(sinks: readonly LogSink[]) {
    this.sinks = [...sinks];
  }

  emit(record: LogRecord): void {
    for (const sink of this.sinks) {
      try {
        void Promise.resolve(sink.emit(record)).catch(() => {});
      } catch {
        // Isolated sink error
      }
    }
  }
}
