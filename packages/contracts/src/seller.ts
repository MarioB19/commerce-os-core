import { z } from "zod";
const text = z.string().trim().max(4000);
export const knowledgeSourceSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    topic: z.enum([
      "description",
      "audience",
      "contents",
      "requirements",
      "faq",
      "objection",
      "policy",
    ]),
    title: z.string().trim().min(1).max(160),
    content: text.min(1),
    source: z.string().trim().min(1).max(500),
  })
  .strict();
export const knowledgeSchema = z
  .array(knowledgeSourceSchema)
  .max(40)
  .refine(
    (items) => new Set(items.map((s) => s.id)).size === items.length,
    "Identificadores de fuente repetidos.",
  );
export const categorySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    knowledge: knowledgeSchema.default([]),
  })
  .strict();
export const editorSchema = z
  .object({
    schema_version: z.literal(1),
    positions: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      z
        .object({
          x: z.number().finite().min(-100000).max(100000),
          y: z.number().finite().min(-100000).max(100000),
        })
        .strict(),
    ),
    labels: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      z.string().trim().max(160),
    ),
  })
  .strict();
export const sellerStyleSchema = z
  .object({
    language: text.default("Español"),
    tone: text.default("Claro, amable y breve"),
    length: z.enum(["brief", "balanced"]).default("brief"),
    goal: text.default("Ayudar a elegir la oferta con información comprobable"),
    examples: text.default(""),
    handoff: text.default(
      "Pedir ayuda si falta una fuente, hay conflicto o se solicita una persona.",
    ),
  })
  .strict();
