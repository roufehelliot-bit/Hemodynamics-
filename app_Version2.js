// Advanced hemodynamics playground (vanilla JS)
// Model: time-varying elastance LV + simple valve diodes + 3-element Windkessel arterial model
// Visuals: arterial pressure waveform and PV-loop (Chart.js)

// ------- helpers ----------
const el = id => document.getElementById(id);
const toFixed = (v,d=1)=>Number.parseFloat(v).toFixed(d);

// UI elements
const inputs = {
  hr: el('hr'),
  edv: el('edv'),
  esv: el('esv'),
  autoEsv: el('autoEsv'),
  contractility: el('contractility'),
  svr: el('svr'),
  compliance: el('compliance'),
  rap: el('rap'),
  emax: el('emax'),
  emin: el('emin'),
  v0: el('v0'),
  preset: el('preset'),
  runSim: el('runSim'),
  exportBtn: el('exportBtn'),
  importBtn: el('importBtn'),
  importFile: el('importFile'),
  savePreset: el('savePreset'),
  loadPreset: el('loadPreset')
};

const displays = {
  hrVal: el('hrVal'),
  edvVal: el('edvVal'),
  esvVal: el('esvVal'),
  svrVal: el('svrVal'),
  compVal: el('compVal'),
  rapVal: el('rapVal'),
  contractilityVal: el('contractilityVal'),
  emaxVal: el('emaxVal'),
  eminVal: el('eminVal'),
  v0Val: el('v0Val'),
  svOut: el('svOut'),
  coOut: el('coOut'),
  mapOut: el('mapOut'),
  bpOut: el('bpOut'),
  ppOut: el('ppOut'),
  efOut: el('efOut')
};

// Chart.js setup
const ctxP = el('pressureChart').getContext('2d');
const pressureChart = new Chart(ctxP, {
  type: 'line',
  data: { labels: [], datasets:[{label:'mmHg', data:[], borderColor:'#0b67ff', backgroundColor:'rgba(11,103,255,0.08)', pointRadius:0, tension:0.2}]},
  options: { animation:false, responsive:true, maintainAspectRatio:false, scales:{x:{display:false}, y:{beginAtZero:false}}, plugins:{legend:{display:false}, title:{display:true,text:''}}}
});

const ctxPV = el('pvChart').getContext('2d');
const pvChart = new Chart(ctxPV, {
  type:'line',
  data:{datasets:[
    { label:'PV loop', data:[], borderColor:'#ff6b6b', backgroundColor:'rgba(255,107,107,0.06)', showLine:true, fill:true, pointRadius:0},
    { label:'Pressure (Arterial)', data:[], borderColor:'#0b67ff', pointRadius:0, showLine:false }
  ]},
  options:{ animation:false, responsive:true, maintainAspectRatio:false, scales:{ x:{type:'linear', title:{display:true, text:'Volume (mL)'}}, y:{title:{display:true, text:'Pressure (mmHg)'}} }, plugins:{legend:{display:true}, title:{display:true,text:'Ventricular PV Loop'}}}
});

// ------- model parameters & helpers --------
function getParamsFromUI(){
  // return a parameter object
  return {
    hr: +inputs.hr.value,
    edv: +inputs.edv.value,
    esv: +inputs.esv.value,
    autoEsv: inputs.autoEsv.checked,
    contr: +inputs.contractility.value,
    svr: +inputs.svr.value,
    comp: +inputs.compliance.value,
    rap: +inputs.rap.value,
    Emax: +inputs.emax.value,
    Emin: +inputs.emin.value,
    V0: +inputs.v0.value
  };
}

// normalized elastance function (simple physiologic-shaped waveform)
function normalizedElastance(tFrac){
  // tFrac: fraction of cardiac period 0..1
  // approximate systolic portion ~0..0.35 with rising/falling shape
  const ts = 0.33; // systolic fraction
  if(tFrac < ts){
    const x = tFrac/ts;
    // smooth rise and fall: use beta-like shape
    return Math.pow(Math.sin(Math.PI * x), 1.5);
  } else {
    // diastole baseline small
    const x = (tFrac - ts) / (1 - ts);
    // small diastolic tone remaining
    return 0.05 * Math.exp(-3 * x);
  }
}

