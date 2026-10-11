/**
 * AnoPick FX : amélioration progressive.
 *
 * - Motion  : déjà embarqué dans la page (window.Motion), aucun chargement réseau.
 * - Lenis   : chargé à la demande depuis un CDN, uniquement sur appareil à souris.
 * - Three.js: chargé à la demande, uniquement si l'appareil et la connexion le permettent.
 *
 * Règle d'or : on ne touche jamais au JS minifié de l'app. Tout passe par le DOM,
 * des classes CSS et des variables CSS. Si une brique échoue (CDN bloqué, WebGL
 * absent, appareil lent), l'app garde exactement son rendu d'origine.
 */

/* ------------------------------ Réglages -------------------------------- */

const LENIS_URL = 'https://cdn.jsdelivr.net/npm/lenis@1.3.17/dist/lenis.min.js';
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
/** Les pastilles 3D reprennent les couleurs de la palette ouverte. */
const SYNC_HERO_WITH_PALETTE = true;
const BRAND_COLORS = ['#E1DAFC', '#AC97F3', '#5A3CF0', '#FF8B6E', '#FFE5DF'] as const;

/* ------------------------------- Types ---------------------------------- */

type Cleanup = () => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any; // Three.js et Lenis sont chargés dynamiquement : types volontairement souples.

interface MotionControls extends PromiseLike<unknown> {
  stop(): void;
  cancel(): void;
}

interface MotionApi {
  animate(
    target: Element | Element[] | NodeListOf<Element>,
    keyframes: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): MotionControls;
  animate(
    from: number,
    to: number,
    options: Record<string, unknown> & { onUpdate?: (value: number) => void },
  ): MotionControls;
  inView(
    target: Element | Element[] | string,
    onStart: (el: Element, entry: IntersectionObserverEntry) => void | ((entry: IntersectionObserverEntry) => void),
    options?: { amount?: 'some' | 'all' | number; margin?: string },
  ): Cleanup;
  scroll(onScroll: (progress: number) => void, options?: Record<string, unknown>): Cleanup;
  stagger(step: number, options?: Record<string, unknown>): unknown;
}

declare global {
  interface Window {
    Motion?: MotionApi;
    Lenis?: Any;
    AnoPickFX?: {
      state(): Record<string, boolean>;
      setPalette(hexes: string[] | null): void;
    };
  }
}

interface Feature {
  name: string;
  /** Condition d'activation (en plus de « les animations sont permises »). */
  needs: () => boolean;
  start: () => Cleanup;
}

/* ------------------------------ Utilitaires ----------------------------- */

const root = document.documentElement;
const M = window.Motion;
const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
const fineMQ = window.matchMedia('(hover: hover) and (pointer: fine)');
const noop: Cleanup = () => undefined;
const $ = <T extends Element>(selector: string, scope: ParentNode = document): T | null => scope.querySelector<T>(selector);
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const EASE = [0.22, 1, 0.36, 1];
const SPRING = { type: 'spring', stiffness: 260, damping: 20, mass: 0.5 };

/** Animations permises : préférence système ET réglage « Animations douces » de l'app. */
const canMove = (): boolean => !!M && !reducedMQ.matches && !root.classList.contains('reduce-motion');

interface NetworkInfo {
  saveData?: boolean;
  effectiveType?: string;
}
type NavigatorExtras = Navigator & { connection?: NetworkInfo; deviceMemory?: number };
const nav = navigator as NavigatorExtras;

/** Économie de données demandée par l'utilisateur ou connexion très lente. */
const saveData = (): boolean => !!nav.connection?.saveData || /^(slow-2g|2g)$/.test(nav.connection?.effectiveType ?? '');

/** Appareil modeste : on évite le chargement de Three.js (~1 Mo) et le rendu WebGL. */
const lowEnd = (): boolean =>
  saveData() ||
  nav.connection?.effectiveType === '3g' ||
  (nav.deviceMemory !== undefined && nav.deviceMemory < 4) ||
  (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency < 4);

let webglProbe: boolean | undefined;
/** Sonde faite une seule fois : chaque appel créerait sinon un contexte WebGL de plus. */
const webglAvailable = (): boolean => {
  if (webglProbe === undefined) {
    try {
      const c = document.createElement('canvas');
      webglProbe = !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      webglProbe = false;
    }
  }
  return webglProbe;
};

const idle = (fn: () => void, timeout = 1800): void => {
  const run = (): void => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout });
    else window.setTimeout(fn, 250);
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
};

const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
    document.head.append(s);
  });

/** Passe en pause les animations CSS infinies quand la page n'est pas visible. */
const watchPaused = (): Cleanup => {
  const set = (): void => {
    root.classList.toggle('fx-paused', document.hidden);
  };
  document.addEventListener('visibilitychange', set);
  set();
  return () => {
    document.removeEventListener('visibilitychange', set);
    root.classList.remove('fx-paused');
  };
};

/* --------------------- Spotlight / Magic Card (curseur) ------------------ */

const SPOT_SELECTOR = '.tool-card,.collection-card,.swatch-card,.settings-card,.lab-card';

