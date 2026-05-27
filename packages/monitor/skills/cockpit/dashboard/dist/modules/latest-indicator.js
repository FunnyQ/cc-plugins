// Shared "new content" affordance for live scroll panes.
// When the pilot is reading history, live updates should not yank the viewport;
// instead each pane gets its own compact jump control.

const BOTTOM_THRESHOLD = 64;

export function createLatestIndicator(rootEl, labels) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "jump-latest";
  button.hidden = true;
  document.body.appendChild(button);

  let unread = 0;
  let enabled = false;
  let hideTimer = null;

  const atBottom = () =>
    rootEl.scrollHeight - rootEl.scrollTop - rootEl.clientHeight <
    BOTTOM_THRESHOLD;

  function label() {
    if (unread <= 1) return labels.single;
    return `${unread} ${labels.plural}`;
  }

  function position() {
    const rect = rootEl.getBoundingClientRect();
    button.style.left = `${rect.left + rect.width / 2}px`;
    button.style.bottom = `${window.innerHeight - rect.bottom + 12}px`;
    button.style.maxWidth = `${Math.max(rect.width - 32, 120)}px`;
  }

  function update() {
    const shouldShow = unread > 0;
    rootEl.classList.toggle("has-jump-latest", shouldShow);
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (shouldShow) {
      const wasHidden = button.hidden;
      button.hidden = false;
      button.classList.remove("is-leaving");
      button.classList.add("is-visible");
      if (wasHidden) {
        button.classList.remove("is-entering");
        void button.offsetWidth;
        button.classList.add("is-entering");
      }
      position();
      button.textContent = `${label()} · Jump`;
      return;
    }
    if (button.hidden) return;
    button.classList.remove("is-visible", "is-entering");
    button.classList.add("is-leaving");
    hideTimer = setTimeout(() => {
      button.hidden = true;
      button.classList.remove("is-leaving");
      hideTimer = null;
    }, 380);
  }

  function clear() {
    unread = 0;
    update();
  }

  function scrollToBottom(smooth = true) {
    rootEl.scrollTo({
      top: rootEl.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    clear();
  }

  button.addEventListener("click", () => scrollToBottom(true));

  rootEl.addEventListener("scroll", () => {
    if (atBottom()) clear();
    else if (!button.hidden) position();
  });
  window.addEventListener("resize", () => {
    if (!button.hidden) position();
  });

  return {
    atBottom,
    setEnabled(value) {
      enabled = !!value;
      clear();
    },
    reset() {
      enabled = false;
      clear();
    },
    notify(wasPinned, count = 1) {
      if (wasPinned) {
        requestAnimationFrame(() => scrollToBottom(false));
        return;
      }
      if (!enabled) return;
      unread += count;
      update();
    },
    scrollToBottom,
  };
}
