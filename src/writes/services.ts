import type { Config } from "../config.js";
import { publicError } from "../errors.js";
import type { SchoolisClient } from "../schoolis/client.js";
import type { MicrosoftClient } from "../microsoft/client.js";
import { SchoolisWrites } from "../schoolis/writes.js";
import { MicrosoftWrites } from "../microsoft/writes.js";
import { WriteJournal } from "./journal.js";

export class WriteServices {
  readonly school: SchoolisWrites;
  readonly microsoft: MicrosoftWrites;
  constructor(
    config: Config, private readonly schoolClient: SchoolisClient, private readonly microsoftClient: MicrosoftClient,
    fileFetcher: typeof fetch = fetch,
  ) {
    const journal = new WriteJournal(config.writeStateFile);
    this.school = new SchoolisWrites(config, schoolClient, journal, fileFetcher);
    this.microsoft = new MicrosoftWrites(microsoftClient, journal, fileFetcher);
  }

  async capabilities() {
    let schoolis: Record<string, unknown>;
    let microsoft: Record<string, unknown>;
    try {
      await this.schoolClient.getProfile();
      schoolis = { connected: true, uploadAndSubmissionImplemented: true };
    } catch (error) { schoolis = { connected: false, error: publicError(error).code }; }
    try { microsoft = { connected: true, ...await this.microsoftClient.writeCapabilities() }; } catch (error) {
      microsoft = { connected: false, error: publicError(error).code };
    }
    return { schoolis, microsoft };
  }
}