const startSpotlight = (): Cleanup => {
  let raf = 0;
  let pending: { el: HTMLElement; x: number; y: number } | null = null;

  const flush = (): void => {
    raf = 0;
    if (!pending) return;
    const { el, x, y } = pending;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${x - r.left}px`);
    el.style.setProperty('--my', `${y - r.top}px`);
    pending = null;
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const el = (e.target as Element | null)?.closest<HTMLElement>(SPOT_SELECTOR);
    if (!el) return;
    if (!el.classList.contains('fx-glow')) {
      el.classList.add('fx-glow');
      if (getComputedStyle(el).position === 'static') el.classList.add('fx-rel');
    }
    pending = { el, x: e.clientX, y: e.clientY };
    if (!raf) raf = requestAnimationFrame(flush);
  };

  document.addEventListener('pointermove', onMove, { passive: true });
  return () => {
    document.removeEventListener('pointermove', onMove);
    if (raf) cancelAnimationFrame(raf);
  };
};

/* ------------------------- Magnetic (Motion Primitives) ------------------ */

const MAGNETIC_SELECTOR = '#pickBtn,#showExport';

const startMagnetic = (): Cleanup => {
  const radius = 90;
  const strength = 0.28;
  const maxShift = 10;
  const state = new WeakMap<HTMLElement, { x: number; y: number }>();

  const move = (el: HTMLElement, x: number, y: number): void => {
    const prev = state.get(el) ?? { x: 0, y: 0 };
    if (Math.abs(prev.x - x) < 0.4 && Math.abs(prev.y - y) < 0.4) return;
    state.set(el, { x, y });
    el.setAttribute('data-fx-magnetic', '');
    void M?.animate(el, { translate: `${x}px ${y}px` }, SPRING);
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    document.querySelectorAll<HTMLElement>(MAGNETIC_SELECTOR).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const near = Math.hypot(dx, dy) < radius + Math.max(r.width, r.height) / 2;
      // Un bouton large bouge peu : il resterait sinon visiblement décalé de ses voisins.
      const cap = r.width > 220 ? 4 : maxShift;
      move(el, near ? clamp(dx * strength, -cap, cap) : 0, near ? clamp(dy * strength, -cap, cap) : 0);
    });
  };

  const reset = (): void => {
    document.querySelectorAll<HTMLElement>(MAGNETIC_SELECTOR).forEach((el) => move(el, 0, 0));
  };

  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', reset);
  window.addEventListener('blur', reset);
  return () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', reset);
    window.removeEventListener('blur', reset);
    document.querySelectorAll<HTMLElement>(MAGNETIC_SELECTOR).forEach((el) => {
      el.removeAttribute('data-fx-magnetic');
      el.style.removeProperty('translate');
    });
  };
};

/* ---------------------------- Tilt (Motion Primitives) ------------------- */

const startTilt = (): Cleanup => {
  const card = $<HTMLElement>('.import-card');
  if (!card) return noop;
  const max = 3.2;
  let settle: MotionControls | undefined;
  let epoch = 0;

  const tiltTo = (rx: number, ry: number, done?: () => void): void => {
    const mine = ++epoch;
    if (!card.hasAttribute('data-fx-tilting')) {
      card.style.setProperty('--fx-rx', '0deg');
      card.style.setProperty('--fx-ry', '0deg');
      card.setAttribute('data-fx-tilting', '');
    }
    settle?.stop();
    settle = M?.animate(card, { '--fx-rx': `${rx}deg`, '--fx-ry': `${ry}deg` }, { ...SPRING, stiffness: 140, damping: 16 });
    // `done` ne s'exécute que si aucun nouveau mouvement n'a démarré entre-temps.
    const finish = (): void => {
      if (done && mine === epoch) done();
    };
    if (done) void Promise.resolve(settle).then(finish, finish);
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || card.classList.contains('drag')) return;
    const r = card.getBoundingClientRect();
    const nx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    const ny = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
    tiltTo(-ny * max, nx * max);
  };

  const onLeave = (): void => {
    card.style.removeProperty('--mx');
    card.style.removeProperty('--my');
    tiltTo(0, 0, () => card.removeAttribute('data-fx-tilting'));
  };

  card.addEventListener('pointermove', onMove, { passive: true });
  card.addEventListener('pointerleave', onLeave);
  return () => {
    card.removeEventListener('pointermove', onMove);
    card.removeEventListener('pointerleave', onLeave);
    settle?.stop();
    card.removeAttribute('data-fx-tilting');
    card.style.removeProperty('--fx-rx');
    card.style.removeProperty('--fx-ry');
    card.style.removeProperty('--mx');
    card.style.removeProperty('--my');
  };
};

/* ------------------- Barre de progression de lecture --------------------- */

const startProgress = (): Cleanup => {
  const bar = document.createElement('div');
  bar.className = 'fx-progress';
  bar.setAttribute('aria-hidden', 'true');
  document.body.append(bar);
  const stop = M?.scroll((p) => {
    bar.style.transform = `scaleX(${clamp(p, 0, 1)})`;
    bar.classList.toggle('on', p > 0.004);
  });
  return () => {
    stop?.();
    bar.remove();
  };
};

/* ------------- Entrées au scroll + titre mot à mot (Text Effect) --------- */

let revealDone = false;
/** Branché par la scène 3D quand elle existe ; sans effet sinon. */
let applyHeroColors: (hexes: string[] | null) => void = noop;

/** Découpe les mots d'un titre ; l'élément .hero-accent reste un bloc unique (son dégradé en dépend). */
const splitWords = (el: HTMLElement): HTMLElement[] => {
  const units: HTMLElement[] = [];
  Array.from(el.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const frag = document.createDocumentFragment();
      (node.textContent ?? '').split(/(\s+)/).forEach((token) => {
        if (!token) return;
        if (/^\s+$/.test(token)) {
          frag.append(document.createTextNode(token));
          return;
        }
        const span = document.createElement('span');
        span.className = 'fx-w';
        span.textContent = token;
        units.push(span);
        frag.append(span);
      });
      node.replaceWith(frag);
    } else if (node instanceof HTMLElement) {
      node.classList.add('fx-w');
      units.push(node);
    }
  });
  return units;
};

const clearInline = (els: Iterable<HTMLElement>): void => {
  for (const el of els) {
    el.style.removeProperty('opacity');
    el.style.removeProperty('transform');
    el.style.removeProperty('translate');
    el.style.removeProperty('scale');
    el.style.removeProperty('rotate');
    el.style.removeProperty('filter');
    el.style.removeProperty('will-change');
  }
};

const startReveal = (): Cleanup => {
  if (revealDone) return noop;
  revealDone = true;
  const hidden = new Set<HTMLElement>();
  const stops: Cleanup[] = [];

  // Titre d'accueil : floute puis révèle chaque mot.
  const h1 = $<HTMLElement>('#extractTitle');
  if (h1) {
    const words = splitWords(h1);
    words.forEach((w) => {
      w.style.opacity = '0';
      hidden.add(w);
    });
    stops.push(
      M!.inView(h1, () => {
        const run = M!.animate(
          words,
          { opacity: [0, 1], y: [14, 0], filter: ['blur(8px)', 'blur(0px)'] },
          { duration: 0.7, ease: EASE, delay: M!.stagger(0.08, { startDelay: 0.05 }) },
        );
        void Promise.resolve(run).then(() => clearInline(words), () => clearInline(words));
      }),
    );
  }

  // Cartes d'outils : entrée décalée quand elles arrivent à l'écran.
  const cards = Array.from(document.querySelectorAll<HTMLElement>('.tool-card'));
  cards.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const offscreen = r.width === 0 || r.top > window.innerHeight * 0.92;
    if (!offscreen) return;
    el.style.opacity = '0';
    hidden.add(el);
    stops.push(
      M!.inView(
        el,
        () => {
          const run = M!.animate(el, { opacity: [0, 1], y: [22, 0] }, { duration: 0.55, ease: EASE, delay: (i % 3) * 0.07 });
          void Promise.resolve(run).then(() => clearInline([el]), () => clearInline([el]));
        },
        { amount: 0.25 },
      ),
    );
  });

  // Filet de sécurité : si l'observation ne se déclenche jamais, rien ne reste invisible.
  const safety = window.setTimeout(() => clearInline(hidden), 8000);
  return () => {
    window.clearTimeout(safety);
    stops.forEach((s) => s());
    clearInline(hidden);
  };
};

/* -------------------------- Lenis (défilement fluide) -------------------- */

const startLenis = (): Cleanup => {
  let cancelled = false;
  let lenis: Any = null;
  let lockObserver: MutationObserver | null = null;

  idle(async () => {
    try {
      if (!window.Lenis) await loadScript(LENIS_URL);
      if (cancelled || !window.Lenis) return;
      lenis = new window.Lenis({ autoRaf: true, lerp: 0.11, smoothWheel: true, anchors: false });
      // Les dialogues natifs défilent seuls : on suspend Lenis tant que l'app verrouille la page.
      const sync = (): void => (document.body.classList.contains('lock') ? lenis?.stop() : lenis?.start());
      lockObserver = new MutationObserver(sync);
      lockObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      document.querySelectorAll('.dialog-body,.code').forEach((el) => el.setAttribute('data-lenis-prevent', ''));
      sync();
    } catch (err) {
      console.warn('[fx] Lenis indisponible, défilement natif conservé.', err);
    }
  });

  return () => {
    cancelled = true;
    lockObserver?.disconnect();
    lenis?.destroy();
    lenis = null;
  };
};

/* ------------------------- Scène 3D : pastilles couleur ------------------ */

const CHIP_SCALE_Y = [0.64, 0.85, 1, 0.78, 0.6];
const CHIP_TILT_Z = [-0.2, -0.08, 0.05, 0.13, 0.22];
const HEX = /^#[0-9a-f]{6}$/i;

/** Lit les couleurs de la palette affichée (les tuiles portent --c en style inline). */
const readPalette = (): string[] | null => {
  const view = $<HTMLElement>('#paletteView');
  if (!view || view.hidden) return null;
  const seen = new Set<string>();
  view.querySelectorAll<HTMLElement>('[style*="--c:"]').forEach((el) => {
    const hex = el.style.getPropertyValue('--c').trim();
    if (HEX.test(hex)) seen.add(hex.toUpperCase());
  });
  return seen.size ? Array.from(seen) : null;
};

const pickFive = (hexes: readonly string[]): string[] =>
  Array.from({ length: 5 }, (_, i) =>
    hexes.length >= 5 ? hexes[Math.round((i * (hexes.length - 1)) / 4)]! : hexes[i % hexes.length]!,
  );

const startHero3d = (): Cleanup => {
  const card = $<HTMLElement>('#dropZone');
  const slots = $<HTMLElement>('.import-slots');
  if (!card || !slots) return noop;

  let cancelled = false;
  let teardown: Cleanup = noop;
  let setColors: (hexes: string[] | null) => void = noop;

  const stage = document.createElement('div');
  stage.className = 'fx-stage';
  stage.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  slots.before(stage);

  const fail = (reason: unknown): void => {
    console.warn('[fx] Scène 3D désactivée, pastilles CSS conservées.', reason);
    teardown();
    teardown = noop;
    card.classList.remove('fx-3d-on');
    stage.remove();
  };

  idle(async () => {
    try {
      const THREE: Any = await import(/* webpackIgnore: true */ THREE_URL);
      if (cancelled) return;

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, 3.4, 0.1, 50);
      camera.position.set(0, 0, 3.05);
      scene.add(new THREE.AmbientLight(0xffffff, 1.15));
      const key = new THREE.DirectionalLight(0xffffff, 2.3);
      key.position.set(2, 3, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xff8b6e, 1.1);
      rim.position.set(-3, -1, 2);
      scene.add(rim);

      // Pastille aux coins arrondis, extrudée avec un léger biseau.
      const w = 0.6;
      const h = 1;
      const r = 0.15;
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2 + r, -h / 2);
      shape.lineTo(w / 2 - r, -h / 2);
      shape.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, false);
      shape.lineTo(w / 2, h / 2 - r);
      shape.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, false);
      shape.lineTo(-w / 2 + r, h / 2);
      shape.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, false);
      shape.lineTo(-w / 2, -h / 2 + r);
      shape.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, false);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.14,
        bevelEnabled: true,
        bevelThickness: 0.03,
        bevelSize: 0.03,
        bevelSegments: 3,
        curveSegments: 12,
      });
      geometry.center();

      const spin = [0, 0, 0, 0, 0];
      const chips = BRAND_COLORS.map((hex, i) => {
        const material = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.38, metalness: 0.04 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.set(1, CHIP_SCALE_Y[i], 1);
        mesh.position.set((i - 2) * 0.82, 0, 0);
        scene.add(mesh);
        return { mesh, material, target: new THREE.Color(hex) };
      });

      setColors = (hexes) => {
        const list = hexes && hexes.length ? pickFive(hexes) : [...BRAND_COLORS];
        chips.forEach((c, i) => c.target.set(list[i]));
      };
      applyHeroColors = setColors;

      // Pointeur (souris/stylet) : parallaxe douce. Au tactile, la scène se balance seule.
      const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
      const onMove = (e: PointerEvent): void => {
        if (e.pointerType === 'touch') return;
        const rect = card.getBoundingClientRect();
        pointer.tx = clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
        pointer.ty = clamp(((e.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
      };
      const onLeave = (): void => {
        pointer.tx = 0;
        pointer.ty = 0;
      };
      const onTap = (): void => {
        if (!M) return;
        chips.forEach((_, i) => {
          void M.animate(0, 1, {
            delay: i * 0.06,
            duration: 0.85,
            ease: EASE,
            onUpdate: (v: number) => {
              spin[i] = v * Math.PI * 2;
            },
          });
        });
      };
      card.addEventListener('pointermove', onMove, { passive: true });
      card.addEventListener('pointerleave', onLeave);
      stage.addEventListener('pointerdown', onTap);

      let needsResize = true;
      const resizeObserver = new ResizeObserver(() => {
        needsResize = true;
      });
      resizeObserver.observe(stage);

      // Boucle de rendu : active seulement quand la carte est visible et les animations permises.
      let inViewport = true;
      let frames = 0;
      let slowFrames = 0;
      let last = 0;
      const frame = (now: number): void => {
        if (needsResize) {
          const cw = stage.clientWidth;
          const ch = stage.clientHeight;
          if (cw > 0 && ch > 0) {
            renderer.setSize(cw, ch, false);
            camera.aspect = cw / ch;
            camera.updateProjectionMatrix();
            needsResize = false;
          }
        }
        const t = now / 1000;
        pointer.x += (pointer.tx - pointer.x) * 0.08;
        pointer.y += (pointer.ty - pointer.y) * 0.08;
        chips.forEach((c, i) => {
          c.mesh.position.y = Math.sin(t * 0.9 + i * 0.9) * 0.05;
          c.mesh.rotation.z = CHIP_TILT_Z[i]! + Math.sin(t * 0.6 + i) * 0.03;
          c.mesh.rotation.y = pointer.x * 0.55 + Math.sin(t * 0.7 + i * 0.7) * 0.18 + spin[i]!;
          c.mesh.rotation.x = -pointer.y * 0.3;
          c.material.color.lerp(c.target, 0.08);
        });
        renderer.render(scene, camera);

        // Garde-fou : si la machine rame, on revient aux pastilles CSS.
        if (last) {
          frames += 1;
          if (frames > 12 && now - last > 45) slowFrames += 1;
          if (frames === 100 && slowFrames > 40) fail(`rendu trop lent (${slowFrames}/88 images lentes)`);
        }
        last = now;
      };

      const refresh = (): void => {
        const run = inViewport && !document.hidden && canMove();
        renderer.setAnimationLoop(run ? frame : null);
        if (!run) last = 0;
      };
      const io = new IntersectionObserver((entries) => {
        inViewport = entries[entries.length - 1]?.isIntersecting ?? true;
        refresh();
      });
      io.observe(card);
      document.addEventListener('visibilitychange', refresh);
      const onLost = (e: Event): void => {
        e.preventDefault();
        fail('contexte WebGL perdu');
      };
      canvas.addEventListener('webglcontextlost', onLost);

      // Synchronisation avec la palette ouverte.
      let mo: MutationObserver | null = null;
      let debounce = 0;
      if (SYNC_HERO_WITH_PALETTE) {
        const view = $('#paletteView');
        if (view) {
          const sync = (): void => setColors(readPalette());
          mo = new MutationObserver(() => {
            window.clearTimeout(debounce);
            debounce = window.setTimeout(sync, 140);
          });
          mo.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
          sync();
        }
      }

      teardown = () => {
        applyHeroColors = noop;
        renderer.setAnimationLoop(null);
        io.disconnect();
        resizeObserver.disconnect();
        mo?.disconnect();
        window.clearTimeout(debounce);
        document.removeEventListener('visibilitychange', refresh);
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerleave', onLeave);
        stage.removeEventListener('pointerdown', onTap);
        canvas.removeEventListener('webglcontextlost', onLost);
        geometry.dispose();
        chips.forEach((c) => c.material.dispose());
        renderer.dispose();
        renderer.forceContextLoss?.();
      };

      refresh();
      // On révèle la scène une fois la première image rendue : pas de saut de mise en page.
      requestAnimationFrame(() => requestAnimationFrame(() => !cancelled && card.classList.add('fx-3d-on')));
    } catch (err) {
      fail(err);
    }
  });

  return () => {
    cancelled = true;
    teardown();
    card.classList.remove('fx-3d-on');
    stage.remove();
  };
};

/* ------------------------ Développeur et contacts ------------------------ */

type ContactIcon = 'chat' | 'mail' | 'phone' | 'link' | 'send';
interface ContactLink {
  label: string;
  href: string;
  icon: ContactIcon;
  primary?: boolean;
}
interface DeveloperProfile {
  name: string;
  role: string;
  place: string;
  pitch: string;
  contacts: ContactLink[];
}

/**
 * Contacts renseignés. Pour les changer, modifie les trois liens ci-dessous.
 * Tant qu'un lien contient un de ces repères, le bouton reste inactif (aucun faux lien en ligne).
 * Ajoute, retire ou réordonne librement les entrées.
 */
const DEVELOPER: DeveloperProfile = {
  name: 'ANONYX',
  role: 'Concepteur et développeur d’AnoPick',
  place: 'Ouagadougou, Burkina Faso',
  pitch: 'AnoPick est conçu et développé par ANONYX. Un retour, une idée, un projet ? Écris-moi directement.',
  contacts: [
    { label: 'WhatsApp', href: 'https://wa.me/22656967818', icon: 'chat', primary: true },
    { label: 'E-mail', href: 'mailto:anonyxdev@gmail.com', icon: 'mail' },
    { label: 'Appeler', href: 'tel:+22656967818', icon: 'phone' },
  ],
};

const PLACEHOLDER = /NUMERO|ADRESSE|exemple\.com|XXXX/;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

const ensureSprite = (): void => {
  if ($('#fx-sprite')) return;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<svg id="fx-sprite" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
      <symbol id="fx-i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></symbol>
      <symbol id="fx-i-chat" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></symbol>
      <symbol id="fx-i-phone" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/></symbol>
      <symbol id="fx-i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></symbol>
      <symbol id="fx-i-send" viewBox="0 0 24 24"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/></symbol>
    </defs></svg>`,
  );
};

