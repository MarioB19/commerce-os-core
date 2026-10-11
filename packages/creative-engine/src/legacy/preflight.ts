import type {
  CreativeSpec,
  LaunchBundle,
  PreflightResult,
  ValidationIssue,
} from "./contracts.js";
import {
  ATTRACTION_LED_STANDARD_V2_MARKER,
} from "./attraction-led-standard.js";
import { COSTURA_PACKSHOT_ANIMATION_PRESET } from "./packshot-animation.js";

function stableVariantSignature(spec: CreativeSpec): string {
  return JSON.stringify({
    bodyId: spec.bodyId,
    bodyScriptId: spec.bodyScriptId,
    actorProfileId: spec.actorProfileId,
    voiceProfileId: spec.voiceProfileId,
    editingStyleProfile: spec.editingStyleProfile,
    captionProfile: spec.captionProfile,
    timelineMode: spec.timelineMode,
    visualStandard: spec.visualStandard,
    packshotExposures: spec.packshotExposures,
    cta: spec.cta,
    output: spec.output,
  });
}

export function runPreflight(
  bundle: LaunchBundle,
  options: { ffmpegAvailable: boolean },
): PreflightResult {
  const issues: ValidationIssue[] = [];
  const issueKeys = new Set<string>();
  const add = (
    severity: ValidationIssue["severity"],
    code: string,
    message: string,
    subject?: string,
  ) => {
    const key = `${severity}|${code}|${subject ?? ""}|${message}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(subject ? { severity, code, message, subject } : { severity, code, message });
  };

  const {
    brief,
    brandProfile,
    actorProfile,
    voiceProfile,
    musicProfile,
    productShotProfile,
    videoStyleProfile,
    bodyScripts,
    creativeSpecs,
  } = bundle;
  const usesAttractionLedV2 =
    brief.visualStandard === ATTRACTION_LED_STANDARD_V2_MARKER;
  const allText = [
    ...(brief.ads ?? []).flatMap((ad) => [
      { id: `${ad.bodyId}-${ad.hookId}:primaryText`, text: ad.primaryText },
      { id: `${ad.bodyId}-${ad.hookId}:headline`, text: ad.headline },
      { id: `${ad.bodyId}-${ad.hookId}:description`, text: ad.description },
      { id: `${ad.bodyId}-${ad.hookId}:spokenText`, text: ad.hook.spokenText },
    ]),
    ...bodyScripts.flatMap((script) => script.sections.map((section) => ({ id: section.id, text: section.text }))),
  ];
  for (const field of allText) for (const excluded of brief.excludedClaims ?? []) {
    if (field.text.normalize("NFKC").toLocaleLowerCase("es").includes(excluded.normalize("NFKC").toLocaleLowerCase("es"))) add("error", "EXCLUDED_CLAIM_IN_TEXT", `Contiene claim excluido: ${excluded}`, field.id);
  }
  const hookTexts = new Map<string, string>();
  for (const spec of creativeSpecs) {
    const normalized = spec.hook.text.normalize("NFKC").toLocaleLowerCase("es").replace(/[\p{P}\p{Z}\s]/gu, "");
    const prior = hookTexts.get(normalized);
    if (prior) add("error", "HOOK_TEXT_DUPLICATE", `El hook repite el texto de ${prior}; requiere decisión del autor.`, spec.id);
    hookTexts.set(normalized, spec.id);
  }
  const productionPlan = brief.productionPlan;
  const validatesPendingPilotSlice =
    productionPlan?.strategy === "pilot-set" &&
    productionPlan.approval.status !== "approved";
  const pilotSpecIds = new Set(
    productionPlan?.strategy === "pilot-set"
      ? productionPlan.pilotSet.map((member) => member.specId)
      : [],
  );
  const expectedMaterializedSpecs = validatesPendingPilotSlice
    ? pilotSpecIds.size
    : brief.productionScope.expectedSpecs;
  const productionBodyIds = validatesPendingPilotSlice
    ? [...new Set(
        productionPlan.pilotSet.map((member) => member.specId.slice(0, 3)),
      )]
    : brief.productionScope.bodyIds;

  if (
    brief.creativeMatrix.bodies * brief.creativeMatrix.hooksPerBody !==
    brief.creativeMatrix.totalAds
  ) {
    add(
      "error",
      "MATRIX_TOTAL_MISMATCH",
      "El total de anuncios no coincide con cuerpos × hooks.",
      brief.launchId,
    );
  }

  if (creativeSpecs.length !== expectedMaterializedSpecs) {
    add(
      "error",
      "SCOPE_SPEC_COUNT_INVALID",
      validatesPendingPilotSlice
        ? `El pilot-set pendiente requiere ${expectedMaterializedSpecs} specs canónicos y recibió ${creativeSpecs.length}.`
        : `El alcance ${brief.productionScope.mode} requiere ${brief.productionScope.expectedSpecs} specs y recibió ${creativeSpecs.length}.`,
      brief.launchId,
    );
  }

  if (
    brief.productionScope.mode === "full-matrix" &&
    brief.productionScope.expectedSpecs !== brief.creativeMatrix.totalAds
  ) {
    add(
      "error",
      "FULL_MATRIX_SCOPE_INVALID",
      "El alcance full-matrix debe cubrir los 18 anuncios.",
      brief.launchId,
    );
  }

  if (brandProfile.publicPersonaName !== actorProfile.publicPersonaName) {
    add(
      "error",
      "BRAND_ACTOR_MISMATCH",
      "El personaje público de la marca no coincide con el perfil del actor.",
      brandProfile.id,
    );
  }

  if (
    brief.creativeMatrix.bodies !== 6 ||
    brief.creativeMatrix.hooksPerBody !== 3 ||
    brief.creativeMatrix.totalAds !== 18
  ) {
    add(
      "error",
      "MATRIX_EXPERIMENT_INVALID",
      "La iniciativa exige exactamente 6 cuerpos × 3 hooks = 18 anuncios.",
      brief.launchId,
    );
  }

  for (const conflict of brief.unresolvedConflicts) {
    const blocksProduction =
      !conflict.blocks ||
      conflict.blocks.includes("copy") ||
      conflict.blocks.includes("preproduction") ||
      conflict.blocks.includes("render");
    add(
      blocksProduction ? conflict.severity : "warning",
      blocksProduction ? "SOURCE_CONFLICT" : "SOURCE_CONFLICT_DOWNSTREAM",
      conflict.description,
      conflict.id,
    );
  }

  const onCameraActorMissing =
    actorProfile.representationMode === "on-camera-actor" &&
    (!actorProfile.portrayedBy ||
      actorProfile.authorizationStatus !== "authorized");
  if (actorProfile.status !== "ready" || onCameraActorMissing) {
    add(
      "error",
      "ACTOR_NOT_READY",
      "El perfil visual del personaje no está listo o falta autorizar a su intérprete en cámara.",
      actorProfile.id,
    );
  }

  if (voiceProfile.actorProfileId !== actorProfile.id) {
    add(
      "error",
      "VOICE_ACTOR_MISMATCH",
      "La voz no está ligada al perfil del actor del producto.",
      voiceProfile.id,
    );
  }

  if (
    voiceProfile.status !== "ready" ||
    voiceProfile.mode === "pending" ||
    !["authorized", "provider-licensed"].includes(
      voiceProfile.authorizationStatus,
    ) ||
    !voiceProfile.voiceId
  ) {
    add(
      "error",
      "VOICE_NOT_READY",
      "Falta seleccionar y licenciar la voz canónica de ElevenLabs, guardando un voice_id fijo.",
      voiceProfile.id,
    );
  }

  if (voiceProfile.provider?.toLowerCase() !== "elevenlabs") {
    add(
      "error",
      "VOICE_PROVIDER_INVALID",
      "El lanzamiento exige ElevenLabs como proveedor de voz.",
      voiceProfile.id,
    );
  }

  if (
    musicProfile.provider !== "elevenlabs" ||
    musicProfile.modelId !== "music_v2" ||
    !musicProfile.forceInstrumental ||
    musicProfile.licenseScope !== "commercial-online-ads"
  ) {
    add(
      "error",
      "MUSIC_PROFILE_INVALID",
      "La música debe generarse automáticamente con ElevenLabs Music v2, sin voces y con licencia para anuncios digitales.",
      musicProfile.id,
    );
  }

  const musicBodies = musicProfile.beds.flatMap((bed) => bed.bodyIds);
  for (const bodyId of productionBodyIds) {
    const assignments = musicBodies.filter((candidate) => candidate === bodyId);
    if (assignments.length !== 1) {
      add(
        "error",
        "MUSIC_BODY_ASSIGNMENT_INVALID",
        `El cuerpo ${bodyId} debe tener exactamente una cama musical.`,
        musicProfile.id,
      );
    }
  }

  if (
    productShotProfile.status !== "ready" ||
    !productShotProfile.inputs.mainImage
  ) {
    add(
      "error",
      "PRODUCT_SHOT_NOT_READY",
      "Falta la captura principal real del producto para generar el bundle animado superior.",
      productShotProfile.id,
    );
  }

  const productShotRoles = new Map(
    productShotProfile.appearances.map((appearance) => [
      appearance.role,
      appearance,
    ]),
  );
  if (usesAttractionLedV2) {
    const cameo = productShotRoles.get("packshot-cameo");
    const stylePackshot = videoStyleProfile.packshot;
    const styleIsV2 = "standardMarker" in stylePackshot;
    if (
      productShotProfile.appearances.length !== 1 ||
      !cameo ||
      cameo.durationSeconds !== 2 ||
      cameo.animation !== COSTURA_PACKSHOT_ANIMATION_PRESET
    ) {
      add(
        "error",
        "PACKSHOT_CAMEO_PROFILE_INVALID",
        "El estándar attraction-led v2 exige una sola aparición packshot-cameo de 2.0 s con el preset canónico.",
        productShotProfile.id,
      );
    }
    if (
      !styleIsV2 ||
      stylePackshot.standardMarker !== ATTRACTION_LED_STANDARD_V2_MARKER ||
      stylePackshot.durationSeconds !== 2 ||
      stylePackshot.animationPreset !== COSTURA_PACKSHOT_ANIMATION_PRESET ||
      stylePackshot.underlay !== "attraction-video" ||
      stylePackshot.recall !== false
    ) {
      add(
        "error",
        "PACKSHOT_CAMEO_STYLE_INVALID",
        "El perfil de edición v2 debe declarar un cameo 1×2 s sobre video de atracción y sin recall.",
        videoStyleProfile.id,
      );
    }
    const timelineStates = videoStyleProfile.timeline.map((state) => state.state);
    const cameoStates = timelineStates.filter((state) => state === "PACKSHOT_CAMEO");
    if (
      cameoStates.length !== 1 ||
      timelineStates.includes("PRODUCT_RECALL")
    ) {
      add(
        "error",
        "PACKSHOT_CAMEO_TIMELINE_INVALID",
        "El timeline v2 debe contener un solo PACKSHOT_CAMEO y cero PRODUCT_RECALL.",
        videoStyleProfile.id,
      );
    }
  } else {
    const stylePackshot = videoStyleProfile.packshot;
    if ("standardMarker" in stylePackshot) {
      add(
        "error",
        "VISUAL_STANDARD_PROFILE_MISMATCH",
        "El perfil usa packshot v2, pero el brief no declara el estándar visual v2.",
        videoStyleProfile.id,
      );
    } else {
      const expectedProductShotDurations = {
        "product-reveal": stylePackshot.primaryDurationSeconds,
        "product-recall": stylePackshot.recallDurationSeconds,
      } as const;
      for (const requiredRole of ["product-reveal", "product-recall"] as const) {
        const appearance = productShotRoles.get(requiredRole);
        const expectedDuration = expectedProductShotDurations[requiredRole];
        if (!appearance || appearance.durationSeconds !== expectedDuration) {
          add(
            "error",
            "PRODUCT_SHOT_TIMING_INVALID",
            `La aparición ${requiredRole} debe durar ${expectedDuration} segundos según el perfil de edición.`,
            productShotProfile.id,
          );
        }
      }
    }
  }

  if (
    videoStyleProfile.canvas.width !== brief.output.width ||
    videoStyleProfile.canvas.height !== brief.output.height ||
    videoStyleProfile.canvas.fps !== brief.output.fps
  ) {
    add(
      "error",
      "STYLE_OUTPUT_MISMATCH",
      "El canvas del perfil de edición no coincide con la salida del lanzamiento.",
      videoStyleProfile.id,
    );
  }
  if (
    videoStyleProfile.editing.transitionDefault !== "hard-cut" ||
    videoStyleProfile.captions.profile !== "karaoke-band-v1"
  ) {
    add(
      "error",
      "STYLE_GRAMMAR_INVALID",
      "El perfil del lanzamiento exige cortes secos y captions karaoke-band-v1.",
      videoStyleProfile.id,
    );
  }

  if (!options.ffmpegAvailable) {
    add(
      "error",
      "FFMPEG_NOT_AVAILABLE",
      "FFmpeg no está instalado o no está disponible en PATH; el render final permanece bloqueado.",
    );
  }

  const claimsById = new Map(brief.claims.map((claim) => [claim.id, claim]));
  if (usesAttractionLedV2) {
    const normalizedAds = validatesPendingPilotSlice
      ? (brief.ads ?? []).filter((ad) =>
          pilotSpecIds.has(`${ad.bodyId}-${ad.hookId}`),
        )
      : brief.ads ?? [];
    const names = new Set<string>();
    const assetRequestIds = new Set<string>();
    const primaryBodies = new Map<string, string>();
    const adPairs = new Set<string>();
    const specsByPair = new Map<string, CreativeSpec[]>();
    for (const spec of creativeSpecs) {
      const pair = `${spec.bodyId}:${spec.hook.id}`;
      const matching = specsByPair.get(pair) ?? [];
      matching.push(spec);
      specsByPair.set(pair, matching);
    }
    for (const [pair, specs] of specsByPair) {
      if (specs.length > 1) {
        add(
          "error",
          "CREATIVE_SPEC_PAIR_DUPLICATED",
          "Cada par bodyId + hookId debe resolver a un solo CreativeSpec.",
          pair,
        );
      }
    }
    for (const ad of normalizedAds) {
      if (names.has(ad.name)) {
        add(
          "error",
          "NORMALIZED_AD_NAME_DUPLICATED",
          "Cada anuncio normalizado debe tener un nombre único.",
          ad.name,
        );
      }
      names.add(ad.name);
      if (assetRequestIds.has(ad.hook.assetRequestId)) {
        add(
          "error",
          "HOOK_ASSET_REQUEST_DUPLICATED",
          "Cada apertura v2 debe reservar un assetRequestId único.",
          ad.name,
        );
      }
      assetRequestIds.add(ad.hook.assetRequestId);
      const pair = `${ad.bodyId}:${ad.hookId}`;
      if (adPairs.has(pair)) {
        add(
          "error",
          "NORMALIZED_AD_PAIR_DUPLICATED",
          "Cada par bodyId + hookId debe aparecer una sola vez en los anuncios normalizados.",
          pair,
        );
      }
      adPairs.add(pair);

      const spokenWords = ad.hook.spokenText
        .trim()
        .split(/\s+/u)
        .filter(Boolean).length;
      if (spokenWords > ad.hook.plannedSeconds * 3) {
        add(
          "warning",
          "HOOK_SPEECH_RATE_TOO_HIGH",
          "Estimación superior a 3 palabras/s; requiere duración medida del audio, sin aceleración o recorte automático.",
          ad.name,
        );
      }

      const primaryBody = ad.primaryText.split("\n\n").slice(1).join("\n\n");
      const expectedBody = primaryBodies.get(ad.bodyId);
      if (expectedBody !== undefined && primaryBody !== expectedBody) {
        add(
          "error",
          "NORMALIZED_BODY_VARIANT_DRIFT",
          "Dentro de un ángulo, el primary text solo puede cambiar en la primera línea del hook.",
          ad.name,
        );
      } else {
        primaryBodies.set(ad.bodyId, primaryBody);
      }

      for (const claimId of ad.claimsUsed) {
        const claim = claimsById.get(claimId);
        if (!claim || claim.evidenceStatus !== "verified") {
          add(
            "error",
            "NORMALIZED_AD_CLAIM_INVALID",
            "El anuncio normalizado usa un claim ausente o no verificado.",
            `${ad.name}:${claimId}`,
          );
        }
      }

      const matchingSpecs = specsByPair.get(pair) ?? [];
      const matchingSpec = matchingSpecs.length === 1 ? matchingSpecs[0] : undefined;
      if (matchingSpecs.length === 0) {
        add(
          "error",
          "NORMALIZED_AD_SPEC_MISSING",
          "El anuncio normalizado no tiene un CreativeSpec correspondiente.",
          ad.name,
        );
      } else if (matchingSpecs.length > 1) {
        add(
          "error",
          "NORMALIZED_AD_SPEC_AMBIGUOUS",
          "El anuncio normalizado resuelve a más de un CreativeSpec.",
          ad.name,
        );
      } else {
        const exactSpec = matchingSpec!;
        const normalizedClaims = [...ad.claimsUsed].sort();
        const specClaims = [...exactSpec.claimsUsed].sort();
        if (
          exactSpec.hook.text !== ad.hook.spokenText ||
          exactSpec.hook.visual !== ad.hook.visualBrief ||
          exactSpec.hook.plannedSeconds !== ad.hook.plannedSeconds ||
          JSON.stringify(specClaims) !== JSON.stringify(normalizedClaims)
        ) {
          add(
            "error",
            "NORMALIZED_AD_SPEC_DRIFT",
            "Hook hablado, duración, dirección visual o claims difieren entre el brief normalizado y su CreativeSpec.",
            ad.name,
          );
        }
      }
    }

    for (const pair of specsByPair.keys()) {
      if (!adPairs.has(pair)) {
        add(
          "error",
          "CREATIVE_SPEC_NORMALIZED_AD_MISSING",
          "Cada CreativeSpec debe ser consumido exactamente una vez por un anuncio normalizado.",
          pair,
        );
      }
    }

    if (normalizedAds.length !== creativeSpecs.length) {
      add(
        "error",
        "NORMALIZED_AD_SPEC_COUNT_MISMATCH",
        "El contrato normalizado y los CreativeSpecs deben cubrir la misma matriz.",
        brief.launchId,
      );
    }

    if (!productionPlan) {
      add(
        "error",
        "GOLDEN_MASTER_CONTRACT_INVALID",
        "El golden master debe resolver a un CreativeSpec y al nombre público del mismo anuncio.",
        brief.launchId,
      );
    } else if (productionPlan.strategy === "pilot-set") {
      const pilotIds = new Set<string>();
      const pilotNames = new Set<string>();
      const pilotBodyIds = new Set<string>();
      const pilotHookIds = new Set<string>();
      for (const member of productionPlan.pilotSet) {
        const pilotSpec = creativeSpecs.find((spec) => spec.id === member.specId);
        const pilotAd = pilotSpec
          ? normalizedAds.find(
              (ad) =>
                ad.bodyId === pilotSpec.bodyId && ad.hookId === pilotSpec.hook.id,
            )
          : undefined;
        if (
          pilotIds.has(member.specId) ||
          pilotNames.has(member.creativeName) ||
          !pilotSpec ||
          !pilotAd ||
          pilotAd.name !== member.creativeName
        ) {
          add(
            "error",
            "PILOT_SET_CONTRACT_INVALID",
            "Cada miembro piloto debe ser único y resolver al CreativeSpec y nombre público del mismo anuncio.",
            member.specId,
          );
        }
        pilotIds.add(member.specId);
        pilotNames.add(member.creativeName);
        pilotBodyIds.add(member.specId.slice(0, 3));
        pilotHookIds.add(member.specId.slice(4));
      }
      if (
        productionPlan.pilotSet.length !== 3 ||
        pilotBodyIds.size !== 1 ||
        pilotHookIds.size !== 3 ||
        !["h1", "h2", "h3"].every((hookId) => pilotHookIds.has(hookId))
      ) {
        add(
          "error",
          "PILOT_SET_CONTRACT_INVALID",
          "El pilot set debe contener exactamente h1, h2 y h3 de un mismo ángulo.",
          brief.launchId,
        );
      }
      if (
        productionPlan.remainingAdsAfterApproval !==
        brief.creativeMatrix.totalAds - productionPlan.pilotSet.length
      ) {
        add(
          "error",
          "PILOT_SET_REMAINING_COUNT_INVALID",
          "El lote de escala debe excluir exactamente todos los specs del pilot set.",
          brief.launchId,
        );
      }
      if (productionPlan.approval.status === "approved") {
        const approvedIds = new Set<string>();
        const approvedPaths = new Set<string>();
        const approvedHashes = new Set<string>();
        const pilotNamesById = new Map(
          productionPlan.pilotSet.map((member) => [
            member.specId,
            member.creativeName,
          ]),
        );
        for (const evidence of productionPlan.approval.masters) {
          if (
            approvedIds.has(evidence.specId) ||
            approvedPaths.has(evidence.masterArtifact) ||
            approvedHashes.has(evidence.masterSha256) ||
            pilotNamesById.get(evidence.specId) !== evidence.creativeName
          ) {
            add(
              "error",
              "PILOT_SET_APPROVAL_INVALID",
              "La aprobación conjunta debe ligar una ruta y SHA únicos a cada miembro del pilot set.",
              evidence.specId,
            );
          }
          approvedIds.add(evidence.specId);
          approvedPaths.add(evidence.masterArtifact);
          approvedHashes.add(evidence.masterSha256);
        }
        if (
          productionPlan.approval.masters.length !==
            productionPlan.pilotSet.length ||
          productionPlan.pilotSet.some(
            (member) => !approvedIds.has(member.specId),
          )
        ) {
          add(
            "error",
            "PILOT_SET_APPROVAL_INVALID",
            "La aprobación conjunta debe contener exactamente un master por miembro piloto.",
            brief.launchId,
          );
        }
      }
    } else {
      const goldenSpec = creativeSpecs.find(
        (spec) => spec.id === productionPlan.goldenMaster,
      );
      const goldenAd = goldenSpec
        ? normalizedAds.find(
            (ad) =>
              ad.bodyId === goldenSpec.bodyId && ad.hookId === goldenSpec.hook.id,
          )
        : undefined;
      if (
        !goldenSpec ||
        !goldenAd ||
        goldenAd.name !== productionPlan.goldenMasterCreativeName
      ) {
        add(
          "error",
          "GOLDEN_MASTER_CONTRACT_INVALID",
          "El golden master debe resolver a un CreativeSpec y al nombre público del mismo anuncio.",
          brief.launchId,
        );
      }
    }
  }
  const bodyScriptsById = new Map(bodyScripts.map((script) => [script.id, script]));
  const variantsByBody = new Map<string, CreativeSpec[]>();

  for (const spec of creativeSpecs) {
    const variants = variantsByBody.get(spec.bodyId) ?? [];
    variants.push(spec);
    variantsByBody.set(spec.bodyId, variants);

    const bodyScript = bodyScriptsById.get(spec.bodyScriptId);
    if (!bodyScript) {
      add(
        "error",
        "BODY_SCRIPT_MISSING",
        "El CreativeSpec referencia un guion inexistente.",
        spec.id,
      );
      continue;
    }

    if (
      spec.actorProfileId !== actorProfile.id ||
      bodyScript.actorProfileId !== actorProfile.id
    ) {
      add(
        "error",
        "SPEC_ACTOR_MISMATCH",
        "El actor del anuncio no coincide con el actor del lanzamiento.",
        spec.id,
      );
    }

    if (
      spec.voiceProfileId !== voiceProfile.id ||
      bodyScript.voiceProfileId !== voiceProfile.id
    ) {
      add(
        "error",
        "SPEC_VOICE_MISMATCH",
        "La voz del anuncio no coincide con la voz del lanzamiento.",
        spec.id,
      );
    }

    if (
      spec.editingStyleProfile !== videoStyleProfile.id ||
      spec.captionProfile !== videoStyleProfile.captions.profile ||
      spec.timelineMode !== "normalized"
    ) {
      add(
        "error",
        "SPEC_STYLE_MISMATCH",
        "El anuncio no selecciona explícitamente el perfil de edición del lanzamiento.",
        spec.id,
      );
    }

    if (usesAttractionLedV2) {
      if (
        spec.visualStandard !== ATTRACTION_LED_STANDARD_V2_MARKER ||
        spec.packshotExposures.length !== 1 ||
        spec.packshotExposures[0] !== "packshot_cameo"
      ) {
        add(
          "error",
          "SPEC_PACKSHOT_V2_MISMATCH",
          "Cada CreativeSpec v2 debe declarar el marcador actual y una sola exposición packshot_cameo.",
          spec.id,
        );
      }
    } else if (
      spec.visualStandard === ATTRACTION_LED_STANDARD_V2_MARKER ||
      spec.packshotExposures[0] === "packshot_cameo"
    ) {
      add(
        "error",
        "SPEC_VISUAL_STANDARD_MISMATCH",
        "El CreativeSpec selecciona el contrato v2, pero el brief no lo declara.",
        spec.id,
      );
    }

    if (spec.cta !== brief.expectedCta) {
      add(
        "error",
        "CTA_MISMATCH",
        `El CTA "${spec.cta}" no coincide con la fuente prioritaria "${brief.expectedCta}".`,
        spec.id,
      );
    }

    if (
      spec.output.durationTargetSeconds < brief.output.minimumSeconds ||
      spec.output.durationTargetSeconds > brief.output.maximumSeconds
    ) {
      add(
        "error",
        "DURATION_OUT_OF_RANGE",
        "La duración objetivo debe estar entre 30 y 60 segundos.",
        spec.id,
      );
    } else if (
      spec.output.durationTargetSeconds < 45 ||
      spec.output.durationTargetSeconds > 55
    ) {
      add(
        "warning",
        "DURATION_OUTSIDE_TARGET",
        "La duración es válida, pero está fuera del objetivo recomendado de 45–55 segundos.",
        spec.id,
      );
    }

    const maximumHookSeconds = usesAttractionLedV2 ? 3 : 6;
    if (spec.hook.plannedSeconds > maximumHookSeconds) {
      add(
        "error",
        "HOOK_TOO_LONG",
        `El hook debe durar ${maximumHookSeconds} segundos o menos.`,
        spec.id,
      );
    }

    const ctaSection = bodyScript.sections.find((section) => section.type === "cta");
    if (
      !ctaSection ||
      ctaSection.plannedEndSeconds - ctaSection.plannedStartSeconds < 3
    ) {
      add(
        "error",
        "CTA_SCREEN_TIME_TOO_SHORT",
        "El bloque CTA debe tener al menos 3 segundos planeados.",
        spec.id,
      );
    }

    const allClaims = new Set([
      ...spec.claimsUsed,
      ...bodyScript.sections.flatMap((section) => section.claimsUsed),
    ]);
    for (const claimId of allClaims) {
      const claim = claimsById.get(claimId);
      if (!claim) {
        add(
          "error",
          "CLAIM_NOT_REGISTERED",
          "El anuncio usa una afirmación no registrada en el brief.",
          claimId,
        );
      } else if (claim.evidenceStatus !== "verified") {
        add(
          "error",
          "CLAIM_NOT_VERIFIED",
          `El claim "${claim.label}" está ${claim.evidenceStatus}; no puede entrar a producción.`,
          claim.id,
        );
      }
    }
  }

  for (const [bodyId, variants] of variantsByBody) {
    if (variants.length !== brief.creativeMatrix.hooksPerBody) {
      add(
        "error",
        "HOOK_VARIANT_COUNT_INVALID",
        `El cuerpo ${bodyId} debe tener exactamente ${brief.creativeMatrix.hooksPerBody} hooks.`,
        bodyId,
      );
      continue;
    }

    const signatures = new Set(variants.map(stableVariantSignature));
    if (signatures.size !== 1) {
      add(
        "error",
        "HOOK_ISOLATION_BROKEN",
        "Dentro del trío solo puede cambiar el hook y el nombre del archivo.",
        bodyId,
      );
    }

    const hookIds = new Set(variants.map((variant) => variant.hook.id));
    if (hookIds.size !== variants.length) {
      add(
        "error",
        "HOOK_DUPLICATED",
        "Los tres hooks del cuerpo deben ser distintos.",
        bodyId,
      );
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  return { ready: errors === 0, errors, warnings, issues };
}
