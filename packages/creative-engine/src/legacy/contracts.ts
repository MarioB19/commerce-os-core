import { z } from "zod";

import {
  ATTRACTION_LED_STANDARD_V1_MARKER,
  ATTRACTION_LED_STANDARD_V2_MARKER,
} from "./attraction-led-standard.js";
import { COSTURA_PACKSHOT_ANIMATION_PRESET } from "./packshot-animation.js";

export const VisualStandardMarkerSchema = z.enum([
  ATTRACTION_LED_STANDARD_V1_MARKER,
  ATTRACTION_LED_STANDARD_V2_MARKER,
]);

export const SourceReferenceSchema = z.object({
  document: z.string().min(1),
  note: z.string().min(1),
});

export const ClaimSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // Internal metadata never doubles as customer-facing copy.
  internalLabel: z.string().min(1).optional(),
  usableClaim: z.string().min(1).optional(),
  approvedDisplayText: z.string().min(1).optional(),
  displayTextSource: z.object({
    document: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    locator: z.string().min(1),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime({ offset: true }),
  }).strict().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  evidenceStatus: z.enum(["verified", "pending", "contradicted"]),
  sources: z.array(SourceReferenceSchema).min(1),
});

export const ProductionBlockStageSchema = z.enum([
  "copy",
  "preproduction",
  "render",
  "publication",
]);

export const HookVisualOriginSchema = z.enum([
  "stock",
  "internal-library",
  "magnific-generated-clip",
]);

export const NormalizedAdSchema = z.object({
  name: z.string().min(1),
  bodyId: z.string().regex(/^A0[1-6]$/),
  hookId: z.string().regex(/^h[1-3]$/),
  mecanismo: z.enum(["M1", "M2", "M3"]),
  primaryText: z.string().min(1),
  headline: z.string().min(1),
  description: z.string().min(1),
  hook: z.object({
    spokenText: z.string().min(1),
    plannedSeconds: z.number().positive().max(3),
    visualBrief: z.string().min(1),
    firstFrameMotion: z.literal(true),
    productOrUiInHook: z.literal(false),
    allowedOrigins: z.array(HookVisualOriginSchema).min(1),
    assetRequestId: z.string().min(1),
    searchQueries: z.array(z.string().min(1)).min(1),
  }),
  claimsUsed: z.array(z.string().min(1)),
});

export const CreativeSpecIdSchema = z.string().regex(/^A0[1-6]-h[1-3]$/);

export const PilotSetMemberSchema = z
  .object({
    specId: CreativeSpecIdSchema,
    creativeName: z.string().min(1),
  })
  .strict();