const contactButton = (c: ContactLink): string => {
  const todo = PLACEHOLDER.test(c.href);
  const external = /^https?:/.test(c.href);
  const cls = `btn ${c.primary ? 'btn-primary' : 'btn-line'}${todo ? ' is-todo' : ''}`;
  const attrs = [
    `class="${cls}"`,
    `href="${esc(c.href)}"`,
    external ? 'target="_blank" rel="noopener noreferrer"' : '',
    todo ? 'aria-disabled="true" title="Contact à renseigner"' : '',
  ].join(' ');
  return `<a ${attrs}><svg class="i" aria-hidden="true"><use href="#fx-i-${c.icon}"/></svg>${esc(c.label)}${
    external ? '<span class="sr-only"> (s’ouvre dans un nouvel onglet)</span>' : ''
  }</a>`;
};

const developerSection = (variant: 'home' | 'settings'): string => {
  const id = `fxDevTitle-${variant}`;
  const head =
    variant === 'home'
      ? `<div class="section-head"><div><h2 id="${id}">Derrière AnoPick</h2><p class="note">Le développeur, et comment le joindre.</p></div></div>`
      : `<h2 class="sr-only" id="${id}">Le développeur</h2>`;
  return `<section class="section fx-dev-section${variant === 'settings' ? ' compact' : ''}" aria-labelledby="${id}">${head}
    <div class="card fx-dev">
      <span class="fx-dev-avatar" aria-hidden="true"><svg viewBox="0 0 32 32"><use href="#logo"/></svg></span>
      <div class="fx-dev-id"><strong class="fx-dev-name">${esc(DEVELOPER.name)}</strong><span class="fx-dev-role">${esc(DEVELOPER.role)}</span><span class="pill">${esc(DEVELOPER.place)}</span></div>
      <p class="fx-dev-pitch">${esc(DEVELOPER.pitch)}</p>
      <div class="fx-dev-actions">${DEVELOPER.contacts.map(contactButton).join('')}</div>
    </div></section>`;
};

