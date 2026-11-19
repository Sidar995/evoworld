import { SimulationClient } from './simulation-client.js';
import { nextOrganismId, downsampleMeasurements, chartHistoryKey, recordModelType, canCompareRecords, SnapshotInterpolator } from './ui-helpers.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'world','worldOverlay','overlayStart','overlayTitle','overlayDescription','runButton','endButton','resetButton',
  'seed','initialHerbivores','initialCarnivores','rainfall','rainfallValue','rainfallStatus','runStatus','runDot','runSeed','worldTime',
  'runMessage','performance','showTrails','population','herbivoreCount','carnivoreCount','foodCount','birthCount',
  'deathSummary','lineageSummary','organismTitle','organismHint','organismDetails','clearSelection','resultPanel','resultTitle',
  'resultSummary','resultFlags','saveStatus','saveForm','experimentName','experimentNotes','saveButton','downloadButton',
  'databaseStatus','experimentList','refreshExperiments','loadMoreExperiments','archiveCount','comparison','comparisonDetails',
  'selectionAnnouncement','metadataStatus','measurementSummary','comparisonCharts',
  'ownerAccess','authStatus','ownerLoginForm','ownerPassword','ownerLoginButton','ownerLogoutButton','authRefreshButton','connectionMode',
].map(id => [id,$(id)]));

let sim = null;
let initialSettings = {seed:42,initialHerbivores:40,initialCarnivores:6,rainfall:'normal'};
let playback=1, selectedId=null, saved=false, saving=false, saveAttempted=false, pendingRecord=null, draftRecord=null;
let nextCursor=null, archiveRequestId=0, comparisonRequestId=0, comparisonAbort=null, comparisonMessage='';
let detailCache=new Map(),hasDownloaded=false,savedExperiments=[],comparedIds=[],compareRecords=[];
let currentRecordDeleted=false;
const deletingExperimentIds=new Set(),removedExperimentIds=new Set(),deleteButtons=new Map();
let auth={mode:'checking',authenticated:false,csrfToken:null,configured:false};
let authEpoch=0,authRequestId=0,authBusy=false,authPollTimer=null,authController=null;
let authMessage='',logoutUnconfirmed=false,logoutCsrfToken=null;
let archiveLoading=false;
let announcedSelection='',discardedGrowthChanges=0,lastSummaryKey='',chartsNeedResize=true,workerError='',transitioning=false;
let lastStatus=null,hiddenPauseRequested=false;
const chartCache=new Map(),trails=new Map();
const dt=.05;
const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
const chartColours=['#b8d8b6','#98c4d8'];
const rainfallRates={dry:2,normal:8,wet:16};
const motion=new SnapshotInterpolator(200);
let drawnPositions=new Map();
ui.showTrails.checked=!reduceMotion.matches;

const client=new SimulationClient({
  onState(state){
    sim=state;
    motion.accept(state,performance.now());
    if(state.recoveryOnly)selectedId=null;
    if(state.status==='ready') initialSettings={seed:state.seed,initialHerbivores:state.settings.initialHerbivores,initialCarnivores:state.settings.initialCarnivores,rainfall:state.settings.rainfall};
    updateUi();requestHiddenPause();
  },
  onBusy(){updateUi();},
  onError(error,{recoverable}){
    workerError=error.message;sim=client.state;
    message(recoverable?`${error.message} A partial result is available at the last recorded time.`:`${error.message} No confirmed run is available to save. Use Reset to retry.`,true);
    updateUi();
  },
});