// valve flow (diode) with small resistance Rval (mL/s per mmHg -> convert to flow units)
function valveFlow(P_up, P_down, Rval){
  // flow mL/s when open: (P_up - P_down) / Rval, else 0
  const dP = P_up - P_down;
  if(dP <= 0) return 0;
  return dP / Rval;
}

// convert SVR dyn·s·cm^-5 to peripheral resistance R (mmHg·s/mL)
// standard: MAP - RAP = CO * SVR / 80  where CO L/min, so SVR/80 gives mmHg/(L/min) units.
// We'll convert to mmHg·s/mL: R_peripheral = SVR / 80 / 60  (mmHg per (mL/s))
function svr_to_Rperipheral(svr){
  // SVR dyn·s·cm^-5 -> mmHg·min/L conversion factor = 1/80
  // R (mmHg/(mL/s)) = (SVR/80) * (1 L / 1000 mL) * (1 min / 60 s) ^-1 => simpler: (SVR/80) / 60
  // We'll use R = (SVR / 80) / 60  -> mmHg / (mL/s)
  return (svr / 80.0) / 60.0;
}

// -------- numerical integrator per-beat ----------
function runSimulation(params, opts = {stepsPerBeat: 400, beats: 8}){
  // returns traces for last beat: arterial pressure, pv loop points, and summary metrics
  const dt = (60.0 / params.hr) / opts.stepsPerBeat; // seconds
  const R_per = svr_to_Rperipheral(params.svr); // mmHg / (mL/s)
  const C = params.comp; // mL / mmHg
  const Zc = 0.01; // characteristic impedance R (mmHg/(mL/s)) small
  const Rval_mitral = 0.005; // mmHg/(mL/s) (low resistance when open)
  const Rval_aortic = 0.0025; // mmHg/(mL/s)

  // state variables
  let V_lv = params.edv; // initial guess
  let P_art = 90; // initial arterial pressure guess
  const P_ven = params.rap; // for now fixed venous pressure (mmHg)

  const traceP = [];
  let pvPoints = [];

  const totalSteps = opts.beats * opts.stepsPerBeat;
  for(let step=0; step<totalSteps; step++){
    const t = step * dt;
    const T = 60.0 / params.hr;
    const tFrac = (t % T) / T;
    const En = normalizedElastance(tFrac);
    const E_t = params.Emin + (params.Emax - params.Emin) * En; // mmHg/mL
    // ventricular pressure
    const P_lv = E_t * Math.max(0, V_lv - params.V0);

    // valve flows (mL/s)
    const Qin = valveFlow(P_ven, P_lv, Rval_mitral); // mitral flow into LV
    const Qout = valveFlow(P_lv, P_art, Rval_aortic); // aortic outflow to arterial

    // arterial dynamics: dP_art/dt = (Qout - P_art/R_per) / C
    // note Qout and Qin in mL/s, R_per in mmHg/(mL/s), C in mL/mmHg
    const dPdt = (Qout - (P_art / R_per)) / C;
    P_art += dPdt * dt;

    // ventricular volume dynamics: dV/dt = Qin - Qout
    V_lv += (Qin - Qout) * dt;

    // store traces for last beat only (to visualize steady state)
    if(step >= (totalSteps - opts.stepsPerBeat)){
      traceP.push({tFrac, P_art, P_lv, V_lv});
      pvPoints.push({x: V_lv, y: P_lv});
    }
  }

  // compute summary metrics from last beat traces
  // find EDV (max V_lv), ESV (min V_lv), SV = EDV - ESV
  const Vvals = traceP.map(p=>p.V_lv||p.v).concat(pvPoints.map(p=>p.x));
  // but our trace stores V_lv as .V_lv in last-beat trace
  const Vlast = traceP.map(p=>p.V_lv);
  const P_art_vals = traceP.map(p=>p.P_art);
  const P_lv_vals = traceP.map(p=>p.P_lv);
  const EDV = Math.max(...Vlast);
  const ESV = Math.min(...Vlast);
  const SV = Math.max(0, EDV - ESV);
  const CO = params.hr * SV / 1000.0; // L/min
  const MAP = P_art_vals.reduce((a,b)=>a+b,0) / P_art_vals.length;
  const SBP = Math.max(...P_art_vals);
  const DBP = Math.min(...P_art_vals);
  const PP = SBP - DBP;
  const EF = EDV>0 ? (SV/EDV)*100.0 : 0.0;

  return {
    traceP,
    pvPoints,
    EDV, ESV, SV, CO, MAP, SBP, DBP, PP, EF
  };
}

