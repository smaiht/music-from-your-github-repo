'use strict';
// Side panel: the expanded tree as text, virtualised, following the playhead.

class TreePanel {
  constructor(scroller, inner, onPick) {
    this.sc = scroller;
    this.inner = inner;
    this.onPick = onPick;
    this.RH = 22;
    this.lines = [];
    this.cur = -1;
    this.userScrollAt = 0;
    this.programmatic = false;
    this.pool = new Map();
    scroller.addEventListener('scroll', () => {
      if (this.programmatic) { this.programmatic = false; } else this.userScrollAt = performance.now();
      this.render();
    }, { passive: true });
    inner.addEventListener('click', (ev) => {
      const row = ev.target.closest('.tp-row');
      if (row) this.onPick(Number(row.dataset.i));
    });
    inner.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('.tp-row');
      if (row) { ev.preventDefault(); this.onPick(Number(row.dataset.i)); }
    });
  }

  setModel(model) {
    this.lines = model.lines;
    this.cur = -1;
    this.pool.forEach((el) => el.remove());
    this.pool.clear();
    this.inner.style.height = `${this.lines.length * this.RH}px`;
    this.sc.scrollTop = 0;
    this.render();
  }

  rowFor(i) {
    const l = this.lines[i];
    const row = document.createElement('div');
    row.className = 'tp-row';
    row.dataset.i = i;
    row.tabIndex = -1;
    row.style.transform = `translateY(${i * this.RH}px)`;
    const guides = document.createElement('span');
    guides.className = 'tp-guides';
    guides.textContent = Model.prefix(l);
    const dot = document.createElement('span');
    dot.className = `tp-dot cat-${l.cat}`;
    const name = document.createElement('span');
    name.className = l.isDir ? 'tp-name is-dir' : 'tp-name';
    name.textContent = l.isDir && l.depth > 0 ? `${l.name}/` : l.name;
    row.append(guides, dot, name);
    if (!l.isDir && l.size) {
      const size = document.createElement('span');
      size.className = 'tp-size';
      size.textContent = U.fmtBytes(l.size);
      row.append(size);
    }
    row.title = l.path || l.name;
    return row;
  }

  render() {
    const n = this.lines.length;
    if (!n) return;
    const top = this.sc.scrollTop, h = this.sc.clientHeight || 400;
    const a = Math.max(0, Math.floor(top / this.RH) - 8);
    const b = Math.min(n, Math.ceil((top + h) / this.RH) + 8);
    for (const [i, el] of this.pool) {
      if (i < a || i >= b) { el.remove(); this.pool.delete(i); }
    }
    for (let i = a; i < b; i++) {
      let el = this.pool.get(i);
      if (!el) { el = this.rowFor(i); this.pool.set(i, el); this.inner.append(el); }
      el.classList.toggle('is-current', i === this.cur);
      el.classList.toggle('is-played', this.cur >= 0 && i < this.cur);
    }
  }

  setCurrent(i, follow) {
    if (i === this.cur) return;
    this.cur = i;
    if (follow && i >= 0 && performance.now() - this.userScrollAt > 2500) {
      const target = Math.max(0, i * this.RH - this.sc.clientHeight * 0.38);
      if (Math.abs(this.sc.scrollTop - target) > 1) {
        this.programmatic = true;
        this.sc.scrollTop = target;
      }
    }
    this.render();
  }
}
