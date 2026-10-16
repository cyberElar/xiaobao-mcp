import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceError } from "../errors.js";
import { result, toolMetadata } from "../tool-result.js";
import type { MicrosoftClient } from "./client.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const page = {
  pageSize: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(32_768).optional(),
};
const assignment = { classId: id, assignmentId: id };
const official = (data: unknown) => ({ source: "microsoft_graph", official: true, data });
const classPath = (classId: string) => `/v1.0/education/classes/${classId}/assignments`;
const assignmentPath = (classId: string, assignmentId: string) => `${classPath(classId)}/${assignmentId}`;

export function registerMicrosoftTools(server: McpServer, microsoft?: MicrosoftClient) {
  const client = () => {
    if (!microsoft) throw new ServiceError("MICROSOFT_NOT_CONNECTED", "Bind Microsoft first with npm run microsoft:login.");
    return microsoft;
  };
  server.registerTool("get_microsoft_profile", {
    ...toolMetadata, description: "Read the independently bound Microsoft account identity. Microsoft and Schoolis accounts are separate bindings. Never returns Microsoft tokens.",
    inputSchema: {},
  }, () => result(async () => official(await client().getProfile())));
  server.registerTool("list_teams_classes", {
    ...toolMetadata, description: "Read one page of the bound Microsoft account's education classes. Follow returned cursors without changing pageSize.",
    inputSchema: page,
  }, input => result(async () => ({
    source: "microsoft_graph", official: true,
    ...await client().page("/v1.0/education/me/classes", { $top: String(input.pageSize) }, input.cursor),
  })));
  server.registerTool("list_teams_assignments", {
    ...toolMetadata, description: "Read one page of Teams assignments for a class, including instructions and original due times. There is no implicit 14-day filter. Follow returned cursors with the same classId and pageSize.",
    inputSchema: { classId: id, ...page },
  }, input => result(async () => ({
    source: "microsoft_graph", official: true,
    ...await client().page(classPath(input.classId), { $top: String(input.pageSize) }, input.cursor),
  })));
  server.registerTool("get_teams_assignment_detail", {
    ...toolMetadata, description: "Read a Teams assignment using original Graph class and assignment IDs. Resource links are metadata; this tool does not download SharePoint files.",
    inputSchema: assignment,
  }, input => result(async () => official(await client().query(assignmentPath(input.classId, input.assignmentId)))));
  server.registerTool("list_teams_submissions", {
    ...toolMetadata, description: "Read one page of submissions for a Teams assignment, returning only submissions whose recipient is the bound Microsoft account. Empty pages may still have a next cursor.",
    inputSchema: { ...assignment, ...page },
  }, input => result(async () => ({
    source: "microsoft_graph", official: true,
    ...await client().ownSubmissions(`${assignmentPath(input.classId, input.assignmentId)}/submissions`, { $top: String(input.pageSize) }, input.cursor),
  })));
  server.registerTool("get_teams_submission_outcomes", {
    ...toolMetadata, description: "Read published grades, feedback and rubric results for the bound account's own submission. Ownership is checked before reading outcomes. Draft score and feedback fields are omitted.",
    inputSchema: { ...assignment, submissionId: id, ...page },
  }, input => result(async () => ({
    source: "microsoft_graph", official: true,
    ...await client().publishedOutcomes(`${assignmentPath(input.classId, input.assignmentId)}/submissions/${input.submissionId}`, { $top: String(input.pageSize) }, input.cursor),
  })));
  server.registerTool("get_outlook_calendar", {
    ...toolMetadata, description: "Read one page of the bound Microsoft account's primary calendar, including recurring occurrences, for up to 31 days. Start/end require ISO 8601 timestamps with an explicit offset. Response times use UTC. Follow cursors with unchanged dates and pageSize.",
    inputSchema: { startDateTime: z.iso.datetime({ offset: true }), endDateTime: z.iso.datetime({ offset: true }), ...page },
  }, input => result(async () => {
    const days = (Date.parse(input.endDateTime) - Date.parse(input.startDateTime)) / 86400_000;
    if (days <= 0 || days > 31) throw new ServiceError("INVALID_DATE_RANGE", "Use an ordered Outlook time range no longer than 31 days.");
    return {
      source: "microsoft_graph", official: true,
      ...await client().page("/v1.0/me/calendarView", {
        startDateTime: input.startDateTime, endDateTime: input.endDateTime, $top: String(input.pageSize),
        $select: "id,subject,start,end,location,isAllDay,isCancelled,webLink,bodyPreview",
      }, input.cursor),
    };
  }));
}
