import { z } from "zod";
import { ServiceError } from "../errors.js";

export const courseSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  score: z.number().min(0).max(100).nullable(),
  excluded: z.boolean().default(false),
  weight: z.number().min(0).max(10).optional(),
  bonus: z.number().min(0).max(2).optional(),
  chineseRole: z.enum(["language", "humanities", "none"]).optional(),
});
export const gpaRulesSchema = z.object({
  high: z.array(z.string().min(1).max(100)).max(100).default(["AP", "AS", "A2", "A Level", "ALevel", "Linear Algebra"]),
  low: z.array(z.string().min(1).max(100)).max(100).default([
    "Fine Art", "IT ", "Electi", "Drama", "Chinese Painting", "Architectural", "Dance",
    "Percussion", "Vocal", "Media", "Programming", "Spanish", "Philosophy", "Skills", "Journalism", "Creative",
  ]),
  no: z.array(z.string().min(1).max(100)).max(100).default(["Homeroom"]),
  special: z.array(z.object({
    keyword: z.string().min(1).max(100), value: z.number().min(0).max(10),
  })).max(100).default([{ keyword: "Pre AP", value: 1 }, { keyword: "ultivari", value: 1.5 }]),
  combineChinese: z.boolean().default(true),
});
export type Course = z.infer<typeof courseSchema>;
export type GpaRules = z.infer<typeof gpaRulesSchema>;

export const GPA_THRESHOLDS = [
  [97, 4.3], [93, 4], [90, 3.7], [87, 3.3], [83, 3], [80, 2.7], [77, 2.3],
  [73, 2], [70, 1.7], [67, 1.3], [63, 1], [60, 0.7], [0, 0],
] as const;

export function scoreToGpa(score: number) {
  return GPA_THRESHOLDS.find(([minimum]) => score >= minimum)![1];
}

function matches(name: string, keywords: string[]) {
  return keywords.some(keyword => keyword.length < 5
    ? name.includes(keyword)
    : name.toLowerCase().includes(keyword.toLowerCase()));
}

function chineseRole(course: Course) {
  if (course.chineseRole) return course.chineseRole;
  if (!course.name.includes("Chinese") || /second langua|evel|AP/.test(course.name)) return "none";
  return /History|Humani|eogra/.test(course.name) ? "humanities" : "language";
}

export function calculateGpa(coursesInput: unknown, rulesInput: unknown = {}) {
  const courses = z.array(courseSchema).min(1).max(200).parse(coursesInput);
  const rules = gpaRulesSchema.parse(rulesInput);
  if (new Set(courses.map(course => course.id)).size !== courses.length) {
    throw new ServiceError("INVALID_CALCULATION", "Course IDs must be unique.");
  }
  const details: {
    id: string; name: string; score: number; baseGpa: number; gpa: number;
    weight: number; bonus: number; rule: string; components?: { id: string; proportion: number }[];
  }[] = [];
  const omitted: { id: string; reason: string }[] = [];
  const chinese: { course: Course; proportion: number }[] = [];
  for (const course of courses) {
    if (course.excluded || course.score === null) {
      omitted.push({ id: course.id, reason: course.excluded ? "excluded" : "ungraded" });
      continue;
    }
    const role = rules.combineChinese ? chineseRole(course) : "none";
    if (role !== "none") {
      if (course.weight !== undefined || course.bonus !== undefined) {
        throw new ServiceError("INVALID_CALCULATION", "Use chineseRole=none or disable combineChinese to override a Chinese component weight.");
      }
      chinese.push({ course, proportion: role === "language" ? 2 / 3 : 1 / 3 });
      continue;
    }
    let weight = 1;
    let bonus = 0;
    let rule = "normal";
    const special = rules.special.find(item => course.name.toLowerCase().includes(item.keyword.toLowerCase()));
    if (special) {
      weight = special.value === 1.5 ? 1 : special.value;
      bonus = special.value === 1.5 ? 0.5 : 0;
      rule = `special:${special.keyword}`;
    } else if (matches(course.name, rules.high)) {
      bonus = 0.5; rule = "high";
    } else if (matches(course.name, rules.no)) {
      weight = 0; rule = "excluded-by-keyword";
    } else if (matches(course.name, rules.low)) {
      weight = 0.5; rule = "low";
    }
    if (course.weight !== undefined || course.bonus !== undefined) {
      weight = course.weight ?? weight; bonus = course.bonus ?? bonus; rule = "explicit";
    }
    const baseGpa = scoreToGpa(course.score);
    const appliedBonus = baseGpa > 0 ? bonus : 0;
    details.push({ id: course.id, name: course.name, score: course.score, baseGpa, gpa: baseGpa + appliedBonus, weight, bonus: appliedBonus, rule });
  }
  if (chinese.length) {
    const weights = chinese.map(item => item.proportion);
    if (new Set(weights).size !== weights.length) {
      throw new ServiceError("AMBIGUOUS_CHINESE_COURSES", "More than one Chinese course has the same component role. Set chineseRole explicitly or disable combineChinese.");
    }
    const denominator = weights.reduce((sum, value) => sum + value, 0);
    const score = Number((chinese.reduce((sum, item) => sum + item.course.score! * item.proportion, 0) / denominator).toFixed(1));
    const baseGpa = scoreToGpa(score);
    details.push({
      id: "combined-chinese-culture", name: "Chinese Culture", score, baseGpa, gpa: baseGpa,
      weight: 1, bonus: 0, rule: "chinese-culture",
      components: chinese.map(item => ({ id: item.course.id, proportion: item.proportion / denominator })),
    });
  }
  const totalWeight = details.reduce((sum, course) => sum + course.weight, 0);
  const average = (key: "gpa" | "baseGpa") => totalWeight > 0
    ? details.reduce((sum, course) => sum + course[key] * course.weight, 0) / totalWeight
    : null;
  return {
    source: "local_calculation", official: false,
    weightedGpa: average("gpa"), unweightedGpa: average("baseGpa"), totalWeight,
    courses: details, omitted, rules, thresholds: GPA_THRESHOLDS,
    assumptions: [
      "Input course scores are percentages. Results use the supplied scores, names, and rules.",
      "Unweighted GPA removes bonuses but retains each course's averaging weight.",
      "Chinese Culture normalizes available component weights and rounds its score to one decimal.",
    ],
  };
}