const storageAllowed=()=>auth.mode==='local'||(auth.mode==='owner'&&auth.authenticated&&auth.configured);
function storageAccessMessage(){
  if(auth.mode==='preview')return 'Public preview: saved experiments are unavailable. The simulation and JSON downloads work without sign-in.';
  if(auth.mode==='checking')return 'Checking owner access. The simulation and JSON downloads remain available.';
  if(auth.mode==='unavailable')return 'Owner access could not be verified. Check access to retry; the public simulation and JSON downloads still work.';
  if(auth.mode==='owner'&&!auth.configured)return 'Owner access is not configured on this server. The public simulation and JSON downloads remain available.';
  return 'Sign in as the owner to save, view, compare, or delete experiments. The simulation and JSON download are public.';
}
function clearPrivatePresentation(){
  ++archiveRequestId;++comparisonRequestId;comparisonAbort?.abort();comparisonAbort=null;
  savedExperiments=[];comparedIds=[];compareRecords=[];nextCursor=null;detailCache.clear();
  archiveLoading=false;
  deletingExperimentIds.clear();removedExperimentIds.clear();deleteButtons.clear();saving=false;
  for(const key of historySeriesCache.keys())if(!key.startsWith('live:'))historySeriesCache.delete(key);
  ui.experimentList.replaceChildren();ui.archiveCount.textContent='0';ui.loadMoreExperiments.hidden=true;
  ui.comparison.hidden=true;ui.comparisonCharts.hidden=true;ui.comparisonDetails.replaceChildren();ui.comparisonDetails.setAttribute('aria-busy','false');
  for(const id of ['comparePopulation','compareSpeed','compareSensing']){
    const canvas=$(id);canvas.getContext('2d').clearRect(0,0,canvas.width||0,canvas.height||0);chartCache.delete(id);
  }
}
function adoptAuth(next,messageText=''){
  const changed=JSON.stringify(auth)!==JSON.stringify(next);
  auth=next;authMessage=messageText;
  if(changed){++authEpoch;clearPrivatePresentation();}
  if(authPollTimer!==null){clearTimeout(authPollTimer);authPollTimer=null;}
  if(auth.mode==='owner'&&auth.authenticated){
    authPollTimer=setTimeout(()=>{authPollTimer=null;refreshAuthSession();},60000);
    authPollTimer?.unref?.();
  }
  if(!storageAllowed()){
    ui.databaseStatus.classList.remove('warning');ui.databaseStatus.textContent=storageAccessMessage();
    if(sim?.status==='ended'&&saveAttempted&&!currentRecordDeleted){
      ui.saveStatus.textContent=saved?'The current result was saved. Owner sign-in is required to access its stored copy; JSON download remains available.':'Owner access is closed. A save may already have reached storage. Sign in to retry the same record, or download JSON.';
    }
  }
  updateUi();
}
function normalizedSession(body){
  if(!body||!['local','owner'].includes(body.mode)||typeof body.authenticated!=='boolean'||typeof body.configured!=='boolean'||!(body.csrfToken===null||typeof body.csrfToken==='string'))throw new Error('The server returned an invalid access state.');
  if(body.mode==='local'&&(!body.authenticated||!body.configured||body.csrfToken!==null))throw new Error('The server did not confirm local storage access.');
  if(body.mode==='owner'&&body.authenticated&&(!body.configured||!body.csrfToken))throw new Error('The server did not confirm a usable owner session.');
  if(body.mode==='owner'&&!body.authenticated&&body.csrfToken!==null)throw new Error('The server returned an invalid guest access state.');
  return {mode:body.mode,authenticated:body.authenticated,csrfToken:body.csrfToken,configured:body.configured};
}
function expireOwnerSession(){
  ++authRequestId;authController?.abort();authController=null;authBusy=false;logoutUnconfirmed=false;logoutCsrfToken=null;
  adoptAuth({mode:'owner',authenticated:false,csrfToken:null,configured:auth.configured},'Your owner session ended. Sign in again to access saved experiments.');
  if(sim?.status==='ended'&&!saved)ui.saveStatus.textContent='Your owner session ended. Sign in to retry saving, or download the current result as JSON.';
}
async function authFetch(path,options={}){
  const controller=new AbortController();authController=controller;
  const timeout=setTimeout(()=>controller.abort(),10000);timeout?.unref?.();
  try{return await fetch(path,{...options,credentials:'same-origin',signal:controller.signal});}
  finally{clearTimeout(timeout);if(authController===controller)authController=null;}
}
async function refreshAuthSession(){
  if(authBusy)return;
  const requestId=++authRequestId;authBusy=true;updateUi();
  try{
    const response=await authFetch('/api/auth/session');
    if(requestId!==authRequestId)return;
    if(response.status===404||response.status===503){adoptAuth({mode:'preview',authenticated:false,csrfToken:null,configured:false},'Public preview: owner storage is not available here.');return;}
    if(!response.ok)throw new Error('Owner access could not be verified.');
    const next=normalizedSession(await response.json());
    if(requestId!==authRequestId)return;
    if(logoutUnconfirmed&&next.mode==='owner'&&next.authenticated){
      logoutCsrfToken=next.csrfToken;
      adoptAuth({...next,authenticated:false,csrfToken:null},'Server sign-out is not confirmed. Retry Sign out.');return;
    }
    adoptAuth(next);
    if(storageAllowed())loadExperiments();
  }catch(error){
    if(requestId!==authRequestId)return;
    adoptAuth({mode:'unavailable',authenticated:false,csrfToken:null,configured:false},'Owner access could not be verified. Use Check access to retry.');
  }finally{if(requestId===authRequestId){authBusy=false;updateUi();}}
}
ui.ownerLoginForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const password=ui.ownerPassword.value;ui.ownerPassword.value='';
  if(authBusy||auth.mode!=='owner'||!auth.configured||auth.authenticated)return;
  if(!password){authMessage='Enter the owner password.';updateUi();return;}
  const requestId=++authRequestId;authBusy=true;updateUi();
  try{
    const response=await authFetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
    const body=await response.json().catch(()=>({}));if(requestId!==authRequestId)return;
    if(!response.ok){
      if(response.status===503)adoptAuth({mode:'owner',authenticated:false,csrfToken:null,configured:false},'Owner login is not configured on this server.');
      else{authMessage=response.status===429?'Too many sign-in attempts. Wait before trying again.':response.status===401?'The owner password was not accepted.':'Owner sign-in could not be confirmed. Try again.';}
      return;
    }
    const next=normalizedSession(body);if(next.mode!=='owner'||!next.authenticated)throw new Error('Owner sign-in was not confirmed.');
    logoutUnconfirmed=false;logoutCsrfToken=null;adoptAuth(next,'Signed in as owner. Saved experiments are private.');loadExperiments();
  }catch(error){if(requestId===authRequestId)authMessage='Owner sign-in could not be confirmed. Try again.';}
  finally{ui.ownerPassword.value='';if(requestId===authRequestId){authBusy=false;updateUi();}}
});
ui.ownerLogoutButton.addEventListener('click',async()=>{
  if(authBusy||auth.mode!=='owner'||(!auth.authenticated&&!logoutUnconfirmed))return;
  const token=auth.csrfToken||logoutCsrfToken;
  const requestId=++authRequestId;authBusy=true;logoutCsrfToken=token;logoutUnconfirmed=true;
  adoptAuth({mode:'owner',authenticated:false,csrfToken:null,configured:auth.configured},'Signing out. Private experiment data has been cleared from this page.');
  try{
    const response=await authFetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':token}});
    if(requestId!==authRequestId)return;
    if(!response.ok&&response.status!==401)throw new Error('Server sign-out was not confirmed.');
    logoutUnconfirmed=false;logoutCsrfToken=null;
    adoptAuth({mode:'owner',authenticated:false,csrfToken:null,configured:auth.configured},'Signed out. The simulation and JSON download remain available.');
  }catch(error){if(requestId===authRequestId)authMessage='Private data is cleared here, but server sign-out could not be confirmed. Retry Sign out.';}
  finally{if(requestId===authRequestId){authBusy=false;updateUi();}}
});
ui.authRefreshButton.addEventListener('click',refreshAuthSession);
window.addEventListener('focus',()=>{if(auth.mode==='owner'&&auth.authenticated&&!authBusy)refreshAuthSession();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&auth.mode==='owner'&&auth.authenticated&&!authBusy)refreshAuthSession();});
function disposeAuth(){
  ++authRequestId;authController?.abort();authController=null;
  authBusy=false;++authEpoch;clearPrivatePresentation();
  if(authPollTimer!==null){clearTimeout(authPollTimer);authPollTimer=null;}
}
window.addEventListener('pagehide',disposeAuth);
window.addEventListener('pageshow',event=>{
  if(!event.persisted)return;
  adoptAuth({mode:'checking',authenticated:false,csrfToken:null,configured:false},'Checking owner access after returning to this page.');
  refreshAuthSession();
});

async function storageFetch(path,options={}){
  if(!storageAllowed())throw new Error('Owner sign-in is required for saved experiments.');
  const epoch=authEpoch;
  const method=options.method||'GET';const headers={...(options.headers||{})};
  if(auth.mode==='owner'&&!['GET','HEAD'].includes(method))headers['X-CSRF-Token']=auth.csrfToken;
  const response=await fetch(path,{...options,headers,credentials:'same-origin'});
  if(epoch!==authEpoch)throw new Error('This experiment response belongs to a previous owner session.');
  if(response.status===401||response.status===403){expireOwnerSession();throw new Error('Your owner session ended. Sign in again.');}
  return response;
}

function formatNumber(value,digits=1){return value===null||value===undefined||!Number.isFinite(value)?'—':value.toFixed(digits);}
function formatTime(seconds){const whole=Math.max(0,Math.floor(seconds));return `${String(Math.floor(whole/60)).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}`;}
function message(text,error=false){ui.runMessage.textContent=text;ui.runMessage.classList.toggle('error-text',error);}
function setText(element,text){if(element.textContent!==text) element.textContent=text;}

function readStartingControls(){
  const read=(element,name,max)=>{const value=Number(element.value);if(!String(element.value).trim()||!Number.isInteger(value)||value<0||value>max)throw new Error(`${name} must be a whole number from 0 to ${max}.`);return value;};
  const settings={seed:read(ui.seed,'Seed',4294967295),initialHerbivores:read(ui.initialHerbivores,'Herbivores',300),initialCarnivores:read(ui.initialCarnivores,'Carnivores',300),rainfall:ui.rainfall.value};
  if(settings.initialHerbivores+settings.initialCarnivores>300)throw new Error('The combined starting animal count must not exceed 300.');
  if(!(settings.rainfall in rainfallRates))throw new Error('Choose Dry, Normal, or Wet rainfall.');
  return settings;
}

function clearRunPresentation(){
  motion.reset();drawnPositions.clear();
  selectedId=null;trails.clear();chartCache.clear();lastSummaryKey='';saved=false;saveAttempted=false;pendingRecord=null;draftRecord=null;hasDownloaded=false;discardedGrowthChanges=0;
  ui.experimentName.value='';ui.experimentNotes.value='';ui.saveStatus.textContent='Unsaved. Save or download before leaving.';ui.saveStatus.classList.remove('saved');
  historySeriesCache.clear();
  currentRecordDeleted=false;
}

async function initializeWorld(settings){
  try{
  workerError='';sim=null;clearRunPresentation();updateUi();
  const state=await client.initialize(settings);
  initialSettings={...settings};
  ui.seed.value=state.seed;ui.initialHerbivores.value=state.settings.initialHerbivores;ui.initialCarnivores.value=state.settings.initialCarnivores;ui.rainfall.value=state.rainfall;
  if(playback!==1)await client.command('speed',{value:playback});
  return state;
  }catch(error){
    workerError=error.message||'The simulation worker could not start.';
    sim=client.state;
    message(`${workerError} ${sim?.measurements.length?'Confirmed results remain available.':'No confirmed run is available to save. Use Reset to retry.'}`,true);
    updateUi();
    throw error;
  }
}

