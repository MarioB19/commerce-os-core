export const COSTURA_PACKSHOT_ANIMATION_PRESET =
  "costura-pop-float-exit-v1" as const;

export interface PackshotAnimationState {
  opacity: number;
  scale: number;
  translateY: number;
  rotation: number;
  burstOpacity: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function easeInCubic(value: number): number {
  return value ** 3;
}

function easeOutBack(value: number): number {
  const overshoot = 1.70158;
  const shifted = value - 1;
  return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
}

/**
 * Gramática Costura refinada para un cameo de dos segundos: entrada física,
 * microflotación durante el hold y salida completa antes de terminar.
 */
export function buildPackshotAnimationState(options: {
  frame: number;
  durationInFrames: number;
  fps: number;
}): PackshotAnimationState {
  const { durationInFrames, fps } = options;
  const frame = Math.max(0, Math.min(durationInFrames - 1, options.frame));
  const entryFrames = Math.max(1, Math.min(durationInFrames, Math.round(fps * 0.35)));
  const exitFrames = Math.max(1, Math.min(durationInFrames, Math.round(fps * 0.4)));
  const fadeInFrames = Math.max(1, Math.round(fps * 0.14));
  const entry = clamp01(frame / entryFrames);
  const entryMotion = easeOutBack(entry);
  const exitStart = Math.max(entryFrames, durationInFrames - exitFrames);
  const exit = clamp01(
    (frame - exitStart) / Math.max(1, durationInFrames - 1 - exitStart),
  );
  const exitMotion = easeInCubic(exit);
  const fadeIn = clamp01(frame / fadeInFrames);
  const float = Math.sin((frame / Math.max(1, fps)) * Math.PI * 2) * 5;

  return {
    opacity: fadeIn * (1 - exitMotion),
    scale: (0.76 + entryMotion * 0.24) * (1 - exitMotion * 0.14),
    translateY:
      (1 - easeOutCubic(entry)) * 82 + float + exitMotion * 58,
    rotation: -4.5 + entryMotion * 3.3 + exitMotion * 2.4,
    burstOpacity: Math.max(0, 0.58 * (1 - frame / Math.max(1, fps))),
  };
}
