// Offline ORIGINAL synthesized references, not wired into the game.
// No external samples, dependencies, network, or gameplay RNG.
// Run: node docs/Technical/assets/clear-celebration/build-audio-previews.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'audio');
fs.mkdirSync(out, { recursive: true });
const SR = 48000;
const noteHz = midi => 440 * 2 ** ((midi - 69) / 12);
const cues = [
  { id: 'place', duration: .16, peak: .11, notes: [[0, 60, .12, 'wood', 1]], paper: [] },
  { id: 'clear-l1', duration: .42, peak: .16, notes: [[0, 60, .14, 'wood', .65], [.07, 72, .29, 'mallet', 1]], paper: [[.045,.12,.055]] },
  { id: 'clear-l2', duration: .50, peak: .18, notes: [[0, 60, .14, 'wood', .65], [.065,72,.27,'mallet',.9], [.15,76,.28,'mallet',1]], paper: [[.045,.15,.065]] },
  { id: 'clear-l3', duration: .62, peak: .20, notes: [[0,60,.14,'wood',.6], [.06,72,.26,'mallet',.85], [.15,76,.28,'mallet',.9], [.24,79,.32,'bell',.75]], paper: [[.05,.17,.08]] },
  { id: 'clear-l4', duration: .76, peak: .22, notes: [[0,60,.14,'wood',.65], [.055,72,.28,'mallet',.9], [.15,76,.29,'mallet',.9], [.25,79,.31,'mallet',1], [.35,84,.34,'bell',.65]], paper: [[.05,.20,.09]] },
  { id: 'clear-l5', duration: .92, peak: .24, notes: [[0,60,.14,'wood',.65], [.055,72,.27,'mallet',.9], [.15,76,.3,'mallet',.95], [.25,79,.32,'mallet',1], [.36,84,.45,'bell',.65], [.36,76,.38,'mallet',.35]], paper: [[.05,.22,.10]] },
  { id: 'chain-milestone', duration: .44, peak: .13, notes: [[0,79,.23,'mallet',.8], [.10,84,.29,'bell',.7]], paper: [] },
  { id: 'new-best', duration: 1.12, peak: .25, notes: [[0,60,.18,'wood',.4], [.08,72,.29,'mallet',.8], [.20,76,.31,'mallet',.85], [.32,79,.34,'mallet',.95], [.46,84,.50,'bell',.8], [.46,76,.46,'mallet',.40], [.46,79,.44,'mallet',.35]], paper: [[.14,.26,.10]] },
  { id: 'item-hammer', duration: .25, peak: .16, notes: [[0,53,.17,'wood',1], [.035,65,.16,'mallet',.22]], paper: [[.012,.07,.10]] },
  { id: 'item-rocket', duration: .34, peak: .14, notes: [[.04,67,.19,'mallet',.5], [.12,72,.18,'mallet',.45]], paper: [[0,.24,.24]] },
  { id: 'item-bomb', duration: .36, peak: .15, notes: [[0,55,.19,'wood',.8], [.08,67,.22,'mallet',.36]], paper: [[.018,.23,.22]] },
  { id: 'item-refresh', duration: .30, peak: .12, notes: [[.015,67,.11,'wood',.4], [.10,72,.14,'wood',.45]], paper: [[0,.10,.20],[.105,.12,.15]] },
  { id: 'cancel', duration: .15, peak: .07, notes: [[0,57,.12,'wood',1]], paper: [] },
  { id: 'chain-break', duration: .34, peak: .09, notes: [[0,67,.16,'wood',.8],[.10,64,.19,'wood',.65]], paper: [] },
  { id: 'score-tick', duration: .07, peak: .035, notes: [[0,76,.055,'wood',1]], paper: [] },
  { id: 'score-settle', duration: .28, peak: .09, notes: [[0,72,.18,'mallet',.7],[.055,79,.20,'mallet',.65]], paper: [] },
  { id: 'game-over', duration: .46, peak: .10, notes: [[0,64,.24,'wood',.75],[.15,60,.24,'mallet',.55]], paper: [] },
];
function envelope(t, duration, decay) {
  if (t < 0 || t >= duration) return 0;
  return Math.min(1, t/.004) * Math.exp(-t/decay) * Math.min(1,(duration-t)/.018);
}
function addNote(buf, at, midi, dur, kind, gain) {
  const f=noteHz(midi), start=Math.round(at*SR), n=Math.round(dur*SR);
  for(let i=0;i<n && start+i<buf.length;i++) {
    const t=i/SR, phase=2*Math.PI*f*t;
    let s;
    if(kind==='wood') s=(Math.sin(phase)*Math.exp(-t/.044)+.32*Math.sin(phase*2.72)*Math.exp(-t/.019)+.10*Math.sin(phase*4.13)*Math.exp(-t/.009))*envelope(t,dur,.13);
    else if(kind==='bell') s=(Math.sin(phase)+.24*Math.sin(phase*2.01)*Math.exp(-t/.16)+.07*Math.sin(phase*3.98)*Math.exp(-t/.055))*envelope(t,dur,.19);
    else s=(Math.sin(phase)+.20*Math.sin(phase*2)*Math.exp(-t/.055)+.07*Math.sin(phase*3)*Math.exp(-t/.024))*envelope(t,dur,.10);
    buf[start+i]+=s*gain;
  }
}
function addPaper(buf, at, dur, gain, seed) {
  let x=seed>>>0, low=0, slower=0;
  const start=Math.round(at*SR), n=Math.round(dur*SR);
  for(let i=0;i<n && start+i<buf.length;i++) {
    x^=x<<13; x^=x>>>17; x^=x<<5;
    const noise=(x>>>0)/4294967296*2-1;
    low+=.18*(noise-low); slower+=.023*(noise-slower);
    const u=i/n, env=Math.sin(Math.PI*u)**1.6;
    buf[start+i]+=(low-slower)*gain*env;
  }
}
function render(cue, index) {
  const buf=new Float64Array(Math.round(cue.duration*SR));
  for(const [at,midi,dur,kind,gain] of cue.notes) addNote(buf,at,midi,dur,kind,gain);
  cue.paper.forEach(([at,dur,gain],n)=>addPaper(buf,at,dur,gain,1847+index*101+n));
  let peak=0; for(const s of buf) peak=Math.max(peak,Math.abs(s));
  const factor=cue.peak/Math.max(peak,1e-9);
  for(let i=0;i<buf.length;i++) buf[i]*=factor*Math.min(1,i/(SR*.002),(buf.length-1-i)/(SR*.004));
  return buf;
}
function encodeWav(samples) {
  const buf=Buffer.alloc(44+samples.length*2);
  buf.write('RIFF',0); buf.writeUInt32LE(buf.length-8,4); buf.write('WAVEfmt ',8);
  buf.writeUInt32LE(16,16); buf.writeUInt16LE(1,20); buf.writeUInt16LE(1,22);
  buf.writeUInt32LE(SR,24); buf.writeUInt32LE(SR*2,28); buf.writeUInt16LE(2,32); buf.writeUInt16LE(16,34);
  buf.write('data',36); buf.writeUInt32LE(samples.length*2,40);
  for(let i=0;i<samples.length;i++) buf.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);
  return buf;
}
function stats(samples) {
  let p=0, sq=0; for(const s of samples){p=Math.max(p,Math.abs(s));sq+=s*s;}
  return { durationSeconds:samples.length/SR, samplePeakDbFS:Number((20*Math.log10(Math.max(p,1e-12))).toFixed(2)), rmsDbFS:Number((20*Math.log10(Math.max(Math.sqrt(sq/samples.length),1e-12))).toFixed(2)) };
}
const rendered=cues.map(render);
const gap=.70, leading=.50;
const length=Math.round((leading+cues.reduce((t,c)=>t+c.duration+gap,0))*SR);
const audition=new Float64Array(length);
let cursor=Math.round(leading*SR);
const entries=cues.map((cue,index)=>{
 const samples=rendered[index], wav=encodeWav(samples);
 fs.writeFileSync(path.join(out,`${cue.id}.wav`),wav);
 audition.set(samples,cursor);
 const entry={id:cue.id,file:`audio/${cue.id}.wav`,auditionStartSeconds:Number((cursor/SR).toFixed(3)),...stats(samples),bytes:wav.length,recipe:cue};
 cursor+=samples.length+Math.round(gap*SR);
 return entry;
});
fs.writeFileSync(path.join(out,'audition-sequence.wav'),encodeWav(audition));
const manifest={status:'original offline synthesized design previews; NOT integrated; NOT human-listening approved',sampleRate:SR,channels:1,bitsPerSample:16,seed:1847,externalSamples:false,measurement:'sample peaks and unweighted RMS only; not LUFS or true-peak mastering',audition:{file:'audio/audition-sequence.wav',...stats(audition)},entries};
fs.writeFileSync(path.join(root,'audio-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({cues:entries.length,auditionSeconds:manifest.audition.durationSeconds,totalCueBytes:entries.reduce((s,e)=>s+e.bytes,0),maxSamplePeakDbFS:Math.max(...entries.map(e=>e.samplePeakDbFS)),output:out},null,2));