async function action(task){
  if(transitioning||saving){message('Wait for the current action to finish before sending another command.');return;}
  transitioning=true;updateUi();
  try{await task();}catch(error){message(error.message||'This action could not be completed.',true);}
  finally{transitioning=false;updateUi();requestHiddenPause();}
}

function toggleRun(){return action(async()=>{
  if(!sim)return;
  if(sim.status==='ready'){
    const settings=readStartingControls();
    if(JSON.stringify(settings)!==JSON.stringify(initialSettings))await initializeWorld(settings);
    await client.command('start');message('The food chain is running. Try changing rainfall and watch each population.');
  }else if(sim.status==='running'){await client.command('pause');message('Paused. Inspect an animal or resume when you are ready.');}
  else if(sim.status==='paused'){await client.command('resume');message('Resumed. Rainfall changes are marked in the histories.');}
});}
ui.runButton.addEventListener('click',toggleRun);ui.overlayStart.addEventListener('click',toggleRun);
for(const element of [ui.seed,ui.initialHerbivores,ui.initialCarnivores])element.addEventListener('change',()=>{try{readStartingControls();message('Starting conditions edited. Start will initialize the chosen world.');}catch(error){message(error.message,true);}});
ui.rainfall.addEventListener('change',()=>action(async()=>{
  const value=ui.rainfall.value;
  try{await client.command('rainfall',{value});message(sim.status==='ready'?'Starting rainfall updated.':'Rainfall accepted for the next tick boundary.');}
  catch(error){ui.rainfall.value=sim?.pendingEvents.at(-1)?.rainfall||sim?.rainfall||'normal';throw error;}
}));
document.querySelectorAll('[data-speed]').forEach(button=>button.addEventListener('click',()=>action(async()=>{
  const value=Number(button.dataset.speed);await client.command('speed',{value});playback=value;
  document.querySelectorAll('[data-speed]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
})));
ui.endButton.addEventListener('click',()=>action(async()=>{
  discardedGrowthChanges=sim?.pendingEvents.length||0;await client.command('end');
  message(discardedGrowthChanges?`Experiment ended. ${discardedGrowthChanges} pending rainfall change(s) were discarded without a biological tick.`:'Experiment ended. Save or download the result before resetting.');
}));
ui.resetButton.addEventListener('click',()=>action(async()=>{
  const wasRunning=sim?.status==='running';
  if(wasRunning)await client.command('pause');
  let confirmed=true;
  if(sim&&sim.status!=='ready'&&!saved)confirmed=window.confirm('Reset this experiment? Unsaved results will be discarded. Saved experiments stay.');
  if(!confirmed){if(wasRunning&&!document.hidden)await client.command('resume');return;}
  await initializeWorld({...initialSettings});message('Reset to the same starting conditions and seed.');
}));
function requestHiddenPause(){
  if(!document.hidden||sim?.status!=='running'||client.busy||transitioning||hiddenPauseRequested)return;
  hiddenPauseRequested=true;
  client.command('pause').then(()=>message('Paused because this tab was hidden. Press Resume to continue.')).catch(error=>message(error.message,true)).finally(()=>{hiddenPauseRequested=false;updateUi();});
}
document.addEventListener('visibilitychange',requestHiddenPause);
function captureTrails(positions) {
  if (!sim) return;
  if (!ui.showTrails.checked || reduceMotion.matches) { trails.clear(); return; }
  const liveIds = new Set(sim.organisms.map((organism) => organism.id));
  for (const id of trails.keys()) if (!liveIds.has(id)) trails.delete(id);
  for (const organism of sim.organisms) {
    const position=positions.get(organism.id)||organism;
    const points = trails.get(organism.id) || [];
    const last=points.at(-1);
    if(last&&last[0]===position.x&&last[1]===position.y)continue;
    points.push([position.x, position.y]);
    if (points.length > 11) points.shift();
    trails.set(organism.id, points);
  }
}

ui.showTrails.addEventListener('change', () => { trails.clear(); });

function worldDimensions() {
  return { width: 1000, height: 600 };
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function organismColour(radius, alpha = 1) {
  const amount = Math.max(0, Math.min(1, (radius - 20) / 140));
  return `hsla(${103 + amount * 88}, ${29 + amount * 11}%, ${65 + amount * 2}%, ${alpha})`;
}

function drawWorld(timestamp=performance.now()) {
  const { context: ctx, width, height } = fitCanvas(ui.world);
  const world = worldDimensions();
  const sx = width / world.width;
  const sy = height / world.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101f17';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.scale(sx, sy);
  ctx.strokeStyle = '#263c2d';
  ctx.lineWidth = 0.55 / sx;
  ctx.beginPath();
  for (let x = 50; x < world.width; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, world.height); }
  for (let y = 50; y < world.height; y += 50) { ctx.moveTo(0, y); ctx.lineTo(world.width, y); }
  ctx.stroke();

  if (!sim) { ctx.restore(); return; }
  drawnPositions=motion.positions(sim,timestamp,reduceMotion.matches);
  if(sim.status==='running')captureTrails(drawnPositions);

  ctx.fillStyle = '#d8af67';
  for (const food of sim.food) {
    ctx.beginPath();
    ctx.moveTo(food.x, food.y - 2.5);
    ctx.lineTo(food.x + 2.5, food.y);
    ctx.lineTo(food.x, food.y + 2.5);
    ctx.lineTo(food.x - 2.5, food.y);
    ctx.closePath();
    ctx.fill();
  }

  for (const organism of sim.organisms) {
    const position=drawnPositions.get(organism.id)||organism;
    const points = trails.get(organism.id);
    if (points?.length > 1) {
      ctx.strokeStyle = organismColour(organism.sensingRadius, 0.22);
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(...points[0]);
      for (let index = 1; index < points.length; index++) {
        const [x, y] = points[index];
        const [px, py] = points[index - 1];
        if (Math.abs(x - px) > world.width / 2 || Math.abs(y - py) > world.height / 2) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (organism.id === selectedId) {
      ctx.fillStyle = organismColour(organism.sensingRadius, 0.045);
      ctx.strokeStyle = organismColour(organism.sensingRadius, 0.45);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(position.x, position.y, organism.sensingRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#e8f0df';
      ctx.beginPath();
      ctx.arc(position.x, position.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = organismColour(organism.sensingRadius);
    ctx.beginPath();
    if (organism.category === 'carnivore') {
      ctx.moveTo(position.x, position.y - 6);
      ctx.lineTo(position.x + 5.5, position.y + 4.5);
      ctx.lineTo(position.x - 5.5, position.y + 4.5);
      ctx.closePath();
    } else ctx.arc(position.x, position.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e6eed8';
    ctx.beginPath();
    ctx.arc(position.x - 0.8, position.y - 1, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

ui.world.addEventListener('click', (event) => {
  const rect = ui.world.getBoundingClientRect();
  const world = worldDimensions();
  const point = {
    x: (event.clientX - rect.left) / rect.width * world.width,
    y: (event.clientY - rect.top) / rect.height * world.height,
  };
  let best = null;
  let bestDistance = 18;
  for (const organism of sim?.organisms || []) {
    const position=drawnPositions.get(organism.id)||organism;
    const distance = Math.hypot(position.x - point.x, position.y - point.y);
    if (distance < bestDistance) { bestDistance = distance; best = organism; }
  }
  selectedId = best?.id ?? null;
  updateInspection();
});
ui.clearSelection.addEventListener('click', () => { selectedId = null; updateInspection(); });
ui.world.addEventListener('keydown', (event) => {
  if (!['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  selectedId = nextOrganismId(sim?.organisms || [], selectedId, event.key);
  updateInspection();
});

function updateInspection() {
  const organism = sim?.organisms.find((item) => item.id === selectedId);
  const selectionKey = `${selectedId ?? 'none'}:${Boolean(organism)}`;
  if (announcedSelection !== selectionKey) {
    if (organism) ui.selectionAnnouncement.textContent = `Selected ${organism.category} ${organism.id}. Energy ${formatNumber(organism.energy)}. Age ${formatNumber(organism.ageTicks * dt)} seconds. Speed ${formatNumber(organism.speed)}. Sensing radius ${formatNumber(organism.sensingRadius)}. Lineage depth ${organism.lineageDepth}. Offspring ${organism.offspringCount} of 6.`;
    else if (selectedId !== null) ui.selectionAnnouncement.textContent = `Organism ${selectedId} is no longer alive. Use an arrow key to select another living organism.`;
    else if (announcedSelection) ui.selectionAnnouncement.textContent = sim?.organisms.length ? 'Animal selection cleared.' : 'No live geometry is available to inspect.';
    announcedSelection = selectionKey;
  }
  ui.organismDetails.replaceChildren();
  ui.clearSelection.hidden = selectedId === null;
  if (!organism) {
    ui.organismTitle.textContent = selectedId === null ? 'Look a little closer' : `Organism ${selectedId} is no longer alive`;
    ui.organismHint.textContent = selectedId === null ? 'Click an organism, or focus the world and use Enter or arrow keys.' : 'Select another organism to follow a new lineage.';
    return;
  }
  ui.organismTitle.textContent = `${organism.category === 'carnivore' ? 'Carnivore' : 'Herbivore'} ${organism.id}`;
  ui.organismHint.textContent = 'Its sensing range is outlined in the world.';
  const details = [
    ['Category', organism.category],
    ['Energy', `${formatNumber(organism.energy)} / 120`],
    ['Age', `${formatNumber(organism.ageTicks * dt)} sec`],
    ['Speed', formatNumber(organism.speed)],
    ['Sensing', formatNumber(organism.sensingRadius)],
    ['Lineage depth', String(organism.lineageDepth)],
    ['Offspring', `${organism.offspringCount} / 6`],
  ];
  for (const [label, value] of details) {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    group.append(term, description);
    ui.organismDetails.append(group);
  }
}

function tickLabel(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return formatTime(seconds);
}

function drawChart(canvas, series, field, spreadField = null) {
  if (!canvas || canvas.hidden || !canvas.getBoundingClientRect().width) return;
  const rect = canvas.getBoundingClientRect();
  const cacheKey = `${chartHistoryKey(series)}:${rect.width}:${rect.height}:${window.devicePixelRatio || 1}:${field}`;
  if (!chartsNeedResize && chartCache.get(canvas.id) === cacheKey) return;
  // The engine/export retain every sample. Only the graph uses bounded points.
  const pointBudget = Math.max(60, Math.min(1200, Math.ceil(rect.width * 2)));
  const displaySeries = series.map((item) => ({ ...item, measurements: downsampleMeasurements(item.measurements || [], field, spreadField, pointBudget) }));
  const { context: ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const area = { x: 34, y: 12, w: Math.max(1, width - 45), h: height - 40 };
  const samples = displaySeries.flatMap((item) => item.measurements || []);
  const maxTime = samples.reduce((maximum, item) => Math.max(maximum, item.time), 10);
  const values = samples.filter((item) => Number.isFinite(item[field])).flatMap((item) => {
    const sd = spreadField && Number.isFinite(item[spreadField]) ? item[spreadField] : 0;
    return [item[field] + sd, Math.max(0, item[field] - sd)];
  });
  const maxValue = values.reduce((maximum, value) => Math.max(maximum, value), 1) * 1.15;
  const px = (time) => area.x + time / maxTime * area.w;
  const py = (value) => area.y + area.h - value / maxValue * area.h;
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  for (let index = 0; index <= 3; index++) {
    const value = maxValue * index / 3;
    const y = py(value);
    ctx.strokeStyle = '#2b4031';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(area.x, y); ctx.lineTo(area.x + area.w, y); ctx.stroke();
    ctx.fillStyle = '#90a695';
    ctx.textAlign = 'right';
    ctx.fillText(value >= 10 ? String(Math.round(value)) : value.toFixed(1), area.x - 7, y);
  }
  ctx.textAlign = 'center';
  for (let index = 0; index <= 2; index++) {
    const time = maxTime * index / 2;
    ctx.fillText(tickLabel(time), px(time), area.y + area.h + 19);
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip();
  for (let seriesIndex = 0; seriesIndex < displaySeries.length; seriesIndex++) {
    const item = displaySeries[seriesIndex];
    const data = item.measurements || [];
    const colour = item.colour || chartColours[seriesIndex % chartColours.length];
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = series.length === 1 ? '#d8af6770' : `${colour}65`;
    ctx.lineWidth = 1;
    for (const event of item.interventions || []) {
      const time = (event.tick - 1) * (item.settings?.dt ?? dt);
      ctx.beginPath(); ctx.moveTo(px(time), area.y); ctx.lineTo(px(time), area.y + area.h); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (spreadField) {
      let segment = [];
      const fillBand = () => {
        if (!segment.length) return;
        ctx.beginPath();
        segment.forEach((sample, index) => {
          const x = px(sample.time), y = py(sample[field] + (sample[spreadField] || 0));
          if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        [...segment].reverse().forEach((sample) => ctx.lineTo(px(sample.time), py(Math.max(0, sample[field] - (sample[spreadField] || 0)))));
        ctx.closePath(); ctx.fillStyle = `${colour}16`; ctx.fill();
        segment = [];
      };
      for (const sample of data) {
        if (Number.isFinite(sample[field])) segment.push(sample); else fillBand();
      }
      fillBand();
    }
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.setLineDash(item.lineDash || []);
    ctx.lineWidth = 1.8;
    let lineStarted = false;
    for (const sample of data) {
      if (!Number.isFinite(sample[field])) { lineStarted = false; continue; }
      if (!lineStarted) ctx.moveTo(px(sample.time), py(sample[field]));
      else ctx.lineTo(px(sample.time), py(sample[field]));
      lineStarted = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    let last = null;
    for (let index = data.length - 1; index >= 0; index--) {
      if (Number.isFinite(data[index][field])) { last = data[index]; break; }
    }
    if (last) {
      ctx.fillStyle = colour;
      ctx.beginPath(); ctx.arc(px(last.time), py(last[field]), 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
  if (!samples.length) {
    ctx.fillStyle = '#a7b7aa'; ctx.textAlign = 'center';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillText('History begins when the experiment starts.', area.x + area.w / 2, area.y + area.h / 2);
  }
  chartCache.set(canvas.id, cacheKey);
}

const historySeriesCache=new Map();
function modelSeries(record,includePlants=false,runIndex=0){
  const raw=record.measurements||[];
  const prefix=`${record.id||'live'}:${includePlants}`;
  const cacheKey=`${recordModelType(record)}:${raw.length}:${raw.at(-1)?.tick}:${record.interventions?.length}:${runIndex}`;
  if(historySeriesCache.get(prefix)?.key===cacheKey)return historySeriesCache.get(prefix).series;
  const categories=recordModelType(record)==='food-chain'?['herbivores','carnivores']:['baseline'];
  const colours={herbivores:'#b8d8b6',carnivores:'#98c4d8',baseline:chartColours[runIndex],plants:'#d8af67'};
  const series=categories.map(category=>({id:`${record.id||'live'}-${category}`,settings:record.settings,colour:colours[category],lineDash:runIndex?[5,3]:[],interventions:record.interventions||[],measurements:category==='baseline'?raw:raw.map(sample=>({tick:sample.tick,time:sample.time,...sample[category]}))}));
  if(includePlants&&recordModelType(record)==='food-chain')series.push({id:`${record.id||'live'}-plants`,settings:record.settings,colour:colours.plants,lineDash:runIndex?[5,3]:[],interventions:[],measurements:raw.map(sample=>({tick:sample.tick,time:sample.time,population:sample.food}))});
  historySeriesCache.set(prefix,{key:cacheKey,series});
  return series;
}
function updateCharts(){
  const live=sim||{modelType:'food-chain',measurements:[],interventions:[],settings:{dt}};
  drawChart($('populationChart'),modelSeries(live,true),'population');
  drawChart($('speedChart'),modelSeries(live),'meanSpeed','sdSpeed');
  drawChart($('sensingChart'),modelSeries(live),'meanSensing','sdSensing');
  if(compareRecords.length===2){
    drawChart($('comparePopulation'),compareRecords.flatMap((record,index)=>modelSeries(record,true,index)),'population');
    drawChart($('compareSpeed'),compareRecords.flatMap((record,index)=>modelSeries(record,false,index)),'meanSpeed','sdSpeed');
    drawChart($('compareSensing'),compareRecords.flatMap((record,index)=>modelSeries(record,false,index)),'meanSensing','sdSensing');
  }
  chartsNeedResize=false;
}
function appendSummaryTable(container,entries,caption){
  const table=document.createElement('table');table.className='measurement-table';
  const tableCaption=document.createElement('caption');tableCaption.textContent=caption;
  const head=document.createElement('thead'),headerRow=document.createElement('tr');
  for(const title of ['Recorded state','Category','Time','Animals','Plants','Speed mean ± SD','Sensing mean ± SD','Births','Energy deaths','Age deaths','Predation deaths']){const cell=document.createElement('th');cell.scope='col';cell.textContent=title;headerRow.append(cell);}
  head.append(headerRow);const body=document.createElement('tbody');
  for(const {label,sample} of entries){
    const categories=sample.herbivores?[['Herbivores',sample.herbivores],['Carnivores',sample.carnivores]]:[['Baseline',sample]];
    for(const [category,values] of categories){
      const row=document.createElement('tr'),heading=document.createElement('th');heading.scope='row';heading.textContent=label;row.append(heading);
      for(const value of [category,formatNumber(sample.time,2)+' sec',values.population,sample.food,`${formatNumber(values.meanSpeed)} ± ${formatNumber(values.sdSpeed)}`,`${formatNumber(values.meanSensing)} ± ${formatNumber(values.sdSensing)}`,values.births,values.deathsEnergy,values.deathsAge,values.deathsPredation??'Not recorded']){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
      body.append(row);
    }
  }
  table.append(tableCaption,head,body);container.append(table);
}
function updateMeasurementSummary(){
  const first=sim?.measurements[0],last=sim?.measurements.at(-1);
  const key=`${sim?.seed}:${sim?.measurements.length}:${last?.tick??'ready'}:${sim?.status==='ended'}`;
  if(key===lastSummaryKey)return;lastSummaryKey=key;ui.measurementSummary.replaceChildren();
  if(!first){ui.measurementSummary.append(paragraph('Start an experiment to record its initial and latest measurements.'));return;}
  appendSummaryTable(ui.measurementSummary,[{label:'Initial',sample:first},{label:sim.status==='ended'?'Final':'Latest recorded',sample:last}],'Exact recorded values by animal category. A dash means no living members. SD is population standard deviation.');
}
function updateUi(){
  const status=sim?.status||'unavailable';
  const busy=transitioning||client.busy||saving;
  const last=sim?.measurements.at(-1);
  const geometry=sim&&!sim.recoveryOnly;
  const herbivores=geometry?sim.organisms.filter(item=>item.category==='herbivore').length:last?.herbivores.population;
  const carnivores=geometry?sim.organisms.filter(item=>item.category==='carnivore').length:last?.carnivores.population;
  ui.population.textContent=geometry?sim.organisms.length:last?.population??'—';
  ui.herbivoreCount.textContent=herbivores??'—';ui.carnivoreCount.textContent=carnivores??'—';
  ui.foodCount.textContent=geometry?sim.food.length:last?.food??'—';ui.birthCount.textContent=sim?.births??'—';
  ui.worldTime.textContent=formatTime((sim?.tick||0)*dt);ui.runSeed.textContent=`Seed ${sim?.seed??initialSettings.seed}`;
  const statusNames={ready:'Ready to begin',running:'Food chain running',paused:'Experiment paused',limited:'Population limit reached',ended:'Experiment ended',error:'Simulation error',unavailable:workerError?'Worker unavailable':'Preparing worker'};
  ui.runStatus.textContent=sim?.partial?'Partial result after failure':sim?.outcome==='extinct'?'All animals extinct':statusNames[status];
  ui.runDot.className=`status-dot ${status}`;
  $('modelVersion').textContent=sim?`Food chain · ${sim.version}`:'Food-chain worker initialization';
  ui.worldOverlay.hidden=Boolean(sim&&status!=='ready'&&!sim.recoveryOnly);
  ui.overlayStart.hidden=!sim||status!=='ready';ui.overlayStart.disabled=busy||status!=='ready';
  ui.overlayTitle.textContent=!sim?(workerError?'The worker could not start.':'Preparing your ecosystem…'):sim.recoveryOnly?'A partial record was recovered.':'Your food chain is waiting.';
  ui.overlayDescription.textContent=!sim?(workerError?'No confirmed run can be saved. Reset to retry.':'The simulation runs separately to keep controls responsive.'):sim.recoveryOnly?'Values are preserved at the last recorded time. Historical animal positions are unavailable. Save or download the partial result.':`${sim.settings.initialHerbivores} herbivores. ${sim.settings.initialCarnivores} carnivores. Rainfall shapes what follows.`;
  ui.runButton.textContent=status==='running'?'Pause experiment':status==='paused'?'Resume experiment':status==='ready'?'Start experiment':'Experiment stopped';
  ui.runButton.disabled=busy||!['ready','running','paused'].includes(status);
  for(const input of [ui.seed,ui.initialHerbivores,ui.initialCarnivores])input.disabled=busy||status!=='ready';
  ui.rainfall.disabled=busy||!['ready','running','paused'].includes(status);
  document.querySelectorAll('[data-speed]').forEach(button=>button.disabled=busy||!sim||['ended','error','limited'].includes(status));
  ui.endButton.disabled=busy||!sim||['ready','ended'].includes(status);ui.resetButton.disabled=busy;
  const pending=sim?.pendingEvents||[];
  const pendingMayApply=['running','paused'].includes(status);
  const rain=(pendingMayApply?pending.at(-1)?.rainfall:null)||sim?.rainfall||ui.rainfall.value;
  ui.rainfallValue.textContent=`${rain[0].toUpperCase()+rain.slice(1)} · ${rainfallRates[rain]} / sec`;
  if(sim&&status==='ended')ui.rainfall.value=sim.rainfall;
  const discarded=status==='ended'?Math.max(discardedGrowthChanges,pending.length):0;
  setText(ui.rainfallStatus,!sim?'Waiting for confirmed worker state.':status==='ended'?`Final applied rainfall: ${sim.rainfall}.${discarded?` ${discarded} pending change(s) discarded and excluded from the record.`:''}`:pending.length&&pendingMayApply?`Applied: ${sim.rainfall}. Pending: ${pending.map(item=>item.rainfall).join(', ')} before tick ${pending[0].tick}. Ending discards pending changes.`:`${status==='ready'?'Starting':'Applied'} rainfall: ${sim.rainfall} (${rainfallRates[sim.rainfall]} plants/sec). ${pending.length?'Unapplied changes cannot run in this state; ending excludes them.':'No pending changes.'}`);
  ui.performance.textContent=sim?.performanceSlow?'This device advances simulated time more slowly. Biological steps are preserved.':`${playback}× playback · simulation runs in a separate worker.`;
  ui.performance.classList.toggle('error-text',Boolean(sim?.performanceSlow));
  ui.deathSummary.textContent=sim?`Deaths: ${sim.deaths.energy} energy, ${sim.deaths.age} age, ${sim.deaths.predation} predation.`:'Death causes will appear after Start.';
  const depth=sim?.organisms.reduce((maximum,item)=>Math.max(maximum,item.lineageDepth),0);
  ui.lineageSummary.textContent=sim?.recoveryOnly?'Partial record; live geometry is unavailable.':geometry?`${herbivores===0?'Herbivores absent. ':''}${carnivores===0?'Carnivores absent. ':''}Deepest living lineage: ${sim.organisms.length?depth:'none'}. Generations overlap.`:'Generations overlap; lineage starts at 0.';
  if(lastStatus!==status){
    if(status==='ended'&&!ui.experimentName.value.trim())ui.experimentName.value=`Food chain · seed ${sim.seed}`;
    if(status==='limited')message('The shared animal cap was reached. Inspect, end and save, or reset.');
    else if(status==='error')message(`${sim.error} End to preserve the partial result, or reset.`,true);
    else if(status==='ended'&&sim.outcome==='extinct')message('All animals are extinct. This is a valid result; no animals are replaced.');
    else if(status==='ended'&&sim.outcome==='time_limit')message('The 30-minute simulated-time limit was reached. Results are preserved.');
    lastStatus=status;
  }
  ui.resultPanel.hidden=status!=='ended'||!last;
  if(status==='ended'&&last){
    ui.resultTitle.textContent=sim.partial?'Partial experiment result':{manual:'Experiment ended',extinct:'All animals became extinct',limited:'Animal safety limit reached',time_limit:'Time limit reached',error:'Experiment ended after error'}[sim.outcome]||'Experiment ended';
    ui.resultSummary.textContent=`${formatNumber(last.time,2)} simulated seconds · ${last.herbivores.population} herbivores · ${last.carnivores.population} carnivores · ${last.food} plants.`;
    ui.resultFlags.textContent=`Outcome: ${sim.outcome}. Flags: ${(sim.flags||[]).join(', ')||'none'}.${sim.partial?` Partial: ${sim.error||workerError}`:''}`;
  }
  const deletingCurrent=Boolean(pendingRecord&&deletingExperimentIds.has(pendingRecord.id));
  const allowed=storageAllowed();
  ui.saveButton.disabled=!allowed||saving||saved||currentRecordDeleted||deletingCurrent||status!=='ended';ui.downloadButton.disabled=saving||status!=='ended';
  ui.saveButton.textContent=!allowed?(auth.mode==='owner'?'Owner sign-in required':'Storage unavailable'):saving?'Saving…':currentRecordDeleted?'Deleted from archive':saved?'Saved to PostgreSQL':saveAttempted?'Retry save':'Save experiment';
  ui.experimentName.disabled=saving||saveAttempted;ui.experimentNotes.disabled=saving||saveAttempted;
  ui.metadataStatus.textContent=saveAttempted?'Name, notes, and record ID are fixed from the first POST. Retries and downloads reuse exactly that record.':hasDownloaded?'Metadata remains editable. Changing it creates a new snapshot before your first save.':'You can edit metadata until the first save attempt. JSON download does not lock it.';
  updateInspection();updateMeasurementSummary();updateCharts();drawWorld();
  updateDeletionButtons();
  ui.ownerAccess.hidden=auth.mode==='local';
  ui.ownerLoginForm.hidden=auth.mode!=='owner'||auth.authenticated||logoutUnconfirmed;
  ui.ownerPassword.disabled=authBusy||!auth.configured;
  ui.ownerLoginButton.disabled=authBusy||!auth.configured;
  ui.ownerLogoutButton.hidden=auth.mode!=='owner'||(!auth.authenticated&&!logoutUnconfirmed);
  ui.ownerLogoutButton.disabled=authBusy;
  ui.ownerLogoutButton.textContent=logoutUnconfirmed&&!auth.authenticated?'Retry sign out':'Sign out';
  ui.authRefreshButton.disabled=authBusy;
  ui.refreshExperiments.disabled=!allowed||archiveLoading||authBusy;
  ui.loadMoreExperiments.disabled=!allowed||archiveLoading||authBusy;
  setText(ui.authStatus,authMessage||(auth.mode==='owner'&&auth.authenticated?'Signed in as owner. Saved experiments are private.':storageAccessMessage()));
  ui.connectionMode.textContent=auth.mode==='local'?'Local laboratory':'Public simulation';
}
function experimentRecord({ freeze = false } = {}) {
  if (saveAttempted && pendingRecord) return pendingRecord;
  const name = ui.experimentName.value.trim();
  const notes = ui.experimentNotes.value.trim();
  if (!name) throw new Error('Give this experiment a name before saving or downloading.');
  // Reuse an unchanged download snapshot. Editing metadata before the first
  // POST creates a new record ID, leaving previous downloaded files coherent.
  const record = draftRecord?.name === name && draftRecord?.notes === notes
    ? draftRecord
    : client.exportExperiment({ id: crypto.randomUUID(), name, notes });
  draftRecord = record;
  if (freeze) pendingRecord = record;
  return record;
}

async function api(path, options) {
  const epoch=authEpoch;
  const response = await storageFetch(path, options);
  const body = response.status===204?{}:await response.json().catch(() => ({}));
  if(epoch!==authEpoch)throw new Error('This experiment response belongs to a previous owner session.');
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

ui.saveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if(!storageAllowed()){ui.saveStatus.textContent=`${storageAccessMessage()} You can download the current result as JSON.`;return;}
  if (saving || saved || currentRecordDeleted || (pendingRecord&&deletingExperimentIds.has(pendingRecord.id))) return;
  let record;
  try { record = experimentRecord({ freeze: true }); }
  catch (error) { ui.saveStatus.textContent = error.message; return; }
  saving = true;
  saveAttempted = true;
  const requestEpoch=authEpoch;
  ui.saveStatus.textContent = 'Saving to local PostgreSQL…';
  updateUi();
  try {
    await api('/api/experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
    if(requestEpoch!==authEpoch)return;
    saved = true;
    ui.saveStatus.textContent = 'Saved to PostgreSQL. This experiment is available for comparison.';
    ui.saveStatus.classList.add('saved');
    await loadExperiments();
  } catch (error) {
    if(requestEpoch!==authEpoch)return;
    ui.saveStatus.textContent = `Not saved: ${error.message} Your result is still here. Retry the same save or download JSON. Keep this page open.`;
    ui.saveStatus.classList.remove('saved');
  } finally {
    if(requestEpoch===authEpoch){saving = false;updateUi();}
  }
});

ui.downloadButton.addEventListener('click', () => {
  try {
    const record = experimentRecord();
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `evoworld-seed-${record.seed}-${record.id.slice(0, 8)}.json`;
    link.click();
    hasDownloaded = true;
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if(currentRecordDeleted)ui.saveStatus.textContent='JSON downloaded. Its saved copy was permanently deleted; this page will not recreate it.';
    else if (!saved) ui.saveStatus.textContent = saveAttempted
      ? 'JSON downloaded with the exact frozen save record. This run is still unsaved in PostgreSQL; you can retry saving it.'
      : 'JSON snapshot downloaded. This run is still unsaved in PostgreSQL. Metadata remains editable until your first save attempt.';
    updateUi();
  } catch (error) { ui.saveStatus.textContent = error.message; }
});

async function loadExperiments({ append = false, notice = '' } = {}) {
  if(!storageAllowed()){ui.databaseStatus.textContent=storageAccessMessage();return;}
  if (append && !nextCursor) return;
  const requestId = ++archiveRequestId;
  const before = append ? nextCursor : null;
  archiveLoading=true;
  ui.refreshExperiments.disabled = true;
  ui.loadMoreExperiments.disabled = true;
  try {
    const body = await api(`/api/experiments?limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (requestId !== archiveRequestId) return;
    if (!Array.isArray(body.experiments)) throw new Error('Storage returned an invalid experiment list.');
    const experiments=body.experiments.filter(record=>!removedExperimentIds.has(record.id));
    if (append) {
      const seen = new Set(savedExperiments.map((item) => item.id));
      savedExperiments.push(...experiments.filter((item) => !seen.has(item.id)));
    } else savedExperiments = experiments;
    nextCursor = body.nextCursor || null;
    ui.archiveCount.textContent = `${savedExperiments.length}${nextCursor ? '+' : ''}`;
    ui.databaseStatus.classList.remove('warning');
    ui.databaseStatus.textContent = notice+(savedExperiments.length
      ? `${savedExperiments.length} experiment summaries loaded${nextCursor ? '; more are available' : ''}. Select two to retrieve and compare their full histories.`
      : 'No saved experiments yet. End a run and save it to begin your collection.');
    comparedIds = comparedIds.filter((id) => savedExperiments.some((record) => record.id === id));
    renderExperimentList();
    await requestComparison();
  } catch (error) {
    if (requestId !== archiveRequestId) return;
    ui.databaseStatus.classList.add('warning');
    ui.databaseStatus.textContent = `${notice}Experiment storage unavailable: ${error.message} The ecosystem still runs. Ended results can be downloaded as JSON.`;
  } finally {
    if (requestId === archiveRequestId) {
      archiveLoading=false;
      ui.refreshExperiments.disabled = !storageAllowed()||authBusy;
      ui.loadMoreExperiments.disabled = !storageAllowed()||authBusy;
      ui.loadMoreExperiments.hidden = !nextCursor;
    }
  }
}

ui.refreshExperiments.addEventListener('click', () => loadExperiments());
ui.loadMoreExperiments.addEventListener('click', () => loadExperiments({ append: true }));

function renderExperimentList() {
  ui.experimentList.replaceChildren();
  deleteButtons.clear();
  for (const experiment of savedExperiments) {
    const row=document.createElement('article');
    row.className='experiment-item';row.dataset.experimentId=experiment.id;
    const label = document.createElement('label');
    label.className = 'experiment-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = comparedIds.includes(experiment.id);
    checkbox.setAttribute('aria-label', `Compare ${experiment.name}`);
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = experiment.name;
    const detail = document.createElement('small');
    detail.textContent = `${recordModelType(experiment) === 'food-chain' ? 'Food chain' : 'Baseline'} · seed ${experiment.seed} · ${formatTime(experiment.duration)} · ${experiment.partial ? 'partial ' : ''}${experiment.outcome}`;
    const date = document.createElement('small');
    date.textContent = experiment.createdAt ? new Date(experiment.createdAt).toLocaleString() : `Model ${experiment.version}`;
    text.append(title, detail, date);
    label.append(checkbox, text);
    checkbox.addEventListener('change', () => {
      if(!storageAllowed()){checkbox.checked=false;return;}
      if (checkbox.checked) {
        if (comparedIds.length >= 2) {
          checkbox.checked = false;
          ui.databaseStatus.textContent = 'Two experiments are already selected. Deselect one before choosing another.';
          return;
        }
        const first = savedExperiments.find((record) => record.id === comparedIds[0]);
        if (first && !canCompareRecords(first, experiment)) {
          checkbox.checked = false;
          const explanation = 'Compare within the same model: choose two Baseline experiments or two Food chain experiments.';
          ui.databaseStatus.textContent = explanation;
          ui.comparison.hidden = false;
          ui.comparisonCharts.hidden = true;
          ui.comparisonDetails.replaceChildren(paragraph(explanation, 'comparison-warning'));
          return;
        }
        comparedIds.push(experiment.id);
      } else comparedIds = comparedIds.filter((id) => id !== experiment.id);
      requestComparison();
    });
    const deleteButton=document.createElement('button');
    deleteButton.type='button';deleteButton.className='experiment-delete';deleteButton.dataset.experimentId=experiment.id;
    deleteButton.setAttribute('aria-label',`Delete ${experiment.name}`);
    deleteButton.addEventListener('click',()=>deleteExperiment(experiment));
    deleteButtons.set(experiment.id,deleteButton);
    row.append(label,deleteButton);ui.experimentList.append(row);
  }
  updateDeletionButtons();
}

function updateDeletionButtons(){
  for(const [id,button] of deleteButtons){
    button.disabled=!storageAllowed()||deletingExperimentIds.has(id)||Boolean(saving&&pendingRecord?.id===id);
    button.textContent=deletingExperimentIds.has(id)?'Deleting…':'Delete';
  }
}

async function deleteExperiment(experiment){
  if(!storageAllowed()){ui.databaseStatus.textContent=storageAccessMessage();return;}
  const id=experiment.id;
  const requestEpoch=authEpoch;
  if(deletingExperimentIds.has(id)||removedExperimentIds.has(id))return;
  if(saving&&pendingRecord?.id===id){ui.databaseStatus.textContent='Wait for this experiment save to finish before deleting it.';return;}
  deletingExperimentIds.add(id);updateDeletionButtons();
  try{
    if(!window.confirm(`Permanently delete "${experiment.name}"? Its saved record will be removed. This cannot be undone. The current simulation and downloaded files are kept.`))return;
    updateUi();
    let response;
    try{
      response=await storageFetch(`/api/experiments/${encodeURIComponent(id)}`,{method:'DELETE'});
      if(requestEpoch!==authEpoch)return;
      if(!response.ok&&response.status!==404){
        const body=await response.json().catch(()=>({}));
        throw new Error(body.error||`Request failed (${response.status}).`);
      }
    }catch(error){
      if(requestEpoch!==authEpoch)return;
      ui.databaseStatus.classList.add('warning');
      ui.databaseStatus.textContent=`Could not confirm deletion of "${experiment.name}": ${error.message} The row and comparison stay visible here. Retry to check storage.`;
      return;
    }
    removedExperimentIds.add(id);
    ++archiveRequestId; // Older list responses cannot restore a deleted row/cursor.
    ++comparisonRequestId;comparisonAbort?.abort();comparisonAbort=null;
    savedExperiments=savedExperiments.filter(record=>record.id!==id);
    comparedIds=comparedIds.filter(value=>value!==id);
    compareRecords=[];detailCache.clear();
    for(const key of historySeriesCache.keys())if(key.startsWith(`${id}:`))historySeriesCache.delete(key);
    nextCursor=null;ui.loadMoreExperiments.hidden=true;ui.refreshExperiments.disabled=false;
    ui.comparison.hidden=true;ui.comparisonCharts.hidden=true;ui.comparisonDetails.replaceChildren();ui.comparisonDetails.setAttribute('aria-busy','false');
    ui.archiveCount.textContent=String(savedExperiments.length);
    if(pendingRecord?.id===id){
      currentRecordDeleted=true;saved=false;
      ui.saveStatus.classList.remove('saved');
      ui.saveStatus.textContent='Its saved copy was permanently deleted. The current result remains available for JSON download; it will not be saved again automatically.';
    }
    renderExperimentList();updateUi();
    const notice=response.status===404?`"${experiment.name}" is already absent from storage. `:`"${experiment.name}" was permanently deleted. `;
    // Start a fresh page after mutation; old keyset cursors no longer drive the UI.
    await loadExperiments({notice});
  }catch(error){
    if(requestEpoch!==authEpoch)return;
    ui.databaseStatus.classList.add('warning');ui.databaseStatus.textContent=`Delete failed: ${error.message}`;
  }finally{
    if(requestEpoch===authEpoch){deletingExperimentIds.delete(id);updateDeletionButtons();updateUi();}
  }
}

function paragraph(text, className = '') {
  const element = document.createElement('p');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function requestComparison() {
  if(!storageAllowed())return;
  const requestId = ++comparisonRequestId;
  comparisonAbort?.abort();
  comparisonAbort = null;
  const pair = [...comparedIds];
  const key = pair.join('|');
  if (pair.length !== 2) {
    compareRecords = [];
    detailCache.clear();
    ui.comparison.hidden = true;
    ui.comparisonCharts.hidden = true;
    ui.comparisonDetails.setAttribute('aria-busy', 'false');
    ui.comparisonDetails.replaceChildren();
    return;
  }
  if (compareRecords.length === 2 && compareRecords.map((record) => record.id).join('|') === key) {
    renderComparison();
    return;
  }
  compareRecords = [];
  ui.comparison.hidden = false;
  ui.comparisonCharts.hidden = true;
  comparisonMessage = 'Loading the two selected experiment histories…';
  ui.comparisonDetails.replaceChildren(paragraph(comparisonMessage, 'comparison-settings'));
  ui.comparisonDetails.setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  comparisonAbort = controller;
  // Keep only the selected pair, rather than retaining a full-record archive.
  detailCache = new Map([...detailCache].filter(([id]) => pair.includes(id)));
  try {
    const records = await Promise.all(pair.map(async (id) => {
      if (detailCache.has(id)) return detailCache.get(id);
      const record = await api(`/api/experiments/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (record.id !== id || !Array.isArray(record.measurements)) throw new Error('Storage returned an invalid experiment history.');
      return record;
    }));
    if (requestId !== comparisonRequestId || comparedIds.join('|') !== key) return;
    if (!canCompareRecords(records[0], records[1])) throw new Error('These experiments use different model types and cannot be compared.');
    compareRecords = records;
    detailCache = new Map(records.map((record) => [record.id, record]));
    comparisonMessage = '';
    renderComparison();
  } catch (error) {
    if (requestId !== comparisonRequestId || error.name === 'AbortError') return;
    comparisonMessage = `Comparison could not load: ${error.message} Deselect and reselect an experiment to retry.`;
    ui.comparisonDetails.replaceChildren(paragraph(comparisonMessage, 'comparison-warning'));
  } finally {
    if (requestId === comparisonRequestId) {
      ui.comparisonDetails.setAttribute('aria-busy', 'false');
      comparisonAbort = null;
    }
  }
}

function renderComparison() {
  if(!storageAllowed())return;
  ui.comparison.hidden = comparedIds.length !== 2;
  ui.comparisonDetails.replaceChildren();
  if (compareRecords.length !== 2) return;
  ui.comparisonCharts.hidden = false;
  const [first, second] = compareRecords;
  if (first.version !== second.version) ui.comparisonDetails.append(paragraph('Different simulation versions: rule changes may explain outcome differences.', 'comparison-warning'));
  const summaries = document.createElement('div');
  summaries.className = 'comparison-summary';
  for (const record of compareRecords) {
    const article = document.createElement('article');
    const heading = document.createElement('h4'); heading.textContent = record.name;
    const samples = record.measurements || [];
    const final = samples.at(-1);
    article.append(heading,
      paragraph(`${recordModelType(record) === 'food-chain' ? 'Food chain' : 'Baseline'} · seed ${record.seed} · ${record.version} · ${formatTime(record.duration)} · ${record.partial ? 'partial ' : ''}${record.outcome}`),
      paragraph(recordModelType(record) === 'food-chain'
        ? `Final: ${final?.herbivores?.population ?? '—'} herbivores, ${final?.carnivores?.population ?? '—'} carnivores, ${final?.food ?? '—'} plants. Flags: ${(record.flags || []).join(', ') || 'none'}.`
        : `Final population: ${final?.population ?? '—'}. Speed: ${formatNumber(final?.meanSpeed)} ± ${formatNumber(final?.sdSpeed)}. Sensing: ${formatNumber(final?.meanSensing)} ± ${formatNumber(final?.sdSensing)}. Carnivore and rainfall data were not part of this baseline model.`));
    if (record.partial) article.append(paragraph(`Partial result: ${record.finalSummary?.error || 'The simulation stopped after an error.'}`, 'comparison-warning'));
    if (record.notes) article.append(paragraph(`Notes: ${record.notes}`));
    const history = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${record.interventions?.length || 0} ${recordModelType(record) === 'food-chain' ? 'rainfall' : 'food growth'} intervention${record.interventions?.length === 1 ? '' : 's'}`;
    history.append(summary);
    const list = document.createElement('ul');
    for (const intervention of record.interventions || []) {
      const item = document.createElement('li');
      item.textContent = `${formatNumber((intervention.tick - 1) * (record.settings?.dt ?? dt),2)} sec (before tick ${intervention.tick}): ${recordModelType(record) === 'food-chain' ? `${intervention.rainfall} rainfall` : `${intervention.value} food / second`}`;
      list.append(item);
    }
    history.append(list);
    article.append(history);
    const settings = document.createElement('details');
    const settingsHeading = document.createElement('summary'); settingsHeading.textContent = 'Initial settings';
    settings.append(settingsHeading);
    for (const [key, value] of Object.entries(record.settings || {})) settings.append(paragraph(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`));
    article.append(settings);
    summaries.append(article);
  }
  ui.comparisonDetails.append(summaries);
  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-scroll';
  const entries = compareRecords.flatMap((record) => {
    const initial = record.measurements[0];
    const final = record.measurements.at(-1);
    return initial && final ? [{ label: `${record.name}: initial`, sample: initial }, { label: `${record.name}: final`, sample: final }] : [];
  });
  appendSummaryTable(tableWrap, entries, 'Exact initial and final measurements for the selected runs. Chart histories may be downsampled for display only.');
  ui.comparisonDetails.append(tableWrap);
  const keys = new Set([...Object.keys(first.settings || {}), ...Object.keys(second.settings || {})]);
  const differences = [...keys].filter((key) => JSON.stringify(first.settings?.[key]) !== JSON.stringify(second.settings?.[key]));
  const differenceText = differences.length ? differences.map((key) => `${key}: ${JSON.stringify(first.settings?.[key])} vs ${JSON.stringify(second.settings?.[key])}`).join('; ') : 'Initial settings match.';
  const historyMatches = JSON.stringify(first.interventions) === JSON.stringify(second.interventions);
  ui.comparisonDetails.append(paragraph(`${differenceText} Seeds ${first.seed === second.seed ? 'match' : 'differ'}. Environmental histories ${historyMatches ? 'match' : 'differ'}. Lines end at each recorded duration. Solid lines: first run. Dashed lines: second run. ${recordModelType(first) === 'food-chain' ? 'Green: herbivores; blue: carnivores; amber: plants.' : 'Green: first baseline run; blue: second baseline run.'}`, 'comparison-settings'));
  updateCharts();
}

window.addEventListener('beforeunload', (event) => {
  if (sim && sim.status !== 'ready' && !saved) { event.preventDefault(); event.returnValue = ''; }
});

window.addEventListener('resize', () => {
  chartsNeedResize = true;
  drawWorld();
  updateCharts();
});

// Rendering observes published state; the main thread never steps biology.
function renderFrame(timestamp){drawWorld(timestamp);requestAnimationFrame(renderFrame);}
updateUi();
refreshAuthSession();
transitioning=true;
initializeWorld(initialSettings).catch(error=>message(error.message,true)).finally(()=>{transitioning=false;updateUi();requestHiddenPause();});
requestAnimationFrame(renderFrame);
