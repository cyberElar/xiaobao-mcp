import { z } from "zod";
import type { Config } from "../config.js";
import { ServiceError } from "../errors.js";
import { readJson } from "../storage.js";
import { SchoolSession, credentialsSchema, passwordPayload, type Credentials } from "./session.js";

const envelopeSchema = z.object({ state: z.number(), data: z.unknown() });
const profileSchema = z.object({ loginName: z.string().min(1) }).passthrough();
const AUTH_STATES = new Set([999901, 999902]);
const writePaths = new Set(["/api/LearningTask/UploadDocument", "/api/LearningTask/Save"]);
const allowedPaths = new Set([
  ...writePaths, "/api/LearningTask/ContinueAnswerForLearningtask",
  "/api/MemberShip/GetCurrentStudentInfo", "/api/MemberShip/GetStudentCaptchaForLogin",
  "/api/MemberShip/Login", "/api/School/GetSchoolSemesters",
  "/api/LearningTask/GetStuSubjectListForSelect", "/api/LearningTask/GetList",
  "/api/LearningTask/GetDetail", "/api/Exam/GetList", "/api/Exam/GetDetail",
  "/api/DynamicScore/GetDynamicScoreDetail", "/api/DynamicScore/GetStuSemesterDynamicScore",
  "/api/DynamicScore/GetGpa", "/api/Schedule/ListScheduleByParent",
  "/api/LearningTask/GetStatistics", "/api/Exam/GetStatistics",
  "/api/LearningTask/GetStuSubjectListForStatisticsSelect",
  "/api/LearningTask/GetStuLearningTaskTypeListForStatisticsSelect",
  "/api/LearningTask/GetStuLearningTaskTypeListForSelect",
  "/api/Exam/GetStuSubjectListForSelect", "/api/Exam/GetStuSubjectListForStatisticsSelect",
  "/api/Exam/GetStuExamTypeListForStatisticsSelect", "/api/Exam/GetStuExamTypeListForSelect",
  "/api/DynamicScore/ListGpaSettings", "/api/DynamicScore/IsStudentSemesterScoreStorage",
  "/api/Lms/HasLmsSite", "/api/MemberShip/GetCurrentOrgConfigByOrg",
  "/api/MemberShip/IsEnableStudentCustomForm", "/api/MemberShip/ListUsedQuestionnaireTypes",
  "/api/StudyAbroad/GetStudentPromotionIdByStudentId",
  "/api/StudyAbroad/GetPromotionTaskUnfinishedCount", "/api/StudyAbroad/GetPromotionTaskList",
  "/api/StudyAbroad/GetPromotionTaskDetails", "/api/StudyAbroad/GetPromotionDataList",
  "/api/StudyAbroad/GetStudyAbroadDocumentsList", "/api/StudyAbroad/GetPromotionDataUploaderForSelect",
  "/api/StudyAbroad/GetStudyAbroadDocumentsUploaderForSelect",
]);

export type Query = Record<string, string | number | undefined>;
type CacheEntry = { expires: number; data: unknown };

export class SchoolisClient {
  readonly session: SchoolSession;
  private readonly cache = new Map<string, CacheEntry>();
  private refresh: Promise<void> | undefined;
  private profile: Record<string, unknown> | undefined;
  private profileExpires = 0;
  private sessionRevision = 0;
  private nextLoginAttempt = 0;

  constructor(
    private readonly config: Pick<Config, "schoolUrl" | "sessionFile" | "credentialsFile" | "timeoutMs" | "cacheTtlMs">,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.session = new SchoolSession(config.sessionFile, config.schoolUrl.origin);
  }