export const PilotMasterEvidenceSchema = z
  .object({
    specId: CreativeSpecIdSchema,
    creativeName: z.string().min(1),
    masterArtifact: z.string().min(1),
    masterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const LegacySingleGoldenProductionPlanSchema = z.object({
  // Preserve the pre-pilot contract exactly: legacy launch files have no strategy.
  strategy: z.undefined().optional(),
  goldenMaster: CreativeSpecIdSchema,
  goldenMasterCreativeName: z.string().min(1),
  scaleRequiresHumanApproval: z.literal(true),
  remainingAdsAfterApproval: z.number().int().nonnegative(),
  approval: z.discriminatedUnion("status", [
    z.object({
      status: z.enum(["pending", "rejected"]),
      approvedBy: z.null(),
      approvedAt: z.null(),
      masterArtifact: z.null(),
      masterSha256: z.null(),
    }),
    z.object({
      status: z.literal("approved"),
      approvedBy: z.string().min(1),
      approvedAt: z.string().datetime({ offset: true }),
      masterArtifact: z.string().min(1),
      masterSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ]),
});

const PilotSetProductionPlanSchema = z
  .object({
    strategy: z.literal("pilot-set"),
    pilotSet: z.array(PilotSetMemberSchema).length(3),
    scaleRequiresHumanApproval: z.literal(true),
    remainingAdsAfterApproval: z.number().int().nonnegative(),
    approval: z.discriminatedUnion("status", [
      z
        .object({
          status: z.enum(["pending", "rejected"]),
          approvedBy: z.null(),
          approvedAt: z.null(),
          masters: z.array(PilotMasterEvidenceSchema).length(0),
        })
        .strict(),
      z
        .object({
          status: z.literal("approved"),
          approvedBy: z.string().min(1),
          approvedAt: z.string().datetime({ offset: true }),
          masters: z.array(PilotMasterEvidenceSchema).min(1),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((plan, context) => {
    const bodyIds = new Set(
      plan.pilotSet.map((member) => member.specId.slice(0, 3)),
    );
    const hookIds = new Set(
      plan.pilotSet.map((member) => member.specId.slice(4)),
    );
    if (
      bodyIds.size !== 1 ||
      hookIds.size !== 3 ||
      !["h1", "h2", "h3"].every((hookId) => hookIds.has(hookId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pilotSet"],
        message: "El pilot set debe contener h1, h2 y h3 de un mismo ángulo.",
      });
    }
    if (plan.approval.status !== "approved") return;
    const approvedIds = new Set(
      plan.approval.masters.map((master) => master.specId),
    );
    const approvedPaths = new Set(
      plan.approval.masters.map((master) => master.masterArtifact),
    );
    const approvedHashes = new Set(
      plan.approval.masters.map((master) => master.masterSha256),
    );
    if (
      approvedIds.size !== plan.approval.masters.length ||
      approvedPaths.size !== plan.approval.masters.length ||
      approvedHashes.size !== plan.approval.masters.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval", "masters"],
        message: "Cada master aprobado debe tener spec, ruta y SHA-256 únicos.",
      });
    }
  });

export const ProductionPlanSchema = z.union([
  PilotSetProductionPlanSchema,
  LegacySingleGoldenProductionPlanSchema,
]);

export const BriefSchema = z.object({
  excludedClaims: z.array(z.string()).optional(),
  intakeReceipt: z.string().min(1).optional(),
  forwardProductionRules: z.record(z.string(), z.unknown()).optional(),
  productionCorrections: z.array(z.record(z.string(), z.unknown())).optional(),
  schemaVersion: z.literal(2).optional(),
  launchId: z.string().min(1),
  offerVersion: z.string().min(1).optional(),
  productName: z.string().min(1),
  platform: z.enum(["meta-ctwa", "meta-landing"]),
  locale: z.string().min(1),
  expectedCta: z.string().min(1),
  ctaAlternatives: z.array(z.string()),
  visualStandard: VisualStandardMarkerSchema.optional(),
  claims: z.array(ClaimSchema),
  unresolvedConflicts: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      severity: z.enum(["warning", "error"]),
      blocks: z.array(ProductionBlockStageSchema).min(1).optional(),
    }),
  ),
  creativeMatrix: z.object({
    bodies: z.number().int().positive(),
    hooksPerBody: z.number().int().positive(),
    totalAds: z.number().int().positive(),
  }),
  productionScope: z.object({
    mode: z.enum(["vertical-slice", "full-matrix"]),
    bodyIds: z.array(z.string().min(1)).min(1),
    expectedSpecs: z.number().int().positive(),
  }),
  output: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    codec: z.literal("h264"),
    audioCodec: z.literal("aac"),
    minimumSeconds: z.number().positive(),
    maximumSeconds: z.number().positive(),
    targetSeconds: z.number().positive(),
  }),
  sourceOfTruth: z
    .object({
      config: z.string().min(1),
      productEvidence: z.string().min(1),
      creativeDocument: z.string().min(1),
    })
    .optional(),
  creativePolicy: z
    .object({
      id: z.string().min(1),
      visualStandard: VisualStandardMarkerSchema,
      format: z.enum([
        "faceless-narrative",
        "faceless-product-demo",
        "avatar-hybrid",
      ]),
    })
    .optional(),
  productionPlan: ProductionPlanSchema.optional(),
  ads: z.array(NormalizedAdSchema).optional(),
}).superRefine((brief, context) => {
  if (brief.visualStandard !== ATTRACTION_LED_STANDARD_V2_MARKER) return;
  if (brief.schemaVersion !== 2) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: "El estándar attraction-led v2 exige schemaVersion 2.",
    });
  }
  if (!brief.ads || brief.ads.length !== brief.creativeMatrix.totalAds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ads"],
      message: "El brief v2 debe conservar el contrato normalizado de todos los anuncios.",
    });
  }
  if (!brief.productionPlan) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["productionPlan"],
      message: "El brief v2 debe declarar el golden master y su aprobación auditable.",
    });
  } else if (brief.productionPlan.strategy === "pilot-set") {
    const plan = brief.productionPlan;
    const pilotIds = new Set(plan.pilotSet.map((member) => member.specId));
    const pilotNames = new Set(plan.pilotSet.map((member) => member.creativeName));
    const pilotBodyIds = new Set(
      plan.pilotSet.map((member) => member.specId.slice(0, 3)),
    );
    const pilotHookIds = new Set(
      plan.pilotSet.map((member) => member.specId.slice(4)),
    );
    if (pilotIds.size !== plan.pilotSet.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productionPlan", "pilotSet"],
        message: "Cada spec del pilot set debe aparecer exactamente una vez.",
      });
    }
    if (pilotNames.size !== plan.pilotSet.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productionPlan", "pilotSet"],
        message: "Cada nombre creativo del pilot set debe ser único.",
      });
    }
    if (
      pilotBodyIds.size !== 1 ||
      pilotHookIds.size !== 3 ||
      !["h1", "h2", "h3"].every((hookId) => pilotHookIds.has(hookId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productionPlan", "pilotSet"],
        message: "El pilot set debe contener h1, h2 y h3 de un mismo ángulo.",
      });
    }
    if (
      plan.remainingAdsAfterApproval !==
      brief.creativeMatrix.totalAds - plan.pilotSet.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productionPlan", "remainingAdsAfterApproval"],
        message: "El lote restante debe ser exactamente el total de anuncios menos el pilot set.",
      });
    }
    if (plan.approval.status === "approved") {
      const approvedIds = new Set(plan.approval.masters.map((master) => master.specId));
      const approvedPaths = new Set(
        plan.approval.masters.map((master) => master.masterArtifact),
      );
      const approvedHashes = new Set(
        plan.approval.masters.map((master) => master.masterSha256),
      );
      if (
        approvedIds.size !== plan.approval.masters.length ||
        approvedPaths.size !== plan.approval.masters.length ||
        approvedHashes.size !== plan.approval.masters.length ||
        plan.approval.masters.length !== plan.pilotSet.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["productionPlan", "approval", "masters"],
          message: "La aprobación conjunta debe contener spec, ruta y SHA-256 únicos por cada master piloto.",
        });
      }
      const pilotNamesById = new Map(
        plan.pilotSet.map((member) => [member.specId, member.creativeName]),
      );
      for (const master of plan.approval.masters) {
        if (pilotNamesById.get(master.specId) !== master.creativeName) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["productionPlan", "approval", "masters"],
            message: `La evidencia aprobada de ${master.specId} no coincide con el pilot set.`,
          });
        }
      }
      for (const member of plan.pilotSet) {
        if (!approvedIds.has(member.specId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["productionPlan", "approval", "masters"],
            message: `Falta la evidencia aprobada de ${member.specId}.`,
          });
        }
      }
    }
  } else if (
    brief.productionPlan.remainingAdsAfterApproval !==
    brief.creativeMatrix.totalAds - 1
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["productionPlan", "remainingAdsAfterApproval"],
      message: "El lote restante debe ser exactamente el total de anuncios menos el golden master.",
    });
  }
});

