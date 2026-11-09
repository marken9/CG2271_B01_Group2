/*
 * Seal timeline: the lid and the beam as two lanes on the same six hours as the climate charts.
 * Closed is a thin track, open is a filled block in --negative, a trip too short to see is a full-height
 * tick, and a gap in the feed is a hatched band across both lanes. Colours come from the page's tokens.
 */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const css = (el, name, fb) => getComputedStyle(el).getPropertyValue(name).trim() || fb;
  const node = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent?.appendChild(n);
    return n;
  };
  const label = (parent, str, attrs) => {
    const t = node("text", attrs, parent);
    t.textContent = str;
    return t;
  };

  function draw(el, data, { lane = 28, gap = 14, labelWidth = 52, axis = true, names = true, right = 4, only = null } = {}) {
    const { fmt } = window.RG;
    el.innerHTML = "";
    const w = Math.max(280, el.clientWidth);
    const lanes = [
      { key: "lid", name: "Lid", spans: data.lid, open: "open" },
      { key: "beam", name: "Beam", spans: data.beam, open: "tripped" },
    ].filter((l) => !only || l.key === only);
    const top = 18; // room for a block's label
    const h = top + lanes.length * lane + (lanes.length - 1) * gap + (axis ? 26 : 4);
    const ink = css(el, "--text", "#111"), muted = css(el, "--muted", "#666"), track = css(el, "--seal-track", muted);
    const red = css(el, "--negative", "#c4242a"), grid = css(el, "--grid", "#e5e5e5");

    const s = node("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, role: "img" }, el);
    const x0 = names ? labelWidth : 0, x1 = w - right;
    const x = (t) => x0 + ((t - data.start) / (data.now - data.start)) * (x1 - x0);

    const defs = node("defs", {}, s);
    const hatch = node("pattern", { id: `hatch-${el.id || "seal"}`, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    node("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: muted, "stroke-width": 1.5 }, hatch);

    /* Hour lines first, so the lanes draw over them. */
    if (axis) {
      const first = Math.ceil(data.start / 3600000) * 3600000;
      for (let t = first; t <= data.now; t += 3600000) {
        node("line", { x1: x(t), x2: x(t), y1: top - 2, y2: h - 22, stroke: grid, "stroke-width": 1 }, s);
        label(s, fmt.time(t), { x: x(t), y: h - 6, "font-size": 12, fill: muted, "text-anchor": "middle" });
      }
    }

    const summary = [];
    lanes.forEach((l, i) => {
      const y = top + i * (lane + gap);
      const mid = y + lane / 2;
      if (names) label(s, l.name, { x: 0, y: mid + 4, "font-size": 12, fill: muted });
      node("line", { x1: x0, x2: x1, y1: mid, y2: mid, stroke: track, "stroke-width": 2, "stroke-linecap": "butt" }, s);

      /* Labels never collide: the span still open is placed first; a later label that would touch a
       * placed one falls back to its time alone, and is dropped if even that does not fit. */
      const placed = [];
      const ordered = [...l.spans].sort((p, q) => (p.to == null ? -1 : q.to == null ? 1 : 0));
      for (const span of ordered) {
        const end = span.to ?? data.now;
        const a = x(span.from), b = Math.max(x(end), a + 3);
        node("rect", { x: a, y, width: b - a, height: lane, fill: red }, s);
        const full = span.to == null
          ? `${l.open[0].toUpperCase()}${l.open.slice(1)} since ${fmt.time(span.from)}`
          : `${fmt.time(span.from)} · ${fmt.duration(span.to - span.from)}`;
        summary.push(`${l.name} ${l.open} ${full}`);
        for (const text of [full, fmt.time(span.from)]) {
          const anchor = a > w - 140 ? "end" : "start";
          const t = label(s, text, { x: anchor === "end" ? b : a, y: y - 5, "font-size": 12, fill: ink, "text-anchor": anchor });
          const box = t.getBBox();
          const hit = placed.some((p) => box.x < p.x + p.width + 8 && p.x < box.x + box.width + 8);
          if (!hit) { placed.push(box); break; }
          t.remove();
        }
      }
    });

    if (data.feedLostAt) {
      const a = x(data.feedLostAt);
      const yTop = top, yBottom = top + lanes.length * lane + (lanes.length - 1) * gap;
      node("rect", { x: a, y: yTop, width: x1 - a, height: yBottom - yTop, fill: `url(#hatch-${el.id || "seal"})` }, s);
      label(s, "no data", { x: x1, y: yTop - 5, "font-size": 12, fill: muted, "text-anchor": "end" });
      summary.push(`No data since ${fmt.time(data.feedLostAt)}`);
    }

    s.setAttribute("aria-label", `Lid and beam over the last 6 hours. ${summary.join(". ") || "Sealed throughout"}.`);
  }

  window.Seal = {
    draw(el, data, options) {
      let width = 0;
      new ResizeObserver(() => {
        if (el.clientWidth === width) return;
        width = el.clientWidth;
        draw(el, data, options);
      }).observe(el);
    },
  };
})();
