import { z } from "zod";
import { ServiceError } from "../errors.js";

const identifier = z.string().min(1).max(100);
export const taskSchema = z.object({
  id: identifier,
  score: z.number().min(0).nullable(),
  totalScore: z.number().positive(),
});
export type GradeCategory = {
  id: string; name: string; weight: number; score?: number | null;
  tasks: z.infer<typeof taskSchema>[]; children: GradeCategory[];
};
export const categorySchema: z.ZodType<GradeCategory> = z.lazy(() => z.object({
  id: identifier, name: z.string().min(1).max(200), weight: z.number().min(0).max(100),
  score: z.number().min(0).max(100).nullable().optional(),
  tasks: z.array(taskSchema).max(500).default([]),
  children: z.array(categorySchema).max(50).default([]),
}));
export const changeSchema = z.object({
  categoryId: identifier,
  taskId: identifier,
  action: z.enum(["add", "replace", "remove"]),
  score: z.number().min(0).optional(),
  totalScore: z.number().positive().optional(),
});
type Change = z.infer<typeof changeSchema>;

function indexCategories(categories: GradeCategory[]) {
  const index = new Map<string, GradeCategory>();
  let count = 0;
  const visit = (list: GradeCategory[], depth: number) => {
    if (depth > 8) throw new ServiceError("INVALID_CALCULATION", "Grade categories exceed eight levels.");
    for (const category of list) {
      if (index.has(category.id) || ++count > 200) {
        throw new ServiceError("INVALID_CALCULATION", "Category IDs must be unique; at most 200 categories are allowed.");
      }
      index.set(category.id, category);
      if (new Set(category.tasks.map(task => task.id)).size !== category.tasks.length) {
        throw new ServiceError("INVALID_CALCULATION", "Task IDs must be unique within each category.");
      }
      visit(category.children, depth + 1);
    }
  };
  visit(categories, 0);
  return index;
}

function summarize(categories: GradeCategory[]): { score: number | null; weight: number; categories: unknown[] } {
  const details = categories.map(category => {
    const children = category.children.length ? summarize(category.children) : undefined;
    const tasks = category.tasks.filter(task => task.score !== null);
    const score = children ? children.score : tasks.length
      ? tasks.reduce((sum, task) => sum + Math.min(task.score! / task.totalScore, 1) * 100, 0) / tasks.length
      : category.tasks.length ? null : category.score ?? null;
    return { id: category.id, name: category.name, weight: category.weight, score, gradedTaskCount: tasks.length, children: children?.categories };
  });
  const active = details.filter(category => category.score !== null && category.weight > 0);
  const weight = active.reduce((sum, category) => sum + category.weight, 0);
  return {
    score: weight ? active.reduce((sum, category) => sum + category.score! * category.weight, 0) / weight : null,
    weight, categories: details,
  };
}

export function simulateGrades(categoriesInput: unknown, changesInput: unknown = []) {
  const categories = z.array(categorySchema).min(1).max(50).parse(categoriesInput);
  const changes = z.array(changeSchema).max(200).parse(changesInput);
  const index = indexCategories(categories);
  const baseline = summarize(categories);
  const touched = new Set<string>();
  for (const change of changes) {
    const category = index.get(change.categoryId);
    if (!category || category.children.length) {
      throw new ServiceError("INVALID_SCENARIO", "Each change must reference an existing leaf category.");
    }
    const key = JSON.stringify([change.categoryId, change.taskId]);
    if (touched.has(key)) throw new ServiceError("INVALID_SCENARIO", "Each scenario may change a task only once.");
    touched.add(key);
    if (!category.tasks.length && category.score != null) {
      throw new ServiceError("INSUFFICIENT_GRADE_DETAIL", "Task details are required to modify a category with an aggregate score.");
    }
    applyChange(category, change);
    // An emptied category becomes ungraded; never reuse its old aggregate.
    category.score = null;
  }
  const predicted = summarize(categories);
  return {
    source: "local_simulation", official: false, baseline, predicted, changes,
    delta: baseline.score !== null && predicted.score !== null ? predicted.score - baseline.score : null,
    assumptions: [
      "Tasks within a leaf category have equal weight after conversion to percentages.",
      "Task scores are capped at 100 percent. Ungraded tasks are excluded.",
      "Categories with grades are normalized by their active weights.",
      "Composite categories use child weights; parent task copies are excluded.",
      "Aggregate scores can describe a baseline but cannot be edited without task details.",
    ],
  };
}

function applyChange(category: GradeCategory, change: Change) {
  const position = category.tasks.findIndex(task => task.id === change.taskId);
  if (change.action === "remove") {
    if (position < 0) throw new ServiceError("INVALID_SCENARIO", "The task to remove does not exist.");
    category.tasks.splice(position, 1);
    return;
  }
  if ((change.action === "add") === (position >= 0)) {
    throw new ServiceError("INVALID_SCENARIO", "Add requires a new task ID; replace requires an existing task ID.");
  }
  const score = change.score;
  const totalScore = change.totalScore ?? (position >= 0 ? category.tasks[position]!.totalScore : undefined);
  if (score === undefined || totalScore === undefined || score > totalScore) {
    throw new ServiceError("INVALID_SCENARIO", "Provide a score between zero and the task's positive totalScore.");
  }
  const task = { id: change.taskId, score, totalScore };
  if (change.action === "add") category.tasks.push(task);
  else category.tasks[position] = task;
}
