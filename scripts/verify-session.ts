import { loadConfig } from "../src/config.js";
import { SchoolisClient } from "../src/schoolis/client.js";
import { fail } from "./shared.js";

try {
  const client = new SchoolisClient(loadConfig());
  await client.getProfile();
  const semesters = await client.query("/api/School/GetSchoolSemesters");
  if (!Array.isArray(semesters) || semesters.length === 0) throw new Error("School did not return a non-empty semester list.");
  console.info(JSON.stringify({ identityVerified: true, semesterCount: semesters.length, businessQueryVerified: true }));
} catch (error) { fail(error); }
