// Geometry adapted from Cypher Tempre genesis dashboard, MIT licensed.
import { motifPalette } from './themes.js';
export function initMotifs() {
  const canvas = document.getElementById("motifCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const motionPreference = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  let reducedMotion = motionPreference.matches;

  // Original auditor geometry in neutral monochrome. Low-opacity ambient
  // linework keeps the interactive workspace in the foreground.
  let { main: WHITE, secondary: SILVER, soft: GRAY } = motifPalette(document.documentElement.dataset.theme);
  window.addEventListener('chainchat-theme-change', event => {
    ({ main: WHITE, secondary: SILVER, soft: GRAY } = motifPalette(event.detail?.theme));
    if (reducedMotion) render(0);
  });
  const stroke = (rgb, alpha, w = 1) => {
    ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
    ctx.lineWidth = w;
  };
  const fill = (rgb, alpha) => {
    ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
  };
  const dot = (x, y, r) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let animationId = null;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- Bohr atom: precessing elliptical shells, ball electrons with comet tails ---
  function drawAtom(cx, cy, radius, phase) {
    ctx.save();
    ctx.translate(cx, cy);
    [0, Math.PI / 3, -Math.PI / 3].forEach((rotation, i) => {
      ctx.save();
      ctx.rotate(rotation + Math.sin(phase * 0.35 + i * 1.4) * 0.07);
      stroke(WHITE, 0.15, 1);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 1.22, radius * 0.36, 0, 0, Math.PI * 2);
      ctx.stroke();
      const accent = i === 1 ? GRAY : SILVER;
      const t = phase * (0.7 + i * 0.23) + i * 2.1;
      stroke(accent, 0.2, 1.2);
      ctx.beginPath();
      for (let k = 8; k >= 1; k -= 1) {
        const tt = t - k * 0.055;
        const xx = Math.cos(tt) * radius * 1.22;
        const yy = Math.sin(tt) * radius * 0.36;
        if (k === 8) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
      fill(accent, 0.55);
      dot(Math.cos(t) * radius * 1.22, Math.sin(t) * radius * 0.36, 2.6);
      ctx.restore();
    });
    fill(WHITE, 0.5);
    for (let i = 0; i < 3; i += 1) {
      const a = phase * 0.5 + (i * Math.PI * 2) / 3;
      dot(Math.cos(a) * 3.4, Math.sin(a) * 3.4, 2.1);
    }
    ctx.restore();
  }

  // --- Sputnik starburst: the 1950s atomic spark, drifting in slow rotation ---
  function drawStarburst(cx, cy, radius, phase) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(phase * 0.12);
    for (let i = 0; i < 12; i += 1) {
      const a = (i * Math.PI * 2) / 12;
      const r = radius * (i % 2 ? 0.6 : 1);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      stroke(WHITE, 0.13, 1);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4);
      ctx.lineTo(x, y);
      ctx.stroke();
      fill(WHITE, i % 3 === 0 ? 0.32 : 0.18);
      dot(x, y, i % 2 ? 1.3 : 2);
    }
    ctx.restore();
  }

  // --- Double helix: scrolling ribbon, alternating bright/dim base pairs,
  //     near strand drawn brighter than the far one for quiet depth ---
  function drawDna(x, y, heightPx, amplitude, phase) {
    const period = 92;
    const scroll = phase * 16;
    const steps = Math.max(30, Math.floor(heightPx / 9));
    for (const dir of [1, -1]) {
      ctx.beginPath();
      for (let i = 0; i <= steps; i += 1) {
        const yy = y + (heightPx * i) / steps;
        const xx = x + dir * Math.sin((yy + scroll) / period) * amplitude;
        if (i === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
      stroke(WHITE, dir === 1 ? 0.24 : 0.13, 1.25);
      ctx.stroke();
    }
    let rung = 0;
    for (let yy = y + 14; yy < y + heightPx; yy += 26, rung += 1) {
      const s = Math.sin((yy + scroll) / period) * amplitude;
      if (Math.abs(s) < amplitude * 0.22) continue; // skip the crossover knots
      stroke(WHITE, 0.12, 1);
      ctx.beginPath();
      ctx.moveTo(x + s, yy);
      ctx.lineTo(x - s, yy);
      ctx.stroke();
      const accent = rung % 2 ? GRAY : SILVER;
      fill(accent, 0.42);
      dot(x + s, yy, 1.9);
      fill(accent, 0.26);
      dot(x - s, yy, 1.6);
    }
  }

  // --- Timechain: sealed blocks on a slow conveyor along a shallow arc;
  //     the head block periodically seals with a soft expanding ring ---
  function drawTimechain(x, y, count, spacing, phase, dir = 1) {
    const offset = ((phase * 12) % spacing) * dir;
    let previous = null;
    for (let i = 0; i < count; i += 1) {
      const px = x + i * spacing - offset;
      const py = y + Math.sin(px / 110 + phase * 0.4) * 8;
      if (previous) {
        stroke(WHITE, 0.16, 1);
        ctx.beginPath();
        ctx.moveTo(previous.x + 18, previous.y + 9);
        ctx.lineTo(px, py + 9);
        ctx.stroke();
        fill(WHITE, 0.3);
        dot((previous.x + 18 + px) / 2, (previous.y + py) / 2 + 9, 1.1);
      }
      stroke(WHITE, 0.26, 1.1);
      ctx.strokeRect(px, py, 18, 18);
      fill(SILVER, 0.22);
      ctx.fillRect(px + 6.5, py + 6.5, 5, 5);
      previous = { x: px, y: py };
    }
    // the newest block seals: a quiet ring pulse, like an oscilloscope ping
    const pulse = (phase * 0.45) % 1;
    if (previous && pulse < 0.7) {
      stroke(SILVER, 0.28 * (1 - pulse / 0.7), 1.2);
      ctx.beginPath();
      ctx.arc(previous.x + 9, previous.y + 9, 12 + pulse * 26, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- Lissajous: oscilloscope trace with a slowly drifting phase ratio ---
  function drawLissajous(cx, cy, w, h, phase) {
    stroke(GRAY, 0.15, 1.1);
    ctx.beginPath();
    const delta = phase * 0.22;
    for (let i = 0; i <= 220; i += 1) {
      const t = (i / 220) * Math.PI * 2;
      const xx = cx + Math.sin(3 * t + delta) * w;
      const yy = cy + Math.sin(2 * t) * h;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    const t0 = (phase * 0.8) % (Math.PI * 2);
    fill(SILVER, 0.45);
    dot(cx + Math.sin(3 * t0 + delta) * w, cy + Math.sin(2 * t0) * h, 2);
  }

  function render(time = 0) {
    const phase = time * 0.00045;
    ctx.clearRect(0, 0, width, height);
    drawAtom(width * 0.14, height * 0.18, Math.min(110, width * 0.11), phase);
    drawAtom(
      width * 0.87,
      height * 0.8,
      Math.min(86, width * 0.08),
      -phase * 0.8,
    );
    drawStarburst(
      width * 0.92,
      height * 0.12,
      Math.min(46, width * 0.045),
      phase,
    );
    drawStarburst(
      width * 0.07,
      height * 0.86,
      Math.min(36, width * 0.04),
      -phase * 0.7,
    );
    drawDna(
      width * 0.8,
      Math.max(-30, height * 0.06),
      height * 0.66,
      Math.min(42, width * 0.04),
      phase,
    );
    drawDna(
      width * 0.1,
      height * 0.46,
      height * 0.5,
      Math.min(32, width * 0.032),
      -phase * 0.65,
    );
    drawTimechain(width * 0.3, height * 0.06, 6, 44, phase);
    drawTimechain(width * 0.55, height * 0.93, 5, 48, phase * 0.8, -1);
    drawLissajous(
      width * 0.4,
      height * 0.78,
      Math.min(70, width * 0.06),
      Math.min(34, width * 0.028),
      phase,
    );
    if (!reducedMotion && !document.hidden)
      animationId = window.requestAnimationFrame(render);
  }

  resize();
  window.addEventListener("resize", () => {
    resize();
    if (reducedMotion) render(0);
  });
  motionPreference.addEventListener("change", (event) => {
    reducedMotion = event.matches;
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
    render(0);
  });
  document.addEventListener("visibilitychange", () => {
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
    if (!document.hidden) render(0);
  });
  window.addEventListener("pagehide", () => {
    if (animationId !== null) cancelAnimationFrame(animationId);
  });
  render(0);
}