const mountDeveloper = (): void => {
  ensureSprite();
  const home = $('#page-extract');
  if (home && !$('.fx-dev-section', home)) home.insertAdjacentHTML('beforeend', developerSection('home'));
  const settings = $('#page-settings');
  const credit = settings ? $('.credit', settings) : null;
  if (credit && !$('.fx-dev-section', settings!)) credit.insertAdjacentHTML('beforebegin', developerSection('settings'));
  const help = $('#page-settings [data-open="helpDialog"]');
  if (help && !$('#fxIntroReplay')) {
    help.insertAdjacentHTML(
      'beforebegin',
      `<button class="settings-row" type="button" id="fxIntroReplay"><span class="row-icon"><svg class="i" aria-hidden="true"><use href="#i-play"/></svg></span><span class="row-text"><strong>Revoir la présentation</strong><small>Ce que fait AnoPick, en trois écrans.</small></span><svg class="i" aria-hidden="true"><use href="#i-chev"/></svg></button>`,
    );
  }
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const dead = target?.closest<HTMLAnchorElement>('a.is-todo');
    if (dead) {
      e.preventDefault();
      console.warn('[fx] Contact non renseigné : complète DEVELOPER.contacts dans fx.ts.', dead.getAttribute('href'));
    }
    if (target?.closest('#fxIntroReplay')) openIntro(true);
  });
  const todo = DEVELOPER.contacts.filter((c) => PLACEHOLDER.test(c.href));
  if (todo.length) console.warn(`[fx] ${todo.length} contact(s) encore à renseigner :`, todo.map((c) => c.label).join(', '));
};

