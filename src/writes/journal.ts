import { createHash } from "node:crypto";
import { z } from "zod";
import { ServiceError, publicError } from "../errors.js";
import { readJson, writePrivateJson } from "../storage.js";

const entrySchema = z.object({
  key: z.string(), hash: z.string(), createdAt: z.number(), state: z.enum(["pending", "complete", "failed"]),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
});
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
type Entry = z.infer<typeof entrySchema>;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class WriteJournal {
  private readonly active = new Map<string, Promise<unknown>>();
  private readonly locks = new Set<string>();
  constructor(private readonly path: string) {}

  private load() {
    try { return journalSchema.parse(readJson(this.path) ?? { version: 1, entries: [] }); } catch {
      throw new ServiceError("WRITE_JOURNAL_INVALID", "The private write journal cannot be read. Restore it before retrying writes.");
    }
  }

  private update(entry: Entry) {
    const journal = this.load();
    journal.entries = journal.entries.filter(item => item.key !== entry.key);
    journal.entries.push(entry);
    writePrivateJson(this.path, journal);
  }

  async run<T>(account: string, action: string, requestId: string, resource: string, args: unknown, perform: () => Promise<T>): Promise<T> {
    const key = digest([account, action, requestId]);
    const hash = digest(args);
    const journal = this.load();
    const previous = journal.entries.find(item => item.key === key);
    if (previous) {
      if (previous.hash !== hash) throw new ServiceError("WRITE_REQUEST_CONFLICT", "This requestId was already used with different inputs.");
      if (previous.state === "complete") return structuredClone(previous.data) as T;
      if (previous.state === "failed" && previous.error) {
        throw new ServiceError(previous.error.code, previous.error.message, false, previous.error.details);
      }
      if (this.active.has(key)) return this.active.get(key) as Promise<T>;
      throw new ServiceError("WRITE_OUTCOME_UNKNOWN", "A previous attempt did not finish recording its result. Check the assignment or calendar before using a new requestId.");
    }
    const lock = digest([account, resource]);
    if (this.active.size >= 4) throw new ServiceError("WRITE_IN_PROGRESS", "Four writes are already in progress. Retry shortly.", true);
    if (this.locks.has(lock)) throw new ServiceError("WRITE_IN_PROGRESS", "Another write to this assignment or calendar is in progress.", true);
    const entry: Entry = { key, hash, createdAt: Date.now(), state: "pending" };
    journal.entries = journal.entries.filter(item => item.createdAt > Date.now() - 7 * 86400_000);
    if (journal.entries.length >= 2000) throw new ServiceError("WRITE_JOURNAL_FULL", "The write journal has reached its seven-day capacity.");
    journal.entries.push(entry);
    writePrivateJson(this.path, journal);
    this.locks.add(lock);
    const operation = (async () => {
      try {
        const data = await perform();
        this.update({ ...entry, state: "complete", data });
        return data;
      } catch (error) {
        const detail = publicError(error);
        const uncertain = ["UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "UPSTREAM_FORMAT_ERROR", "MICROSOFT_TIMEOUT", "MICROSOFT_UNAVAILABLE", "MICROSOFT_FORMAT_ERROR", "WRITE_PARTIAL_FAILURE", "INTERNAL_ERROR"].includes(detail.code) ||
          (["UPSTREAM_HTTP_ERROR", "MICROSOFT_HTTP_ERROR"].includes(detail.code) && detail.retryable);
        const stored = uncertain
          ? { code: "WRITE_OUTCOME_UNKNOWN", message: "The write may have partially completed. Check its state before using a new requestId.", details: { cause: detail.code, ...("details" in detail ? detail.details : {}) } }
          : detail;
        this.update({ ...entry, state: "failed", error: stored });
        throw new ServiceError(stored.code, stored.message, false, "details" in stored ? stored.details : undefined);
      } finally {
        this.locks.delete(lock);
        this.active.delete(key);
      }
    })();
    this.active.set(key, operation);
    return operation;
  }
}