export const ActorProfileSchema = z.object({
  id: z.string().min(1),
  publicPersonaName: z.string().min(1),
  kind: z.enum(["real-person", "brand-character"]),
  representationMode: z.enum(["on-camera-actor", "faceless-broll", "avatar"]),
  portrayedBy: z.string().nullable(),
  authorizationStatus: z.enum([
    "missing",
    "pending",
    "authorized",
    "not-required",
  ]),
  status: z.enum(["blocked", "ready"]),
  notes: z.array(z.string()),
});

export const BrandProfileSchema = z.object({
  id: z.string().min(1),
  brandName: z.string().min(1),
  publicPersonaName: z.string().min(1),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  fontFamily: z.string().min(1),
  tone: z.array(z.string()).min(1),
});

export const VoiceProfileSchema = z.object({
  id: z.string().min(1),
  actorProfileId: z.string().min(1),
  role: z.literal("canonical-brand-voice"),
  mode: z.enum([
    "recording",
    "authorized-clone",
    "licensed-synthetic",
    "pending",
  ]),
  provider: z.string().nullable(),
  voiceId: z.string().nullable(),
  modelId: z.string().min(1),
  outputFormat: z.string().min(1),
  settings: z.object({
    stability: z.number().min(0).max(1),
    similarityBoost: z.number().min(0).max(1),
    style: z.number().min(0).max(1),
    speakerBoost: z.boolean(),
    speed: z.number().min(0.7).max(1.2),
  }),
  authorizationStatus: z.enum([
    "missing",
    "pending",
    "authorized",
    "provider-licensed",
  ]),
  status: z.enum(["blocked", "ready"]),
  locale: z.string().min(1),
  notes: z.array(z.string()),
});