/* --------------------- Présentation d'accueil (3 écrans) ----------------- */

interface IntroStep {
  kicker: string;
  title: string;
  html: string;
  stage: string;
}

const INTRO_KEY = 'anopick_intro_v1';
let introSeenInMemory = false;
const introSeen = (): boolean => {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return introSeenInMemory;
  }
};
const markIntroSeen = (): void => {
  introSeenInMemory = true;
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    /* stockage indisponible : la mémoire de session suffit */
  }
};

const icon = (id: string): string => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;

const introSteps = (): IntroStep[] => [
  {
    kicker: 'Bienvenue',
    title: 'Ton image. Tes couleurs.',
    html: `<p>AnoPick repère les couleurs dominantes de n’importe quelle image et en fait une palette prête à l’emploi. Gratuit, sans compte : tes images ne quittent jamais ton appareil.</p>`,
    stage: `<div class="fx-fan" aria-hidden="true"><i data-pop></i><i data-pop></i><i data-pop></i><i data-pop></i><i data-pop></i></div>`,
  },
  {
    kicker: 'Comment ça marche',
    title: 'De l’image au code, en trois gestes.',
    html: `<ul class="fx-intro-list">
      <li><span class="num">1</span><span><b>Importer</b><small>Dépose, colle ou photographie une image.</small></span></li>
      <li><span class="num">2</span><span><b>Affiner</b><small>Pipette, noms, rôles, contraste WCAG, nuances et dégradés.</small></span></li>
      <li><span class="num">3</span><span><b>Exporter</b><small>CSS, Tailwind, SCSS ou JSON, en un clic.</small></span></li>
    </ul>`,
    stage: `<div class="fx-steps" aria-hidden="true">
      <div class="fx-step" data-pop><span class="node">${icon('i-image')}</span>Importer</div>
      <div class="fx-step" data-pop><span class="node">${icon('i-pipette')}</span>Affiner</div>
      <div class="fx-step" data-pop><span class="node">${icon('i-code')}</span>Exporter</div></div>`,
  },
  {
    kicker: 'Le développeur',
    title: `Un outil signé ${esc(DEVELOPER.name)}.`,
    html: `<p>${esc(DEVELOPER.role)}, depuis ${esc(DEVELOPER.place)}. Pour le contacter, rendez-vous tout en bas de l’accueil ou dans les réglages.</p>`,
    stage: `<div class="fx-person" data-pop aria-hidden="true"><span><svg viewBox="0 0 32 32"><use href="#logo"/></svg></span></div>`,
  },
];

let introEl: HTMLDialogElement | null = null;
let introIndex = 0;
let introBusy = false;
let introReturnFocus: HTMLElement | null = null;

const renderIntro = (d: HTMLDialogElement): void => {
  const steps = introSteps();
  const s = steps[introIndex]!;
  $('.fx-intro-stage', d)!.innerHTML = s.stage;
  $('.fx-intro-kicker', d)!.textContent = s.kicker;
  $('#fxIntroTitle', d)!.innerHTML = s.title;
  $('.fx-intro-text', d)!.innerHTML = s.html;
  d.querySelectorAll('.fx-intro-dots i').forEach((dot, i) => dot.classList.toggle('on', i === introIndex));
  $('.fx-intro-step', d)!.textContent = `Étape ${introIndex + 1} sur ${steps.length}`;
  const last = introIndex === steps.length - 1;
  $<HTMLElement>('[data-fx="back"]', d)!.hidden = introIndex === 0;
  $<HTMLElement>('[data-fx="skip"]', d)!.hidden = last;
  $('[data-fx="next"]', d)!.textContent = last ? 'Commencer' : 'Suivant';
};

const popStage = (d: HTMLDialogElement): void => {
  if (!canMove() || !M) return;
  const items = d.querySelectorAll<HTMLElement>('.fx-intro-stage [data-pop]');
  if (!items.length) return;
  void M.animate(
    items,
    { opacity: [0, 1], scale: [0.55, 1], y: [18, 0] },
    { type: 'spring', stiffness: 230, damping: 17, mass: 0.7, delay: M.stagger(0.07, { startDelay: 0.05 }) },
  );
};

