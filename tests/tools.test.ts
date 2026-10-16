import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { SchoolisClient } from "../src/schoolis/client.js";
import { createMcpServer } from "../src/tools.js";
import { fixture } from "./helpers.js";

async function tools(t: TestContext, responder: (url: URL, body: Record<string, unknown> | undefined) => unknown) {
  const { config } = fixture(t);
  const requests: { url: URL; body: Record<string, unknown> | undefined; method: string | undefined }[] = [];
  const school = new SchoolisClient(config, async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, body, method: init?.method });
    const data = url.pathname.endsWith("GetCurrentStudentInfo") ? { loginName: "student" } : responder(url, body);
    return Response.json({ state: 0, data });
  });
  const server = createMcpServer(school);
  const client = new Client({ name: "school-tools-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(() => client.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    requests,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      return { ...result, data: result.structuredContent as Record<string, any> };
    },
  };
}

test("statistics use view-specific options, dotted pagination and distinct assignment/exam date filters", async t => {
  const { call, requests } = await tools(t, url => /GetStatistics$|GetList$/.test(url.pathname)
    ? { list: [{ id: 7 }], totalCount: 3 }
    : [{ id: 8 }]);
  for (const [kind, area, type] of [["assignment", "LearningTask", "LearningTask"], ["exam", "Exam", "Exam"]]) {
    for (const purpose of ["list", "statistics"]) {
      const options = await call(`get_${kind}_options`, { semesterId: 5, purpose });
      assert.equal(options.isError, undefined);
      assert.deepEqual(options.data.data.subjects, [{ id: 8 }]);
      const suffix = purpose === "list" ? "ForSelect" : "ForStatisticsSelect";
      assert.ok(requests.some(item => item.url.pathname === `/api/${area}/GetStu${type}TypeList${suffix}`));
      assert.ok(requests.some(item => item.url.pathname === `/api/${area}/GetStuSubjectList${suffix}`));
    }
    const response = await call(`get_${kind}_statistics`, {
      semesterId: 5, subjectId: 8, beginTime: "2026-10-01", endTime: "2026-10-15", pageSize: 1, pageIndex: 2,
    });
    assert.equal(response.isError, undefined);
    assert.equal(response.data.pagination.hasMore, true);
    const query = requests.at(-1)!.url.searchParams;
    assert.equal(query.get("schoolSemesterId"), "5");
    assert.equal(query.get("subjectId"), "8");
    assert.equal(query.get("page.pageIndex"), "2");
    assert.equal(query.get("page.pageSize"), "1");
    assert.equal(query.get(kind === "assignment" ? "beginDate" : "beginTime"), "2026-10-01");
    assert.equal(query.get(kind === "assignment" ? "learningTaskTypeId" : "examTypeId"), "null");
    assert.equal(query.has("page"), false);
    const filtered = await call(`list_${kind === "assignment" ? "assignments" : "exams"}`, {
      semesterId: 5, typeId: 8, beginTime: "2026-10-01", endTime: "2026-10-15",
    });
    assert.equal(filtered.isError, undefined);
    assert.equal(requests.at(-1)!.url.searchParams.get("typeId"), "8");
  }
  const invalid = await call("get_assignment_statistics", {
    semesterId: 5, subjectId: 8, beginTime: "2026-10-15", endTime: "2026-10-01",
  });
  assert.equal(invalid.data.error.code, "INVALID_DATE_RANGE");
});

test("grade settings preserve false flags and school features expose only boolean org configuration", async t => {
  const { call } = await tools(t, url => {
    if (url.pathname.endsWith("ListGpaSettings")) return { useDynamicGPA: false };
    if (url.pathname.endsWith("GetCurrentOrgConfigByOrg")) return { turnOnStudentResources: true, privateUrl: "private", password: "private", id: 123 };
    if (url.pathname.endsWith("ListUsedQuestionnaireTypes")) return [];
    return false;
  });
  const settings = await call("get_grade_settings", { semesterId: 5 });
  assert.deepEqual(settings.data.data, { gpaSettings: { useDynamicGPA: false }, semesterScoresArchived: false });
  const features = await call("get_school_features");
  assert.deepEqual(features.data.data, {
    orgFlags: { turnOnStudentResources: true }, hasLmsSite: false, studentFormsEnabled: false, questionnaireTypes: [],
  });
});

