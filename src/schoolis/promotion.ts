import { z } from "zod";
import { ServiceError } from "../errors.js";
import type { SchoolisClient } from "./client.js";

const promotionSchema = z.object({
  studentPromotionId: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]),
  unfinishedCount: z.number().int().nonnegative(),
});

export async function promotionStatus(client: SchoolisClient) {
  const data = promotionSchema.parse(await client.query("/api/StudyAbroad/GetStudentPromotionIdByStudentId"));
  const studentPromotionId = String(data.studentPromotionId);
  const available = !/^0+$/.test(studentPromotionId);
  return {
    available,
    studentPromotionId: available ? studentPromotionId : null,
    unfinishedCount: available
      ? z.number().int().nonnegative().parse(await client.query("/api/StudyAbroad/GetPromotionTaskUnfinishedCount", { studentPromotionId }))
      : data.unfinishedCount,
    ...(available ? {} : { reason: "The authenticated student has no promotion record." }),
  };
}

export async function ownPromotionId(client: SchoolisClient) {
  const data = promotionSchema.parse(await client.query("/api/StudyAbroad/GetStudentPromotionIdByStudentId"));
  const id = String(data.studentPromotionId);
  if (/^0+$/.test(id)) {
    throw new ServiceError("FEATURE_UNAVAILABLE", "The authenticated student has no promotion record.");
  }
  return id;
}
