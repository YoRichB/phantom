// Phantom kill switch — manual halt control.
//   node halt.js on [reason]    stop all NEW opens immediately (grading/exits keep running)
//   node halt.js off            resume normal operation
//   node halt.js status         report halt state as JSON
// The HALT file lives at DIR/HALT. paper.js live() refuses to open new
// positions while it exists; live.js refuses to enable or place anything.
const fs = require('fs');
const path = require('path');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const HALT = path.join(DIR, 'HALT');

const cmd = process.argv[2];
if (cmd === 'on'){
  const reason = process.argv.slice(3).join(' ') || 'manual halt';
  fs.writeFileSync(HALT, JSON.stringify({ halted_at: new Date().toISOString(), reason }, null, 1));
  console.log(JSON.stringify({ halted: true, reason }));
} else if (cmd === 'off'){
  try { fs.unlinkSync(HALT); } catch(e){}
  console.log(JSON.stringify({ halted: false }));
} else if (cmd === 'status'){
  let info = null;
  try { info = JSON.parse(fs.readFileSync(HALT, 'utf8')); } catch(e){}
  console.log(JSON.stringify({ halted: !!info, ...(info || {}) }));
} else {
  console.error('usage: node halt.js [on [reason]|off|status]');
  process.exit(2);
}