// ------- UI wiring & utilities -------
function updateDisplayParams(){
  const p = getParamsFromUI();
  displays.hrVal.textContent = p.hr;
  displays.edvVal.textContent = p.edv;
  displays.esvVal.textContent = p.esv;
  displays.svrVal.textContent = p.svr;
  displays.compVal.textContent = p.comp;
  displays.rapVal.textContent = p.rap;
  displays.contractilityVal.textContent = p.contr.toFixed(2);
  displays.emaxVal.textContent = p.Emax.toFixed(2);
  displays.eminVal.textContent = p.Emin.toFixed(2);
  displays.v0Val.textContent = p.V0.toFixed(0);
}

// preset handler
const presets = {
  normal:{
    hr:75, edv:120, esv:50, contr:0.5, svr:1200, comp:1.5, rap:2, Emax:2.0, Emin:0.06, V0:10
  },
  hypertension:{
    hr:75, edv:120, esv:50, contr:0.5, svr:2000, comp:1.0, rap:5, Emax:2.2, Emin:0.06, V0:10
  },
  sepsis:{
    hr:120, edv:120, esv:50, contr:0.4, svr:400, comp:2.5, rap:1, Emax:1.6, Emin:0.04, V0:10
  },
  "hfr ef":{
    hr:80, edv:160, esv:120, contr:0.2, svr:1200, comp:1.2, rap:6, Emax:0.7, Emin:0.06, V0:10
  },
  hfpef:{
    hr:70, edv:100, esv:45, contr:0.6, svr:1200, comp:1.0, rap:6, Emax:2.5, Emin:0.18, V0:10
  },
  tachy:{ hr:140, edv:110, esv:50, contr:0.45, svr:1000, comp:1.3, rap:3, Emax:1.9, Emin:0.06, V0:10 },
  brady:{ hr:40, edv:140, esv:50, contr:0.6, svr:1400, comp:1.4, rap:3, Emax:2.2, Emin:0.06, V0:10 }
};

function applyPreset(name){
  if(!presets[name]) return;
  const p = presets[name];
  inputs.hr.value = p.hr;
  inputs.edv.value = p.edv;
  inputs.esv.value = p.esv;
  inputs.contractility.value = p.contr;
  inputs.svr.value = p.svr;
  inputs.compliance.value = p.comp;
  inputs.rap.value = p.rap;
  inputs.emax.value = p.Emax;
  inputs.emin.value = p.Emin;
  inputs.v0.value = p.V0;
  updateDisplayParams();
}

// render functions
function renderCharts(sim){
  // arterial pressure waveform
  const labels = sim.traceP.map((p,i)=> (i/sim.traceP.length).toFixed(2));
  const parray = sim.traceP.map(p=>Number(p.P_art.toFixed(2)));
  pressureChart.data.labels = labels;
  pressureChart.data.datasets[0].data = parray;
  pressureChart.options.plugins.title.text = `Arterial pressure waveform (SBP ${sim.SBP.toFixed(0)} / DBP ${sim.DBP.toFixed(0)} mmHg)`;
  pressureChart.update();

  // PV loop - dataset 0 is loop
  pvChart.data.datasets[0].data = sim.pvPoints.map(pt=>({x: pt.x, y: pt.y}));
  // optional: overlay points of arterial pressure as scatter (not necessary)
  pvChart.update();
}

