// Fallschaden – gemeinsam genutzt von Client und Selbsttest.
// Fallschaden: ab ~160 px Fallhöhe (≈ 8 Arbeiter hoch) tut es weh.
// v = sqrt(2 g h) → 470 px/s entspricht h ≈ 158 px. Darüber 1 HP pro 9 px/s, max. 50.
const FALL_SAFE_SPEED = 470;
const FALL_DMG_DIV = 9;
const FALL_MAX_DMG = 50;
export function fallDamage(impact) {
  if (impact <= FALL_SAFE_SPEED) return 0;
  return Math.min(FALL_MAX_DMG, Math.max(1, Math.round((impact - FALL_SAFE_SPEED) / FALL_DMG_DIV)));
}