const closeIntro = async (): Promise<void> => {
  const d = introEl;
  if (!d || !d.open) return;
  const card = $<HTMLElement>('.fx-intro-card', d);
  if (card && canMove() && M) await M.animate(card, { opacity: [1, 0], scale: [1, 0.96], y: [0, 10] }, { duration: 0.2, ease: EASE });
  d.close();
};

const stepIntro = async (to: number): Promise<void> => {
  const d = introEl;
  if (!d || introBusy || to < 0 || to >= introSteps().length) return;
  introBusy = true;
  const dir = to > introIndex ? 1 : -1;
  const copy = $<HTMLElement>('.fx-intro-copy', d)!;
  if (canMove() && M) await M.animate(copy, { opacity: [1, 0], x: [0, -22 * dir] }, { duration: 0.14, ease: 'easeIn' });
  introIndex = to;
  renderIntro(d);
  if (canMove() && M) {
    void M.animate(copy, { opacity: [0, 1], x: [26 * dir, 0] }, { duration: 0.34, ease: EASE });
    popStage(d);
  }
  introBusy = false;
};

const buildIntro = (): HTMLDialogElement => {
  const d = document.createElement('dialog');
  d.className = 'fx-intro';
  d.setAttribute('aria-labelledby', 'fxIntroTitle');
  d.innerHTML = `<div class="fx-intro-shell"><div class="fx-intro-card">
    <div class="fx-intro-stage" aria-hidden="true"></div>
    <div class="fx-intro-copy"><p class="fx-intro-kicker"></p><h2 id="fxIntroTitle"></h2><div class="fx-intro-text"></div></div>
    <div class="fx-intro-foot">
      <div class="fx-intro-dots" aria-hidden="true"><i></i><i></i><i></i></div>
      <span class="sr-only fx-intro-step" aria-live="polite"></span>
      <div class="fx-intro-actions">
        <button class="text-btn" type="button" data-fx="skip">Passer</button>
        <button class="btn btn-line" type="button" data-fx="back">Retour</button>
        <button class="btn btn-primary" type="button" data-fx="next">Suivant</button>
      </div>
    </div></div></div>`;
  d.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-fx]');
    if (!btn) return;
    const act = btn.dataset.fx;
    if (act === 'skip') void closeIntro();
    else if (act === 'back') void stepIntro(introIndex - 1);
    else if (act === 'next') {
      if (introIndex >= introSteps().length - 1) void closeIntro();
      else void stepIntro(introIndex + 1);
    }
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') void stepIntro(introIndex + 1);
    else if (e.key === 'ArrowLeft') void stepIntro(introIndex - 1);
  });
  d.addEventListener('close', () => {
    markIntroSeen();
    // La sortie animée « fige » opacity:0 sur la carte : on la remet à neuf pour le prochain affichage.
    $<HTMLElement>('.fx-intro-card', d)?.removeAttribute('style');
    $<HTMLElement>('.fx-intro-copy', d)?.removeAttribute('style');
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('lock');
    introReturnFocus?.focus?.();
    introReturnFocus = null;
  });
  document.body.append(d);
  return d;
};

const openIntro = (force = false): void => {
  if (!force && introSeen()) return;
  introEl ??= buildIntro();
  const d = introEl;
  if (d.open) return;
  introReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  introIndex = 0;
  introBusy = false;
  $<HTMLElement>('.fx-intro-card', d)?.removeAttribute('style');
  renderIntro(d);
  d.showModal();
  document.body.classList.add('lock');
  $<HTMLElement>('[data-fx="next"]', d)?.focus();
  if (canMove() && M) {
    void M.animate($<HTMLElement>('.fx-intro-card', d)!, { opacity: [0, 1], scale: [0.93, 1], y: [26, 0] }, { type: 'spring', stiffness: 210, damping: 22, mass: 0.9 });
    popStage(d);
  }
};

