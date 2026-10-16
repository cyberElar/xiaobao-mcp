import assert from "node:assert/strict";
import test from "node:test";
import { calculateGpa, scoreToGpa, GPA_THRESHOLDS } from "../src/grades/gpa.js";
import { simulateGrades } from "../src/grades/simulation.js";
import { gradeCategories, semesterCourses } from "../src/schoolis/grades.js";

test("GPA boundaries retain half-open bands and never award a bonus for a failing grade", () => {
  for (const [minimum, gpa] of GPA_THRESHOLDS) assert.equal(scoreToGpa(minimum), gpa);
  assert.equal(scoreToGpa(96.999), 4);
  const result = calculateGpa([
    { id: "ap", name: "AP Physics", score: 97 },
    { id: "pre-ap", name: "Pre AP Chemistry", score: 97 },
    { id: "fail", name: "AP Biology", score: 59 },
    { id: "art", name: "Fine Art", score: 93 },
    { id: "home", name: "Homeroom", score: 100 },
    { id: "missing", name: "Mathematics", score: null },
  ]);
  assert.equal(result.totalWeight, 3.5);
  assert.equal(result.courses.find(course => course.id === "fail")!.gpa, 0);
  assert.equal(result.courses.find(course => course.id === "pre-ap")!.gpa, 4.3);
  assert.equal(result.weightedGpa, (4.8 + 4.3 + 2) / 3.5);
  assert.equal(result.unweightedGpa, (4.3 + 4.3 + 2) / 3.5);
  assert.deepEqual(result.omitted, [{ id: "missing", reason: "ungraded" }]);
});

test("Chinese Culture combines scores before GPA conversion and detects ambiguous components", () => {
  const courses = [
    { id: "chinese", name: "Chinese Language", score: 96 },
    { id: "history", name: "Chinese History", score: 90 },
  ];
  const result = calculateGpa(courses);
  assert.equal(result.courses.length, 1);
  assert.equal(result.courses[0]!.score, 94);
  assert.equal(result.weightedGpa, 4);
  assert.equal(calculateGpa([courses[0]]).courses[0]!.score, 96);
  assert.throws(() => calculateGpa([...courses, { id: "chinese-2", name: "Chinese Literature", score: 90 }]), /same component role/);
  assert.equal(calculateGpa(courses, { combineChinese: false }).courses.length, 2);
  assert.equal(calculateGpa([{ ...courses[0], excluded: true }]).weightedGpa, null);
});

test("scenarios normalize active categories and nested weights without counting parent task copies", () => {
  const categories = [{
    id: "compound", name: "Compound", weight: 60,
    tasks: [{ id: "duplicate", score: 100, totalScore: 100 }],
    children: [
      { id: "a", name: "A", weight: 1, tasks: [{ id: "duplicate", score: 100, totalScore: 100 }] },
      { id: "b", name: "B", weight: 2, tasks: [{ id: "b1", score: 0, totalScore: 50 }, { id: "pending", score: null, totalScore: 100 }] },
    ],
  }, { id: "empty", name: "Ungraded", weight: 40 }];
  const snapshot = structuredClone(categories);
  const result = simulateGrades(categories, [{ categoryId: "b", taskId: "b1", action: "replace", score: 50 }]);
  assert.equal(result.baseline.score, 100 / 3);
  assert.equal(result.predicted.score, 100);
  assert.deepEqual(categories, snapshot);
  const removed = simulateGrades([{ id: "a", name: "A", weight: 1, score: 80, tasks: [{ id: "last", score: 80, totalScore: 100 }] }],
    [{ categoryId: "a", taskId: "last", action: "remove" }]);
  assert.equal(removed.predicted.score, null);
});

test("scenarios refuse aggregate-only edits, duplicate IDs, nonexistent tasks, and out-of-range scores", () => {
  const category = { id: "a", name: "A", weight: 1, score: 80 };
  assert.throws(() => simulateGrades([category], [{ categoryId: "a", taskId: "new", action: "add", score: 100, totalScore: 100 }]), /Task details/);
  assert.throws(() => simulateGrades([category, category]), /Category IDs must be unique/);
  const complete = { ...category, tasks: [{ id: "task", score: 80, totalScore: 100 }] };
  assert.throws(() => simulateGrades([complete], [{ categoryId: "a", taskId: "missing", action: "replace", score: 100 }]), /existing task ID/);
  assert.throws(() => simulateGrades([complete], [{ categoryId: "a", taskId: "task", action: "replace", score: 101 }]), /between zero/);
});

test("school grade adapters preserve null grades, class identity, and task kinds", () => {
  const courses = semesterCourses({ studentSemesterDynamicScoreBasicDtos: [
    { subjectId: 1, classId: 10, subjectName: "Math", subjectScore: null },
    { subjectId: 1, classId: 11, subjectName: "Math", subjectScore: "90", isInGrade: false },
  ] });
  assert.equal(courses[0]!.score, null);
  assert.equal(courses[1]!.excluded, true);
  assert.notEqual(courses[0]!.id, courses[1]!.id);
  assert.throws(() => semesterCourses({}), /expected semester course list/);
  const categories = gradeCategories({ evaluationProjectList: [{
    evaluationProjectId: 1, evaluationProjectName: "Tests", proportion: 100, score: 0, scoreIsNull: true,
    learningTaskAndExamList: [
      { id: 5, type: 1, score: null, totalScore: 100 },
      { id: 5, type: 2, score: 0, totalScore: 100 },
    ],
  }] });
  assert.equal(categories[0]!.score, null);
  assert.deepEqual(categories[0]!.tasks.map(task => task.id), ["1:5", "2:5"]);
});