function renderOutputs(sim){
  displays.svOut.textContent = Math.round(sim.SV) + ' mL';
  displays.coOut.textContent = sim.CO.toFixed(2) + ' L/min';
  displays.mapOut.textContent = sim.MAP.toFixed(1) + ' mmHg';
  displays.bpOut.textContent = Math.round(sim.SBP) + ' / ' + Math.round(sim.DBP);
  displays.ppOut.textContent = Math.round(sim.PP) + ' mmHg';
  displays.efOut.textContent = Math.round(sim.EF);
}

// export / import
function exportScenario(){
  const p = getParamsFromUI();
  const blob = new Blob([JSON.stringify(p, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hemo-scenario.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importScenarioFile(file){
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const obj = JSON.parse(e.target.result);
      // basic validation
      if(obj.hr) {
        inputs.hr.value = obj.hr;
        inputs.edv.value = obj.edv || inputs.edv.value;
        inputs.esv.value = obj.esv || inputs.esv.value;
        inputs.contractility.value = obj.contr || inputs.contractility.value;
        inputs.svr.value = obj.svr || inputs.svr.value;
        inputs.compliance.value = obj.comp || inputs.compliance.value;
        inputs.rap.value = obj.rap || inputs.rap.value;
        inputs.emax.value = obj.Emax || inputs.emax.value;
        inputs.emin.value = obj.Emin || inputs.emin.value;
        inputs.v0.value = obj.V0 || inputs.v0.value;
        updateDisplayParams();
      } else {
        alert('Invalid scenario JSON');
      }
    }catch(err){ alert('Failed to parse file: ' + err); }
  };
  reader.readAsText(file);
}

// save/load preset to localStorage
function saveScenarioToLocal(){
  const p = getParamsFromUI();
  localStorage.setItem('hemo_saved_scenario', JSON.stringify(p));
  alert('Scenario saved locally.');
}
function loadScenarioFromLocal(){
  const data = localStorage.getItem('hemo_saved_scenario');
  if(!data){ alert('No saved scenario found.'); return; }
  const obj = JSON.parse(data);
  inputs.hr.value = obj.hr;
  inputs.edv.value = obj.edv;
  inputs.esv.value = obj.esv;
  inputs.contractility.value = obj.contr;
  inputs.svr.value = obj.svr;
  inputs.compliance.value = obj.comp;
  inputs.rap.value = obj.rap;
  inputs.emax.value = obj.Emax;
  inputs.emin.value = obj.Emin;
  inputs.v0.value = obj.V0;
  updateDisplayParams();
}

// main simulate-and-render
function simulateAndRender(){
  updateDisplayParams();
  const params = getParamsFromUI();
  // optional: if autoEsv convert contr to Emax mapping
  if(inputs.autoEsv.checked){
    // map contractility (0.1..1.0) to Emax range (0.5..4.5)
    params.Emax = 0.5 + (params.contr - 0.1) / (1.0 - 0.1) * 4.0;
    inputs.emax.value = params.Emax;
  }

  const sim = runSimulation(params, {stepsPerBeat: 400, beats: 8});
  renderCharts(sim);
  renderOutputs(sim);
}

// wire events
['input','change'].forEach(evt=>{
  Object.values(inputs).forEach(inp=>{
    if(!inp) return;
    if(inp.tagName === 'BUTTON' || inp.tagName === 'SELECT' || inp.type === 'file') return;
    inp.addEventListener(evt, ()=>{ updateDisplayParams(); });
  });
});

inputs.preset.addEventListener('change', e=>{
  applyPreset(e.target.value);
  simulateAndRender();
});

inputs.runSim.addEventListener('click', e=> simulateAndRender());

inputs.exportBtn.addEventListener('click', exportScenario);
inputs.importBtn.addEventListener('click', ()=> inputs.importFile.click());
inputs.importFile.addEventListener('change', e=>{
  const f = e.target.files[0];
  if(f) importScenarioFile(f);
  e.target.value = '';
});

inputs.savePreset.addEventListener('click', saveScenarioToLocal);
inputs.loadPreset.addEventListener('click', loadScenarioFromLocal);

// initial
applyPreset('normal');
updateDisplayParams();
simulateAndRender();