/** Première visite seulement ; un utilisateur qui a déjà des palettes n'est pas dérangé. */
const scheduleIntro = (): void => {
  const run = (): void => {
    if (introSeen()) return;
    window.setTimeout(() => {
      if (introSeen()) return;
      const saved = Number($('#collectionCount')?.textContent ?? '0');
      if (saved > 0) {
        markIntroSeen();
        return;
      }
      openIntro();
    }, 900);
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
};

/* ------------------- Transitions entre pages (une par page) -------------- */

const PAGE_ORDER = ['extract', 'palette', 'lab', 'settings'];

interface Play {
  targets: HTMLElement[];
  keys: Record<string, unknown[]>;
  /** Variante par élément (ex. chaque carte arrive d'un côté différent). */
  each?: (i: number) => Record<string, unknown[]>;
  delay?: number;
  duration?: number;
  spring?: boolean;
  stagger?: number;
  from?: 'first' | 'center' | 'last';
}

const isShown = (el: Element): boolean => el.getClientRects().length > 0;
const pick = (scope: ParentNode, sel: string, max = 40): HTMLElement[] =>
  Array.from(scope.querySelectorAll<HTMLElement>(sel)).filter(isShown).slice(0, max);

const CHOREO: Record<string, (page: HTMLElement) => Play[]> = {
  /* Accueil : la carte monte, les outils arrivent de part et d'autre, puis la collection et le développeur. */
  extract: (p): Play[] => [
    { targets: pick(p, '.import-hero h1'), keys: { y: [-16, 0], filter: ['blur(6px)', 'blur(0px)'] }, duration: 0.5 },
    { targets: pick(p, '#dropZone'), keys: { y: [30, 0], scale: [0.95, 1] }, spring: true, delay: 0.08 },
    { targets: pick(p, '.slot-float'), keys: { y: [18, 0], scale: [0.5, 1] }, spring: true, delay: 0.22, stagger: 0.06 },
    { targets: pick(p, '.section-head'), keys: { x: [-20, 0] }, duration: 0.45, delay: 0.3, stagger: 0.12 },
    {
      targets: pick(p, '.tool-card'),
      keys: { y: [24, 0] },
      each: (i): Record<string, unknown[]> => (i === 0 ? { x: [-46, 0] } : i === 2 ? { x: [46, 0] } : { y: [38, 0], scale: [0.94, 1] }),
      spring: true,
      delay: 0.34,
      stagger: 0.09,
    },
    { targets: pick(p, '.collection-toolbar,.empty-collection'), keys: { y: [18, 0] }, duration: 0.45, delay: 0.55, stagger: 0.06 },
    { targets: pick(p, '.collection-card', 12), keys: { y: [24, 0], scale: [0.96, 1] }, spring: true, delay: 0.6, stagger: 0.05 },
    { targets: pick(p, '.fx-dev'), keys: { y: [34, 0], scale: [0.97, 1] }, spring: true, delay: 0.75 },
  ],
  /* Palette : en-tête du haut, image par la gauche, réglages par la droite, puces en éventail depuis le centre. */
  palette: (p): Play[] => [
    { targets: pick(p, '.empty-mark'), keys: { scale: [0.5, 1], rotate: [-12, 0] }, spring: true },
    { targets: pick(p, '#paletteEmpty h1,#paletteEmpty > p'), keys: { y: [20, 0] }, duration: 0.5, delay: 0.12, stagger: 0.08 },
    { targets: pick(p, '#paletteEmpty .actions .btn'), keys: { y: [18, 0] }, duration: 0.45, delay: 0.3, stagger: 0.08 },
    { targets: pick(p, '.palette-header'), keys: { y: [-22, 0] }, duration: 0.5 },
    { targets: pick(p, '.preview-panel'), keys: { x: [-44, 0] }, spring: true, delay: 0.08 },
    { targets: pick(p, '.palette-controls'), keys: { x: [44, 0] }, spring: true, delay: 0.14 },
    { targets: pick(p, '.count-chips button'), keys: { scale: [0.6, 1] }, spring: true, delay: 0.3, stagger: 0.03 },
    { targets: pick(p, '.swatch-card', 24), keys: { y: [24, 0], scale: [0.84, 1] }, spring: true, delay: 0.28, stagger: 0.05, from: 'center' },
    { targets: pick(p, '#paletteList > *', 24), keys: { x: [-22, 0] }, duration: 0.4, delay: 0.3, stagger: 0.04 },
    { targets: pick(p, '.export-card'), keys: { y: [30, 0] }, spring: true, delay: 0.55 },
  ],
  /* Labo : le sélecteur d'outil se déploie, la fiche principale arrive de la gauche, l'aide de la droite, les nuances en vague. */
  lab: (p): Play[] => [
    { targets: pick(p, '.page-head'), keys: { y: [-16, 0] }, duration: 0.45 },
    { targets: pick(p, '#labSeg'), keys: { scale: [0.88, 1] }, spring: true, delay: 0.08 },
    { targets: pick(p, '#labSeg button'), keys: { y: [10, 0] }, duration: 0.35, delay: 0.15, stagger: 0.06 },
    {
      targets: pick(p, '.lab-panel:not([hidden]) .lab-layout > *, .lab-panel:not([hidden]) .lab-empty'),
      keys: { y: [26, 0] },
      each: (i) => (i === 0 ? { x: [-38, 0] } : { x: [38, 0] }),
      spring: true,
      delay: 0.2,
      stagger: 0.1,
    },
    { targets: pick(p, '.shades .shade', 12), keys: { y: [18, 0], scale: [0.7, 1] }, spring: true, delay: 0.42, stagger: 0.04 },
  ],
  /* Réglages : les cartes se posent l'une après l'autre, leurs lignes glissent, la carte vedette pivote en place. */
  settings: (p): Play[] => [
    { targets: pick(p, '.page-head'), keys: { y: [-16, 0] }, duration: 0.45 },
    { targets: pick(p, '.settings-card:not(.hero)'), keys: { y: [32, 0], scale: [0.97, 1] }, spring: true, delay: 0.1, stagger: 0.09 },
    { targets: pick(p, '.settings-card:not(.hero) .settings-row'), keys: { x: [-18, 0] }, duration: 0.38, delay: 0.32, stagger: 0.04 },
    { targets: pick(p, '.settings-card.hero'), keys: { scale: [0.9, 1], rotate: [-2, 0] }, spring: true, delay: 0.3 },
    { targets: pick(p, '.fx-dev'), keys: { y: [30, 0] }, spring: true, delay: 0.55 },
    { targets: pick(p, '.credit'), keys: { y: [10, 0] }, duration: 0.4, delay: 0.7 },
  ],
};

const startTransitions = (): Cleanup => {
  const pages = Array.from(document.querySelectorAll<HTMLElement>('.page'));
  const idOf = (p: HTMLElement): string => p.id.replace(/^page-/, '');
  let current = idOf(pages.find((p) => p.classList.contains('active')) ?? pages[0]!);
  let touched = new Set<HTMLElement>();
  let controls: MotionControls[] = [];
  let safety = 0;
  const ghosts = new Set<HTMLElement>();

  const abort = (): void => {
    window.clearTimeout(safety);
    // cancel() et non stop() : stop() « fige » la valeur courante (souvent opacity:0) dans le style de l'élément.
    controls.forEach((c) => c.cancel());
    controls = [];
    clearInline(touched);
    touched = new Set();
  };

  const play = (plans: Play[]): void => {
    abort();
    let longest = 0;
    for (const plan of plans) {
      const els = plan.targets;
      if (!els.length) continue;
      els.forEach((el) => {
        el.style.opacity = '0';
        touched.add(el);
      });
      const base = plan.delay ?? 0;
      const transition = (delay: number | unknown): Record<string, unknown> =>
        plan.spring
          ? { type: 'spring', stiffness: 230, damping: 21, mass: 0.8, delay }
          : { duration: plan.duration ?? 0.5, ease: EASE, delay };
      if (plan.each) {
        els.forEach((el, i) => {
          const delay = base + i * (plan.stagger ?? 0);
          controls.push(M!.animate(el, { opacity: [0, 1], ...plan.keys, ...plan.each!(i) }, transition(delay)));
          longest = Math.max(longest, delay);
        });
      } else {
        const delay = plan.stagger ? M!.stagger(plan.stagger, { startDelay: base, from: plan.from ?? 'first' }) : base;
        controls.push(M!.animate(els, { opacity: [0, 1], ...plan.keys }, transition(delay)));
        longest = Math.max(longest, base + (plan.stagger ?? 0) * els.length);
      }
    }
    // Nettoyage : une fois fini, plus aucun style en ligne ne traîne ; filet de sécurité si l'animation est interrompue.
    const done = Promise.all(controls.map((c) => Promise.resolve(c).catch(() => undefined)));
    const mine = touched;
    void done.then(() => {
      if (mine === touched) clearInline(mine);
    });
    safety = window.setTimeout(() => clearInline(mine), (longest + 1.6) * 1000);
  };

  /** Fantôme de la page quittée : il s'efface en glissant pendant que la nouvelle entre. */
  const ghostOut = (dir: number): void => {
    const page = pages.find((p) => p.classList.contains('active'));
    if (!page || lowEnd() || !M) return;
    const r = page.getBoundingClientRect();
    if (!r.width || r.bottom < 0) return;
    const g = page.cloneNode(true) as HTMLElement;
    g.removeAttribute('id');
    g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    g.querySelectorAll('[tabindex]').forEach((n) => n.removeAttribute('tabindex'));
    g.classList.add('fx-ghost');
    g.setAttribute('aria-hidden', 'true');
    g.setAttribute('inert', '');
    Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${Math.min(r.height, window.innerHeight * 2)}px` });
    document.body.append(g);
    ghosts.add(g);
    const remove = (): void => {
      g.remove();
      ghosts.delete(g);
    };
    // Sur écran tactile, pas de flou : il coûte cher sur un grand élément et fait saccader la transition.
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const run = M.animate(
      g,
      touch ? { opacity: [1, 0], x: [0, -22 * dir] } : { opacity: [1, 0], x: [0, -34 * dir], scale: [1, 0.985], filter: ['blur(0px)', 'blur(5px)'] },
      { duration: touch ? 0.2 : 0.26, ease: 'easeIn' },
    );
    void Promise.resolve(run).then(remove, remove);
    window.setTimeout(remove, 900);
  };

  const onNavClick = (e: MouseEvent): void => {
    const t = (e.target as Element | null)?.closest<HTMLElement>('[data-tab],[data-go],.brand');
    if (!t) return;
    const target = t.dataset.tab ?? t.dataset.go ?? (t.classList.contains('brand') ? 'extract' : '');
    if (!target || target === current || !PAGE_ORDER.includes(target)) return;
    ghostOut(PAGE_ORDER.indexOf(target) > PAGE_ORDER.indexOf(current) ? 1 : -1);
  };

  const observer = new MutationObserver(() => {
    const active = pages.find((p) => p.classList.contains('active'));
    if (!active) return;
    const id = idOf(active);
    if (id === current) return;
    current = id;
    // Filet de sécurité : aucun reste d'une transition interrompue ne doit survivre sur cette page.
    clearInline(Array.from(active.querySelectorAll<HTMLElement>('[style*="opacity"]')));
    const plans = CHOREO[id]?.(active);
    if (plans) play(plans);
  });
  pages.forEach((p) => observer.observe(p, { attributes: true, attributeFilter: ['class'] }));

  // Changement d'outil dans le Labo : le nouveau panneau entre du côté de son onglet.
  const labOrder = ['lab-contrast', 'lab-shades', 'lab-gradient'];
  let labCurrent = labOrder.find((id) => $(`#${id}`) && !$<HTMLElement>(`#${id}`)!.hidden) ?? labOrder[0]!;
  const labObserver = new MutationObserver(() => {
    const shown = labOrder.find((id) => !$<HTMLElement>(`#${id}`)?.hidden);
    if (!shown || shown === labCurrent) return;
    const dir = labOrder.indexOf(shown) > labOrder.indexOf(labCurrent) ? 1 : -1;
    labCurrent = shown;
    const panel = $<HTMLElement>(`#${shown}`)!;
    if (!isShown(panel)) return;
    play([
      {
        targets: pick(panel, '.lab-layout > *, .lab-empty'),
        keys: { y: [18, 0] },
        each: (i) => ({ x: [(i === 0 ? 40 : 64) * dir, 0] }),
        spring: true,
        stagger: 0.08,
      },
      { targets: pick(panel, '.shades .shade', 12), keys: { y: [16, 0], scale: [0.7, 1] }, spring: true, delay: 0.15, stagger: 0.035 },
    ]);
  });
  labOrder.forEach((id) => {
    const el = $(`#${id}`);
    if (el) labObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });

  document.addEventListener('click', onNavClick, true);
  return () => {
    document.removeEventListener('click', onNavClick, true);
    observer.disconnect();
    labObserver.disconnect();
    abort();
    ghosts.forEach((g) => g.remove());
    ghosts.clear();
  };
};

/* --------------------------- Chef d'orchestre ---------------------------- */

const features: Feature[] = [
  { name: 'paused', needs: () => true, start: watchPaused },
  { name: 'spotlight', needs: () => fineMQ.matches, start: startSpotlight },
  { name: 'magnetic', needs: () => fineMQ.matches, start: startMagnetic },
  { name: 'tilt', needs: () => fineMQ.matches, start: startTilt },
  { name: 'progress', needs: () => true, start: startProgress },
  { name: 'reveal', needs: () => true, start: startReveal },
  { name: 'lenis', needs: () => fineMQ.matches && !saveData(), start: startLenis },
  { name: 'transitions', needs: () => true, start: startTransitions },
  { name: 'hero3d', needs: () => !lowEnd() && webglAvailable(), start: startHero3d },
];

const active = new Map<string, Cleanup>();

const sync = (): void => {
  const allowed = canMove();
  for (const f of features) {
    const should = allowed && f.needs();
    const running = active.has(f.name);
    try {
      if (should && !running) active.set(f.name, f.start());
      else if (!should && running) {
        active.get(f.name)?.();
        active.delete(f.name);
      }
    } catch (err) {
      console.warn(`[fx] « ${f.name} » désactivé.`, err);
      active.delete(f.name);
    }
  }
};

const boot = (): void => {
  mountDeveloper();
  scheduleIntro();
  if (!M) {
    console.warn('[fx] Motion introuvable : aucune amélioration appliquée.');
    return;
  }
  sync();
  // Le réglage « Animations douces » de l'app bascule la classe .reduce-motion sur <html>.
  let wasReduced = root.classList.contains('reduce-motion');
  new MutationObserver(() => {
    const now = root.classList.contains('reduce-motion');
    if (now !== wasReduced) {
      wasReduced = now;
      sync();
    }
  }).observe(root, { attributes: true, attributeFilter: ['class'] });
  reducedMQ.addEventListener('change', sync);
  fineMQ.addEventListener('change', sync);

  window.AnoPickFX = {
    state: () => Object.fromEntries(features.map((f) => [f.name, active.has(f.name)])),
    setPalette: (hexes) => applyHeroColors(hexes),
  };
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

export {};
