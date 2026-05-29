// Wrapper log — attivo solo se ?debug=1 in URL
const isDebug = new URLSearchParams(location.search).has('debug');

const debug = {
  log: (...args) => { if (isDebug) console.log('[SIMULE]', ...args); },
  warn: (...args) => { if (isDebug) console.warn('[SIMULE]', ...args); },
  error: (...args) => { if (isDebug) console.error('[SIMULE]', ...args); },
  group: (label) => { if (isDebug) console.group('[SIMULE] ' + label); },
  groupEnd: () => { if (isDebug) console.groupEnd(); },
  time: (label) => { if (isDebug) console.time('[SIMULE] ' + label); },
  timeEnd: (label) => { if (isDebug) console.timeEnd('[SIMULE] ' + label); }
};

export default debug;
