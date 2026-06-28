// ============ Sticky nav on scroll ============
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

// ============ Mobile menu toggle ============
const navToggle = document.getElementById('navToggle');
navToggle?.addEventListener('click', () => nav.classList.toggle('open'));
document.querySelectorAll('.nav-links a').forEach((a) =>
  a.addEventListener('click', () => nav.classList.remove('open'))
);

// ============ Reveal on scroll ============
const revealEls = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          // small stagger for siblings entering together
          entry.target.style.transitionDelay = `${Math.min(i * 70, 280)}ms`;
          entry.target.classList.add('in');
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  revealEls.forEach((el) => io.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add('in'));
}

// ============ 3D tilt on hero window ============
const tilt = document.getElementById('tiltCard');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (tilt && !reduceMotion && window.matchMedia('(min-width: 901px)').matches) {
  const visual = tilt.closest('.hero-visual');
  visual.addEventListener('mousemove', (e) => {
    const r = tilt.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    tilt.style.transform = `rotateX(${8 - py * 10}deg) rotateY(${px * 12}deg)`;
  });
  visual.addEventListener('mouseleave', () => {
    tilt.style.transform = 'rotateX(8deg) rotateY(0deg)';
  });
}

// ============ Pointer-follow glow on feature cards ============
document.querySelectorAll('.card').forEach((card) => {
  card.addEventListener('mousemove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
});

// ============ Animated counters ============
const counters = document.querySelectorAll('.stat-num[data-count]');
const animateCount = (el) => {
  const target = parseInt(el.dataset.count, 10);
  const suffix = el.dataset.suffix || '';
  const duration = 1400;
  const start = performance.now();
  const step = (now) => {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = Math.round(target * eased) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
if (counters.length && 'IntersectionObserver' in window) {
  const cio = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          animateCount(entry.target);
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.6 }
  );
  counters.forEach((c) => cio.observe(c));
} else {
  counters.forEach((c) => (c.textContent = c.dataset.count + (c.dataset.suffix || '')));
}

// ============ Subtle parallax on background blobs ============
if (!reduceMotion) {
  const blobs = document.querySelectorAll('.blob');
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      blobs.forEach((b, i) => {
        b.style.translate = `0 ${y * (0.04 + i * 0.02)}px`;
      });
    },
    { passive: true }
  );
}
