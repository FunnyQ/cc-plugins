const ACTIVE_MS = 60_000;
const SETTLE_MS = 6_000;

// After a minute of activity, ease the hero wave to a gentle stop over 6s so
// the dashboard settles into a calm resting state instead of looping forever.
export function installHeroMotionSettler() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const hero = document.querySelector(".hero-band");
  if (!hero || typeof hero.getAnimations !== "function") return;

  window.setTimeout(() => settleHeroMotion(hero), ACTIVE_MS);
}

function settleHeroMotion(hero) {
  const animations = hero
    .getAnimations({ subtree: true })
    .filter((animation) => animation.playState !== "finished");

  if (animations.length === 0) return;

  const startedAt = performance.now();

  function tick(now) {
    const progress = Math.min((now - startedAt) / SETTLE_MS, 1);
    // Quintic decay: playback rate falls 1 → 0, slowing fast then easing in.
    const rate = (1 - progress) ** 5;

    for (const animation of animations) {
      setPlaybackRate(animation, rate);
    }

    if (progress < 1) {
      requestAnimationFrame(tick);
      return;
    }

    for (const animation of animations) {
      animation.pause();
    }
  }

  requestAnimationFrame(tick);
}

function setPlaybackRate(animation, rate) {
  if (typeof animation.updatePlaybackRate === "function") {
    animation.updatePlaybackRate(rate);
    return;
  }

  animation.playbackRate = rate;
}
