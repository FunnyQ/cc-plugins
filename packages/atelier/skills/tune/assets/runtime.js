(() => {
  if (window.atelier) return;
  const values = {};
  const listeners = {};
  window.atelier = {
    values,
    on(id, fn) {
      (listeners[id] ??= []).push(fn);
      if (id in values) fn(...values[id]);
    },
    emit(id, value, css, vars) {
      values[id] = [value, css, vars];
      for (const fn of listeners[id] ?? []) fn(value, css, vars);
      window.dispatchEvent(
        new CustomEvent("atelier", { detail: { id, value, css, vars } }),
      );
    },
  };
  if (window.parent !== window) {
    const init = () => {
      try {
        window.parent.atelierStage?.();
      } catch {}
    };
    init();
    document.addEventListener("DOMContentLoaded", init);
  }
})();
