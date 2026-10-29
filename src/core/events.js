// 全局事件日志：HUD 终端面板显示最近几条，如「779.2s table contact」

const T0 = performance.now();

export const clock = () => (performance.now() - T0) / 1000;

class EventLog {
  constructor(max = 40) {
    this.max = max;
    this.items = []; // { t, text, type }，旧→新
    this.listeners = [];
  }

  push(text, type = 'info') {
    const e = { t: clock(), text, type };
    this.items.push(e);
    if (this.items.length > this.max) this.items.shift();
    for (const fn of this.listeners) fn(e);
    return e;
  }

  latest(n) {
    return this.items.slice(-n);
  }

  on(fn) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((f) => f !== fn));
  }
}

export const events = new EventLog();
