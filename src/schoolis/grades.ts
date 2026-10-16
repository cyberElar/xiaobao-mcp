import { z } from "zod";
import { ServiceError } from "../errors.js";
import { categorySchema, type GradeCategory } from "../grades/simulation.js";
import type { Course } from "../grades/gpa.js";

const record = z.record(z.string(), z.unknown());

function percentage(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new ServiceError("UNSUPPORTED_GRADE_FORMAT", "A school grade is not a percentage between zero and 100.");
  }
  return number;
}

export function semesterCourses(input: unknown): Course[] {
  const data = record.parse(input);
  if (!Array.isArray(data.studentSemesterDynamicScoreBasicDtos)) {
    throw new ServiceError("UNSUPPORTED_GRADE_FORMAT", "School did not return the expected semester course list.");
  }
  return data.studentSemesterDynamicScoreBasicDtos.map(raw => {
    const course = record.parse(raw);
    const id = course.subjectId;
    const name = course.subjectName;
    if (id == null || typeof name !== "string" || !name) {
      throw new ServiceError("UNSUPPORTED_GRADE_FORMAT", "School returned a course without a subject ID or name.");
    }
    return {
      id: `${String(id)}:${String(course.classId ?? "unknown")}`, name,
      score: course.scoreIsNull === true ? null : percentage(course.subjectScore),
      excluded: course.isInGrade === false,
    };
  });
}

export function gradeCategories(input: unknown): GradeCategory[] {
  const data = record.parse(input);
  const convert = (value: unknown, depth: number): GradeCategory[] => {
    if (!Array.isArray(value) || depth > 8) {
      throw new ServiceError("UNSUPPORTED_GRADE_FORMAT", "School returned an invalid grade category tree.");
    }
    return value.map(raw => {
      const item = record.parse(raw);
      const tasks = Array.isArray(item.learningTaskAndExamList) ? item.learningTaskAndExamList : [];
      return categorySchema.parse({
        id: String(item.evaluationProjectId ?? item.code ?? ""),
        name: item.evaluationProjectName,
        weight: Number(item.proportion),
        score: item.scoreIsNull === true ? null : percentage(item.score),
        children: convert(item.evaluationProjectList ?? [], depth + 1),
        tasks: tasks.map(rawTask => {
          const task = record.parse(rawTask);
          if (task.id == null) throw new ServiceError("UNSUPPORTED_GRADE_FORMAT", "A school grade task has no ID.");
          return {
            id: `${String(task.type ?? "task")}:${String(task.id)}`,
            score: task.score == null ? null : Number(task.score),
            totalScore: Number(task.totalScore),
          };
        }),
      });
    });
  };
  return convert(data.evaluationProjectList, 0);
}