test("all promotion child tools stop before querying a missing own record", async t => {
  const { call, requests } = await tools(t, url => {
    assert.equal(url.pathname, "/api/StudyAbroad/GetStudentPromotionIdByStudentId");
    return { studentPromotionId: 0, unfinishedCount: 0 };
  });
  const status = await call("get_promotion_status");
  assert.equal(status.data.data.available, false);
  for (const [name, args] of [
    ["list_promotion_tasks", {}],
    ["get_promotion_task_detail", { promotionTaskId: 99 }],
    ["get_promotion_file_options", { kind: "materials" }],
    ["list_promotion_files", { kind: "documents" }],
  ] as const) {
    const response = await call(name, args);
    assert.equal(response.data.error.code, "FEATURE_UNAVAILABLE");
  }
  assert.ok(requests.every(item => item.url.pathname.endsWith("GetCurrentStudentInfo") ||
    item.url.pathname.endsWith("GetStudentPromotionIdByStudentId")));
});

test("promotion reads derive the owner record and serialize read-only POST filters without client-chosen record IDs", async t => {
  const { call, requests } = await tools(t, url => {
    if (url.pathname.endsWith("GetStudentPromotionIdByStudentId")) return { studentPromotionId: 42, unfinishedCount: 2 };
    if (url.pathname.endsWith("GetPromotionTaskUnfinishedCount")) return 2;
    if (url.pathname.endsWith("UploaderForSelect")) return [{ id: 6, accountType: 1 }];
    if (url.pathname.endsWith("GetPromotionTaskDetails")) return { id: 7, title: "Task", accessToken: "private" };
    return { list: [{ id: 7 }], totalCount: 3 };
  });
  assert.equal((await call("get_promotion_status")).data.data.unfinishedCount, 2);
  const tasks = await call("list_promotion_tasks", { taskStatus: 2, keyword: "task" });
  assert.equal(tasks.isError, undefined);
  assert.deepEqual(requests.at(-1)!.body, { studentPromotionId: "42", startTime: "", endTime: "", key: "task", taskStatus: 2 });
  assert.equal(requests.at(-1)!.method, "POST");
  const detail = await call("get_promotion_task_detail", { promotionTaskId: 7 });
  assert.deepEqual(detail.data.data, { id: 7, title: "Task" });
  assert.equal(requests.at(-1)!.url.searchParams.get("studentPromotionId"), "42");
  for (const kind of ["materials", "documents"]) {
    const options = await call("get_promotion_file_options", { kind });
    assert.deepEqual(options.data.data, [{ id: 6, accountType: 1 }]);
    const files = await call("list_promotion_files", {
      kind, pageIndex: 2, pageSize: 1, uploadUserId: 6, uploadUserType: 1,
      beginTime: "2026-10-01", endTime: "2026-10-15",
    });
    assert.equal(files.data.pagination.hasMore, true);
    assert.deepEqual(requests.at(-1)!.body, {
      studentPromotionId: "42", startTime: "2026-10-01", endTime: "2026-10-15", key: "",
      uploadUserId: "6", uploadUserType: 1, page: { pageIndex: 2, pageSize: 1 },
    });
  }
  const before = requests.length;
  assert.equal((await call("list_promotion_tasks", { beginTime: "2026-10-01" })).data.error.code, "INVALID_DATE_RANGE");
  assert.equal((await call("list_promotion_files", { kind: "materials", uploadUserId: 6 })).data.error.code, "INVALID_FILTER");
  assert.equal(requests.length, before);
});