export const MusicProfileSchema = z.object({
  id: z.string().min(1),
  status: z.literal("ready"),
  provider: z.literal("elevenlabs"),
  modelId: z.literal("music_v2"),
  outputFormat: z.literal("mp3_48000_192"),
  forceInstrumental: z.literal(true),
  licenseScope: z.literal("commercial-online-ads"),
  beds: z.array(
    z.object({
      id: z.string().min(1),
      bodyIds: z.array(z.string().regex(/^A0[1-6]$/)).min(1),
      durationSeconds: z.number().int().min(30).max(60),
      prompt: z.string().min(80).max(4100),
    }),
  ).min(1),
  mix: z.object({
    narrationPriority: z.literal(true),
    duckingEnabled: z.literal(true),
    targetIntegratedLufs: z.number(),
    fadeInMs: z.number().int().nonnegative(),
    fadeOutMs: z.number().int().nonnegative(),
  }),
  notes: z.array(z.string()),
});

export const ProductShotProfileSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["blocked", "ready"]),
  inputs: z.object({
    mainImage: z.string().nullable(),
    acceptedFormats: z.array(z.enum(["png", "jpg", "jpeg", "webp"])).min(1),
    minimumLongEdgePixels: z.number().int().positive(),
  }),
  composition: z.object({
    style: z.literal("book-tablet-phone-bundle"),
    placement: z.literal("upper"),
    maxWidthPercent: z.number().min(1).max(100),
    faceSafe: z.boolean(),
  }),
  appearances: z.union([
    z.array(
      z.object({
        role: z.enum(["product-reveal", "product-recall"]),
        durationSeconds: z.number().positive(),
        animation: z.enum(["slide-pop", "slide-up", "fade-scale"]),
      }),
    ).length(2),
    z.array(
      z.object({
        role: z.literal("packshot-cameo"),
        durationSeconds: z.literal(2),
        animation: z.literal(COSTURA_PACKSHOT_ANIMATION_PRESET),
      }),
    ).length(1),
  ]),
  captions: z.object({
    maximumLines: z.number().int().min(1).max(3),
    keywordHighlight: z.boolean(),
    placement: z.literal("lower-safe-zone"),
  }),
  notes: z.array(z.string()),
});

