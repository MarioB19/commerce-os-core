import "server-only";
import rawActivities from "@/data/activities.json";
import type { Activity } from "@/lib/activity-types";

export const activities = rawActivities as Activity[];

export const grades = [...new Set(activities.map(({ grado }) => grado))].sort((a, b) => a.localeCompare(b, "es"));
export const fields = [...new Set(activities.map(({ campo }) => campo))].sort((a, b) => a.localeCompare(b, "es"));
