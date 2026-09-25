'use strict';

// Polls the virtual file the main thread rewrites every half second.
const show = async () => {
  const res = await fetch('/live/stats.json');
  const worker = res.headers.get('x-worker');
  const stats = await res.json();
  document.getElementById('stats').textContent =
    `tick ${stats.tick} at ${stats.time}, answered by worker ${worker}`;
};

setInterval(show, 500);
show();