  private async request(path: string, query: Query = {}, body?: unknown): Promise<unknown> {
    if (!allowedPaths.has(path)) throw new ServiceError("INVALID_ENDPOINT", "Unsupported school endpoint.");
    const url = new URL(path, this.config.schoolUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const multipart = body instanceof FormData;
    try {
      const cookie = await this.session.jar.getCookieString(url.href);
      const response = await this.fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json", "User-Agent": "XiaobaoMCPtool/0.1",
          Referer: `${this.config.schoolUrl.origin}/`, Origin: this.config.schoolUrl.origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined || multipart ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
        redirect: "manual", signal: controller.signal,
      });
      let changed = false;
      for (const value of response.headers.getSetCookie()) {
        await this.session.jar.setCookie(value, url.href);
        changed = true;
      }
      if (changed) this.session.save();
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
        throw new ServiceError("SESSION_EXPIRED", "School login is required. Run npm run session:login.");
      }
      if (!response.ok) {
        throw new ServiceError("UPSTREAM_HTTP_ERROR", `School returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
      }
      if (!response.headers.get("content-type")?.includes("json")) {
        throw new ServiceError("UPSTREAM_FORMAT_ERROR", "School returned a non-JSON response.");
      }
      if (Number(response.headers.get("content-length")) > 5_000_000) {
        throw new ServiceError("RESPONSE_TOO_LARGE", "Narrow the query to reduce the school response.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ServiceError("UPSTREAM_FORMAT_ERROR", "School returned an empty response.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 5_000_000) {
          await reader.cancel();
          throw new ServiceError("RESPONSE_TOO_LARGE", "Narrow the query to reduce the school response.");
        }
        chunks.push(value);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        throw new ServiceError("UPSTREAM_FORMAT_ERROR", "School returned invalid JSON.");
      }
      const result = envelopeSchema.safeParse(parsed);
      if (!result.success) throw new ServiceError("UPSTREAM_FORMAT_ERROR", "School response has no valid business status.");
      if (AUTH_STATES.has(result.data.state)) {
        throw new ServiceError("SESSION_EXPIRED", "School login is required. Run npm run session:login.");
      }
      if (result.data.state !== 0) {
        throw new ServiceError("UPSTREAM_BUSINESS_ERROR", `School rejected the request (state ${result.data.state}).`);
      }
      return result.data.data;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (controller.signal.aborted) throw new ServiceError("UPSTREAM_TIMEOUT", "School request timed out.", true);
      throw new ServiceError("UPSTREAM_UNAVAILABLE", "School request failed or returned invalid cookies.", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getCaptcha(): Promise<string | null> {
    const data = await this.request("/api/MemberShip/GetStudentCaptchaForLogin");
    if (data === null || data === "") return null;
    if (typeof data !== "string" || !/^data:image\/(?:png|jpeg|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(data)) {
      throw new ServiceError("CAPTCHA_FORMAT_ERROR", "School returned an unsupported captcha format.");
    }
    return data;
  }

  async login(credentials: Credentials, captcha?: string, captchaChecked = false): Promise<void> {
    const validated = credentialsSchema.parse(credentials);
    if (!captchaChecked && !captcha && await this.getCaptcha()) {
      throw new ServiceError("CAPTCHA_REQUIRED", "School requires a captcha. Run npm run session:login interactively.");
    }
    await this.request("/api/MemberShip/Login", { captcha: captcha ?? "" }, passwordPayload(validated));
    this.invalidate();
    await this.readProfile(validated.name);
  }

  private invalidate() {
    this.cache.clear();
    this.profile = undefined;
    this.profileExpires = 0;
  }

  private async readProfile(expectedLogin?: string) {
    const result = profileSchema.safeParse(await this.request("/api/MemberShip/GetCurrentStudentInfo"));
    if (!result.success) {
      throw new ServiceError("IDENTITY_UNVERIFIED", "School did not return a valid student identity.");
    }
    if (expectedLogin && result.data.loginName !== expectedLogin) {
      throw new ServiceError("IDENTITY_MISMATCH", "The authenticated login name does not match the requested account.");
    }
    this.session.pin(result.data.loginName);
    this.profile = result.data;
    this.profileExpires = Date.now() + Math.min(this.config.cacheTtlMs, 60_000);
    return result.data;
  }

  private async renewSession() {
    if (!this.refresh) {
      if (Date.now() < this.nextLoginAttempt) {
        throw new ServiceError("LOGIN_RETRY_BLOCKED", "Automatic login failed. Rebind the account or wait five minutes before another attempt.");
      }
      this.refresh = (async () => {
        this.nextLoginAttempt = Date.now() + 300_000;
        this.invalidate();
        const raw = readJson<unknown>(this.config.credentialsFile);
        if (!raw) throw new ServiceError("SESSION_EXPIRED", "School login is required. Run npm run session:login.");
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) throw new ServiceError("CREDENTIALS_INVALID", "The local school credentials file is invalid.");
        if (this.session.loginName && this.session.loginName !== parsed.data.name) {
          throw new ServiceError("IDENTITY_MISMATCH", "Saved credentials belong to another school account.");
        }
        await this.login(parsed.data);
        this.nextLoginAttempt = 0;
      })().finally(() => { this.refresh = undefined; });
    }
    await this.refresh;
  }

  private reload() {
    this.session.reload();
    if (this.sessionRevision !== this.session.revision) {
      this.invalidate();
      this.sessionRevision = this.session.revision;
      this.nextLoginAttempt = 0;
    }
  }

  async getProfile(): Promise<Record<string, unknown>> {
    this.reload();
    if (this.profile && this.profileExpires > Date.now()) return this.profile;
    try { return await this.readProfile(); } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== "SESSION_EXPIRED") throw error;
      await this.renewSession();
      return this.profile!;
    }
  }

  async query(path: string, params: Query = {}, body?: unknown): Promise<unknown> {
    if (writePaths.has(path)) throw new ServiceError("INVALID_ENDPOINT", "Use the explicit school write operation for this endpoint.");
    await this.getProfile();
    const key = JSON.stringify([this.session.loginName, path, params, body]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.data);
    let data: unknown;
    try { data = await this.request(path, params, body); } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== "SESSION_EXPIRED") throw error;
      await this.renewSession();
      data = await this.request(path, params, body);
    }
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + this.config.cacheTtlMs, data: structuredClone(data) });
    return data;
  }

  async fresh(path: string, params: Query = {}) {
    this.cache.clear();
    return this.query(path, params);
  }

  async mutate(path: string, body: unknown) {
    if (!writePaths.has(path) || body === undefined) throw new ServiceError("INVALID_ENDPOINT", "Unsupported school write endpoint.");
    await this.getProfile();
    try {
      try { return await this.request(path, {}, body); } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "SESSION_EXPIRED") throw error;
        await this.renewSession();
        return await this.request(path, {}, body);
      }
    } finally {
      this.invalidate();
    }
  }
}
