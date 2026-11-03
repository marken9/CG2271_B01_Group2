/*
 * Motion prototypes: the behaviour CSS can't do alone. It watches the page's
 * own DOM (app.js is unchanged) and only animates real changes.
 */

const root = document.documentElement;
const on = (name) => root.classList.contains(name);
const reduced = () => on("m-reduced") || matchMedia("(prefers-reduced-motion: reduce)").matches;

/* 1. Lid opens: one ring, only on a real closed → open change (not on load). */
const lid = document.querySelector("#lid-label");
let lidState = lid.dataset.state;
new MutationObserver(() => {
  const next = lid.dataset.state;
  if (on("m-lid") && lidState === "secure" && next === "breach") {
    lid.classList.remove("lid-ring");
    void lid.offsetWidth; // restart the animation if it's already running
    lid.classList.add("lid-ring");
  }
  lidState = next;
}).observe(lid, { attributes: true, attributeFilter: ["data-state"] });
lid.addEventListener("animationend", (event) => {
  if (event.animationName === "lid-ring") lid.classList.remove("lid-ring");
});

/* 2. Lists: rows enter, leave and slide; the list's height eases with them.
 *
 * The slide is an additive FLIP (composite: "add"): each layout change adds its
 * own offset animation on top of any still running, so a row that moves again
 * mid-slide carries on from where it is instead of jumping. The spring is
 * sampled into a CSS linear() easing: damping 0.72, about 4.5% overshoot. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const SPRING_MS = 500;
const SPRING = springEasing(0.72);
const FADE_IN_MS = 200;
const FADE_OUT_MS = 160;
const HEIGHT_MS = 320;

/* A damped spring from 0 to 1 that settles (within 0.1%) at t = 1. */
function springEasing(damping, samples = 48) {
  const omega = Math.log(1000) / damping;
  const omegaD = omega * Math.sqrt(1 - damping * damping);
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const decay = Math.exp(-damping * omega * t);
    points.push(+(1 - decay * (Math.cos(omegaD * t) + ((damping * omega) / omegaD) * Math.sin(omegaD * t))).toFixed(4));
  }
  points[samples] = 1;
  return `linear(${points.join(", ")})`;
}

function animateList(list, keyOf) {
  const panel = list.parentElement;
  panel.style.position = "relative";
  /* Rows that have left fade out in a layer over the list, so app.js never sees them. */
  const ghosts = document.createElement(list.tagName);
  ghosts.className = `${list.className} row-ghosts`;
  ghosts.setAttribute("aria-hidden", "true");
  list.after(ghosts);

  /* Layout positions (offsetTop ignores transforms), so a running slide never
   * feeds back into the next measurement. */
  const layoutTop = (li) => li.offsetTop - list.offsetTop;
  const snapshot = () =>
    new Map(
      [...list.children].map((li) => {
        const cs = getComputedStyle(li);
        return [keyOf(li), { top: layoutTop(li), paddingTop: cs.paddingTop, borderTop: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` }];
      }),
    );
  let before = snapshot();
  let height = list.offsetHeight;

  const enter = (li) => {
    li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, easing: EASE_OUT });
    if (!reduced()) {
      li.animate([{ transform: "translateY(-10px) scale(0.97)" }, { transform: "none" }], {
        duration: SPRING_MS,
        easing: SPRING,
        composite: "add",
      });
    }
  };

  const leave = (node, was) => {
    for (const a of node.getAnimations()) a.cancel();
    delete node.dataset.key;
    /* Anchored to the list's top, so the shrinking list doesn't drag the ghost. */
    Object.assign(ghosts.style, { top: `${list.offsetTop}px`, left: `${list.offsetLeft}px`, width: `${list.offsetWidth}px` });
    Object.assign(node.style, {
      position: "absolute",
      top: `${was.top}px`,
      left: "0",
      right: "0",
      margin: "0",
      paddingTop: was.paddingTop,
      borderTop: was.borderTop,
    });
    ghosts.append(node);
    const out = reduced() ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px) scale(0.97)" };
    node.animate([{ opacity: 1, transform: "none" }, out], { duration: FADE_OUT_MS, easing: EASE_OUT, fill: "forwards" })
      .finished.finally(() => node.remove());
  };

  const resize = () => {
    const running = list.getAnimations().find((a) => a.id === "height");
    const from = running ? list.getBoundingClientRect().height : height;
    running?.cancel();
    const to = list.offsetHeight;
    height = to;
    if (Math.abs(from - to) < 1 || reduced()) return;
    list.style.overflow = "clip";
    const anim = list.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: HEIGHT_MS, easing: EASE_OUT });
    anim.id = "height";
    anim.finished.then(() => (list.style.overflow = ""), () => {});
  };

  new MutationObserver((records) => {
    if (!on("m-rows")) {
      before = snapshot();
      height = list.offsetHeight;
      return;
    }
    const rows = [...list.children];
    const keys = new Set(rows.map(keyOf));

    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        const key = keyOf(node);
        const was = before.get(key);
        if (was && !keys.has(key)) leave(node, was);
      }
    }

    for (const li of rows) {
      const was = before.get(keyOf(li));
      if (!was) {
        enter(li);
        continue;
      }
      const dy = was.top - layoutTop(li);
      if (Math.abs(dy) < 0.5 || reduced()) continue;
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
        duration: SPRING_MS,
        easing: SPRING,
        composite: "add",
      });
    }

    resize();
    before = snapshot();
  }).observe(list, { childList: true });
}

/* Alarm rows keep their element while open (app.js keys them); events are
 * matched by their text. */
animateList(document.querySelector("#alarm-list"), (li) => li.dataset.key ?? li.textContent);
animateList(document.querySelector("#event-list"), (li) => li.textContent);

/* 3. Theme: run the existing toggle inside a View Transition. */
const toggle = document.querySelector("#theme-toggle");
let passing = false;
toggle.addEventListener(
  "click",
  (event) => {
    if (passing || !on("m-theme") || !document.startViewTransition) return;
    event.stopImmediatePropagation();
    document.startViewTransition(() => {
      passing = true;
      toggle.click();
      passing = false;
    });
  },
  true,
);

/* ---------- Prototype panel ---------- */

const panel = document.querySelector("#proto");
for (const box of panel.querySelectorAll("input[data-class]")) {
  box.checked = on(box.dataset.class);
  box.addEventListener("change", () => root.classList.toggle(box.dataset.class, box.checked));
}

const actions = {
  lid: (b) => {
    window.sim.setLid(!window.sim.lidOpen);
    b.textContent = window.sim.lidOpen ? "Close lid" : "Open lid";
  },
  humid: (b) => {
    const high = b.textContent === "Humidity high";
    window.sim.setHumid(high);
    b.textContent = high ? "Humidity normal" : "Humidity high";
  },
  theme: () => toggle.click(),
  dialog: () => (location.hash = "#history"),
  feed: (b) => {
    window.sim.setConnected(!window.sim.connected);
    b.textContent = window.sim.connected ? "Drop feed" : "Restore feed";
  },
};
for (const button of panel.querySelectorAll("button[data-action]")) {
  button.addEventListener("click", () => actions[button.dataset.action](button));
}