export const VideoStyleProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  sourceProfile: z.string().min(1),
  status: z.enum(["provisional", "approved"]),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    background: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  }),
  palette: z.object({
    hookRed: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    captionYellow: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    emphasisOrange: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    activeMagenta: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    captionWhite: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    outlineBlack: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    ctaRed: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    ctaOutline: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  }),
  layouts: z.record(
    z.string(),
    z.object({
      topBandHeight: z.number().min(0).max(1),
      mediaHeight: z.number().min(0).max(1),
      bottomBandHeight: z.number().min(0).max(1),
      topBandColor: z.string().nullable(),
      bottomBandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    }),
  ),
  timeline: z.array(
    z.object({
      state: z.enum([
        "HOOK_FRAME",
        "SOLUTION_REVEAL",
        "PACKSHOT_CAMEO",
        "FEATURE_BURST",
        "DEMO_PROOF",
        "PRODUCT_RECALL",
        "OFFER_PROOF",
        "CTA_BUILD",
        "CTA_ACTION",
        "END_CUT",
      ]),
      from: z.number().min(0).max(1),
      to: z.number().min(0).max(1),
      layout: z.string().min(1),
    }),
  ).min(8),
  captions: z.object({
    profile: z.literal("karaoke-band-v1"),
    fontFamily: z.string().min(1),
    fallbackFonts: z.array(z.string()).min(1),
    fontSize: z.number().positive(),
    fontSizeMin: z.number().positive(),
    fontSizeMax: z.number().positive(),
    lineHeight: z.number().positive(),
    maxLines: z.number().int().min(1).max(3),
    maxWordsPerCard: z.number().int().min(1).max(9),
    maxWidth: z.number().min(0.5).max(1),
    fill: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    activeFill: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    stroke: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    strokeWidth: z.number().positive(),
    uppercase: z.boolean(),
    wordTimingToleranceMs: z.number().int().positive(),
    entryDurationMs: z.number().int().nonnegative(),
    exitDurationMs: z.number().int().nonnegative(),
    activeWordTransitionMs: z.number().int().nonnegative(),
  }),
  editing: z.object({
    transitionDefault: z.literal("hard-cut"),
    clipDurationTargetSeconds: z.tuple([
      z.number().positive(),
      z.number().positive(),
    ]),
    clipDurationMaxSeconds: z.number().positive(),
    movingClipMaxSeconds: z.number().positive(),
    specialVfxMaxCount: z.literal(1),
  }),
  packshot: z.union([
    z.object({
      exposures: z.tuple([
        z.literal("SOLUTION_REVEAL"),
        z.literal("PRODUCT_RECALL"),
      ]),
      width: z.number().min(0).max(1),
      maxHeight: z.number().min(0).max(1),
      centerX: z.number().min(0).max(1),
      centerY: z.number().min(0).max(1),
      primaryDurationSeconds: z.number().positive(),
      recallDurationSeconds: z.number().positive(),
      entryDurationMs: z.number().int().positive(),
      exitDurationMs: z.number().int().positive(),
    }),
    z.object({
      standardMarker: z.literal(ATTRACTION_LED_STANDARD_V2_MARKER),
      exposures: z.tuple([z.literal("PACKSHOT_CAMEO")]),
      durationSeconds: z.literal(2),
      animationPreset: z.literal(COSTURA_PACKSHOT_ANIMATION_PRESET),
      underlay: z.literal("attraction-video"),
      recall: z.literal(false),
      width: z.number().min(0).max(1),
      maxHeight: z.number().min(0).max(1),
      centerX: z.number().min(0).max(1),
      centerY: z.number().min(0).max(1),
      entryDurationMs: z.literal(350),
      exitDurationMs: z.literal(400),
    }),
  ]),
  cta: z.object({
    showArrowsInState: z.literal("CTA_ACTION"),
    arrowCount: z.literal(2),
    arrowWidth: z.number().min(0).max(1),
    leftCenterX: z.number().min(0).max(1),
    rightCenterX: z.number().min(0).max(1),
    bounceAmplitude: z.number().min(0).max(0.1),
    bouncePeriodMs: z.number().int().positive(),
    textMaxWidth: z.number().min(0.5).max(0.9),
  }),
  audio: z.object({
    integratedLufsMin: z.number(),
    integratedLufsMax: z.number(),
    truePeakMaxDbtp: z.number(),
    sampleRate: z.number().int().positive(),
    bitrateKbps: z.number().int().positive(),
  }),
  notes: z.array(z.string()),
});

export const PolicyProfileSchema = z.object({
  id: z.string().min(1),
  platform: z.literal("meta"),
  locale: z.string().min(1),
  forbiddenPatterns: z.array(z.string()),
  requiredChecks: z.array(z.string()).min(1),
});

export const ScriptSectionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["body", "price", "mechanic", "cta"]),
  plannedStartSeconds: z.number().nonnegative(),
  plannedEndSeconds: z.number().positive(),
  text: z.string().min(1),
  claimsUsed: z.array(z.string()),
});

export const BodyScriptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  durationTargetSeconds: z.number().positive(),
  actorProfileId: z.string().min(1),
  voiceProfileId: z.string().min(1),
  sections: z.array(ScriptSectionSchema).min(1),
});

export const CreativeSpecSchema = z.object({
  id: z.string().min(1),
  bodyId: z.string().min(1),
  bodyScriptId: z.string().min(1),
  hook: z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    visual: z.string().min(1),
    plannedSeconds: z.number().positive(),
  }),
  actorProfileId: z.string().min(1),
  voiceProfileId: z.string().min(1),
  editingStyleProfile: z.string().min(1),
  captionProfile: z.literal("karaoke-band-v1"),
  timelineMode: z.literal("normalized"),
  visualStandard: VisualStandardMarkerSchema.optional(),
  packshotExposures: z.union([
    z.tuple([
      z.literal("solution_reveal"),
      z.literal("product_recall"),
    ]),
    z.tuple([z.literal("packshot_cameo")]),
  ]),
  cta: z.string().min(1),
  claimsUsed: z.array(z.string()),
  outputFileName: z.string().regex(/\.mp4$/),
  output: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    durationTargetSeconds: z.number().positive(),
  }),
});

export const LaunchManifestSchema = z.object({
  brief: z.string().min(1),
  brandProfile: z.string().min(1),
  actorProfile: z.string().min(1),
  voiceProfile: z.string().min(1),
  musicProfile: z.string().min(1),
  productShotProfile: z.string().min(1),
  videoStyleProfile: z.string().min(1),
  policyProfile: z.string().min(1),
  bodyScripts: z.array(z.string()).min(1),
  creativeSpecs: z.array(z.string()).min(1),
});

export type Brief = z.infer<typeof BriefSchema>;
export type BrandProfile = z.infer<typeof BrandProfileSchema>;
export type ActorProfile = z.infer<typeof ActorProfileSchema>;
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;
export type MusicProfile = z.infer<typeof MusicProfileSchema>;
export type ProductShotProfile = z.infer<typeof ProductShotProfileSchema>;
export type VideoStyleProfile = z.infer<typeof VideoStyleProfileSchema>;
export type PolicyProfile = z.infer<typeof PolicyProfileSchema>;
export type BodyScript = z.infer<typeof BodyScriptSchema>;
export type CreativeSpec = z.infer<typeof CreativeSpecSchema>;
export type LaunchManifest = z.infer<typeof LaunchManifestSchema>;

export interface LaunchBundle {
  brief: Brief;
  brandProfile: BrandProfile;
  actorProfile: ActorProfile;
  voiceProfile: VoiceProfile;
  musicProfile: MusicProfile;
  productShotProfile: ProductShotProfile;
  videoStyleProfile: VideoStyleProfile;
  policyProfile: PolicyProfile;
  bodyScripts: BodyScript[];
  creativeSpecs: CreativeSpec[];
}

export interface ValidationIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  subject?: string;
}

export interface PreflightResult {
  ready: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
}
