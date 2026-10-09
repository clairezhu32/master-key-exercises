(() => {
  'use strict';
  const STORAGE_KEY='lucky_dream_job_track_v1'; // Isolated: never touches generic Lucky plan or custom-task keys.
  let state=null;
  let pendingActionId=null;
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const sum=(values,key)=>Object.values(values||{}).reduce((total,week)=>total+(Number(week?.[key])||0),0);
  const companiesFrom=value=>[...new Set(String(value||'').split(/[\n,;]/).map(item=>item.trim()).filter(Boolean))].slice(0,10);

  function save(){ state.updatedAt=Date.now(); localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); }
  function load(){ try { const parsed=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'); return parsed?.trackId==='dream-job'?parsed:null; } catch { return null; } }
  function toast(message){ const el=$('toast');el.textContent=message;el.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('visible'),3200); }
  function openDialog(id){ const dialog=$(id);if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open',''); }
  function closeDialog(id){ const dialog=$(id);if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open'); }
  function currentWeek(){ return state.weeks.find(item=>item.week===state.currentWeek); }
  function metricValues(week){ return state.metrics[String(week)]||{}; }
  function completedActions(week){ return state.completed[String(week)]||{}; }
  function evidenceFor(week){ return state.evidence[String(week)]||{}; }
  function weekState(week){ if(state.reviews[String(week)])return'done';if(week<state.startWeek)return'fast-forwarded';if(week===state.currentWeek)return'current';return'preview'; }
  function parseMetricInput(input){ return input.type==='checkbox'?input.checked:Number(input.value||0); }

  function buildState(profile){
    const startWeek=window.DreamJobTrack.startWeekByEntry[profile.startingPoint]||1;
    return {version:1,trackId:'dream-job',profile,startWeek,currentWeek:startWeek,weeks:window.DreamJobTrack.buildWeeks(profile),completed:{},evidence:{},metrics:{},reviews:{},adjustments:[],customTasks:{},createdAt:Date.now(),updatedAt:Date.now()};
  }
  function metricStrip(){
    $('strip-applications').textContent=sum(state.metrics,'applications');
    $('strip-referrals').textContent=sum(state.metrics,'referrals');
    $('strip-mocks').textContent=sum(state.metrics,'mocks');
    $('strip-offers').textContent=sum(state.metrics,'offers');
  }
  function fastForwardChecklist(week){ return `<details class="dj-fast-forward"><summary>Condensed checklist</summary><ul>${week.actions.map(action=>`<li>${esc(action.text)}</li>`).join('')}</ul></details>`; }
  function roadmap(){
    const root=$('roadmap');root.innerHTML='';
    for(const phaseNumber of [1,2,3,4]){
      const phase=window.DreamJobTrack.phaseMeta[phaseNumber],section=document.createElement('section');section.className='dj-phase';
      const rows=state.weeks.filter(week=>week.phase===phaseNumber).map(week=>{
        const status=weekState(week.week),label=status==='done'?'✓ Done':status==='current'?'You are here':status==='fast-forwarded'?'Fast-forwarded':'Preview';
        return `<div class="dj-week-row ${status}" id="roadmap-week-${week.week}"><button class="dj-week-map-card ${status}" type="button" data-map-week="${week.week}" ${status==='current'?'':'disabled'}><span class="dj-week-map-top"><b>W${week.week} · ${esc(week.weekTitle)}</b><span class="dj-state">${label}</span></span><p>${esc(week.outcome)}</p></button>${status==='fast-forwarded'?fastForwardChecklist(week):''}</div>`;
      }).join('');
      section.innerHTML=`<header class="dj-phase-head"><div><strong>Phase ${phaseNumber} · ${phase.name}</strong><span>${phase.verb}</span></div><p>${phase.outcome}</p></header>${rows}`;
      root.append(section);
    }
    root.querySelector('[data-map-week]:not([disabled])')?.addEventListener('click',()=>$('week-detail').scrollIntoView({behavior:'smooth',block:'start'}));
  }
  function actionCard(action,week){
    const complete=Boolean(completedActions(week.week)[action.id]),evidence=evidenceFor(week.week)[action.id];
    return `<button class="dj-action-card" type="button" role="checkbox" aria-checked="${complete}" data-action-id="${action.id}"><span class="dj-check">${complete?'✓':''}</span><span class="dj-action-copy">${esc(action.text)}${evidence?`<small class="dj-evidence">Evidence: ${esc(evidence)}</small>`:''}</span></button>`;
  }
  function metricsMarkup(week){
    const values=metricValues(week.week);
    return week.metrics.map(metric=>metric.type==='boolean'
      ?`<div class="dj-metric boolean"><label><input type="checkbox" data-metric-key="${metric.key}" ${values[metric.key]?'checked':''}> ${esc(metric.label)}</label></div>`
      :`<div class="dj-metric"><label for="metric-${metric.key}">${esc(metric.label)} (${metric.unit})</label><input id="metric-${metric.key}" type="number" min="0" step="${metric.unit==='$'?'100':'1'}" value="${Number(values[metric.key])||0}" data-metric-key="${metric.key}"></div>`).join('');
  }
  function negotiationModule(){
    return `<section class="dj-negotiation"><div class="dj-kicker">Advanced module · Open during test phase</div><h3>Negotiation scripts &amp; objection handling</h3><details><summary>Counter-offer script</summary><p>“I’m excited about the role and the team. Based on the scope, level, and market data, I’d be ready to sign at [target total compensation]. Could we explore [ranked lever 1] and [ranked lever 2] to close the gap?”</p></details><details><summary>If they say the base is fixed</summary><p>“I understand the base band may be fixed. Could we use sign-on, initial equity, an earlier compensation review, or level to bridge the difference?”</p></details><details><summary>If they ask for an immediate answer</summary><p>“I’m enthusiastic, and I want to review the complete written package carefully. I’ll respond by [specific time within 48 hours].”</p></details><details><summary>If they say this is the final offer</summary><p>“Thank you for being direct. Before I decide, can you confirm the complete package and whether there is flexibility in start date, title, or the timing of the first review?”</p></details></section>`;
  }
  function detail(){
    const root=$('week-detail');
    if(state.currentWeek>12){root.innerHTML='<div class="dj-complete-state"><div class="dj-kicker">90 days complete</div><h2>You finished the roadmap.</h2><p>Your evidence and funnel metrics remain saved on this device.</p><button class="dj-secondary" type="button" id="review-roadmap">Review the map</button></div>';return;}
    const week=currentWeek(),actionCount=Object.values(completedActions(week.week)).filter(Boolean).length;
    const lastReview=state.reviews[String(week.week)],suggestion=state.adjustSuggestion;
    root.innerHTML=`<div class="dj-week-meta"><span>Week ${week.week} · ${window.DreamJobTrack.phaseMeta[week.phase].name}</span><span>${actionCount}/3 actions</span></div><h2>${esc(week.weekTitle)}</h2><p class="dj-outcome"><strong>By week’s end:</strong> ${esc(week.outcome)}</p><div class="dj-action-list">${week.actions.map(action=>actionCard(action,week)).join('')}</div><section class="dj-mindset"><span>Mindset support</span><h3>${esc(week.mindsetSupport.displayTitle)}</h3><p>${esc(week.mindsetSupport.oneLiner)}</p><a href="/#how">Lucky Method: ${esc(week.mindsetSupport.canonical)} ↗</a></section>${week.module==='negotiation'?negotiationModule():''}<div class="dj-section-label">Funnel numbers</div><div class="dj-metrics">${metricsMarkup(week)}</div>${suggestion?`<div class="dj-adjust-suggestion">${esc(suggestion)} <button class="dj-text-button" type="button" data-open-adjust>Adjust the roadmap</button></div>`:''}<button class="dj-primary dj-week-cta" type="button" id="complete-week">Complete week review →</button>`;
    root.querySelectorAll('[data-action-id]').forEach(button=>button.addEventListener('click',()=>toggleAction(button.dataset.actionId)));
    root.querySelectorAll('[data-metric-key]').forEach(input=>input.addEventListener('change',()=>{state.metrics[String(week.week)]={...metricValues(week.week),[input.dataset.metricKey]:parseMetricInput(input)};save();metricStrip();}));
    root.querySelector('[data-open-adjust]')?.addEventListener('click',showAdjust);
    $('complete-week').addEventListener('click',showReview);
  }
  function context(){ const bar=$('context-bar'),bits=[`Target role: ${state.profile.targetRole}`];if(state.profile.companies.length)bits.push(`${state.profile.companies.length} target companies added · ${Math.max(0,30-state.profile.companies.length)} to go`);if(state.profile.liveProcesses)bits.push(`Live process: ${state.profile.liveProcesses}`);bar.textContent=bits.join(' · ');bar.classList.add('visible'); }
  function render(){
    $('diagnostic-view').hidden=true;$('track-view').hidden=false;
    $('track-headline').textContent=window.DreamJobTrack.headline;$('track-subline').textContent=window.DreamJobTrack.subline;
    context();metricStrip();roadmap();detail();
  }
  function toggleAction(actionId){
    const week=currentWeek(),done=completedActions(week.week)[actionId];
    if(done){state.completed[String(week.week)]={...completedActions(week.week),[actionId]:false};save();render();return;}
    const action=week.actions.find(item=>item.id===actionId);pendingActionId=actionId;$('evidence-action').textContent=action.text;$('evidence-input').value=evidenceFor(week.week)[actionId]||'';$('evidence-error').textContent='';openDialog('evidence-dialog');setTimeout(()=>$('evidence-input').focus(),0);
  }
  function saveEvidence(event){
    event.preventDefault();const evidence=$('evidence-input').value.trim();if(!evidence){$('evidence-error').textContent='Add one line showing what you did.';return;}
    const week=currentWeek(),key=String(week.week);state.completed[key]={...completedActions(week.week),[pendingActionId]:true};state.evidence[key]={...evidenceFor(week.week),[pendingActionId]:evidence};save();closeDialog('evidence-dialog');pendingActionId=null;render();toast('Evidence saved.');
  }
  function showReview(){
    const week=currentWeek(),done=completedActions(week.week),metrics=metricValues(week.week);
    $('review-summary').innerHTML=`<ul class="dj-review-list">${week.actions.map(action=>`<li><b>${done[action.id]?'✓':'○'}</b> ${esc(action.text)}</li>`).join('')}</ul><p><strong>Funnel numbers:</strong> ${week.metrics.map(metric=>`${esc(metric.label)}: ${metric.type==='boolean'?(metrics[metric.key]?'yes':'no'):(Number(metrics[metric.key])||0)}`).join(' · ')}</p>`;
    $('review-stuck').value='none';$('review-note').value='';$('review-error').textContent='';openDialog('review-dialog');
  }
  function completeReview(event){
    event.preventDefault();const week=currentWeek(),stuck=$('review-stuck').value,note=$('review-note').value.trim();
    state.reviews[String(week.week)]={completedAt:Date.now(),stuck,note,actionsDone:Object.values(completedActions(week.week)).filter(Boolean).length,metrics:{...metricValues(week.week)}};
    state.adjustSuggestion=stuck==='resume-no-response'?'Your response rate is stuck. Pull the resume and positioning work forward?':stuck==='application-volume'?'Application volume is the bottleneck. Re-center the roadmap on pipeline week?':stuck==='interview-prep'?'Interview preparation needs more repetitions. Move back to mock week?':stuck==='offer-stage'?'An offer changes the funnel. Jump to evaluation and negotiation?':'';
    state.currentWeek=Math.min(13,week.week+1);save();closeDialog('review-dialog');render();toast(week.week===12?'90-day retro saved. Roadmap complete.':`Week ${week.week} reviewed. Week ${state.currentWeek} is ready.`);
  }
  function autoTarget(){
    if(sum(state.metrics,'offers')>0)return 8;
    const reviews=Object.values(state.reviews).sort((a,b)=>b.completedAt-a.completedAt),last=reviews[0];
    if(last?.stuck==='resume-no-response')return 2;if(last?.stuck==='application-volume')return 3;if(last?.stuck==='interview-prep')return 6;if(last?.stuck==='offer-stage')return 8;
    return Math.min(state.currentWeek,12);
  }
  function showAdjust(){ $('adjust-target').value='auto';openDialog('adjust-dialog'); }
  function adjustPlan(event){
    event.preventDefault();const selected=$('adjust-target').value,target=selected==='auto'?autoTarget():Number(selected),from=state.currentWeek;
    state.currentWeek=Math.max(1,Math.min(12,target));state.adjustments.push({from,to:state.currentWeek,at:Date.now()});state.adjustSuggestion='';save();closeDialog('adjust-dialog');render();$('roadmap-week-'+state.currentWeek)?.scrollIntoView({behavior:'smooth',block:'center'});toast(`Roadmap adjusted: Week ${state.currentWeek} is now current. Existing tasks and evidence were preserved.`);
  }
  function regenerate(){
    if(!confirm('Restart the Dream-Job diagnostic? This only resets this Dream-Job track. Your existing Lucky plans and manually entered tasks will not be touched.'))return;
    const profile=state.profile;
    localStorage.removeItem(STORAGE_KEY);state=null;$('track-view').hidden=true;$('diagnostic-view').hidden=false;
    const form=$('diagnostic-form');form.querySelector('[name=targetRole]').value=profile.targetRole;form.querySelector('[name=companies]').value=profile.companies.join('\n');form.querySelector('[name=liveProcesses]').value=profile.liveProcesses||'';form.querySelector(`[name=startingPoint][value="${profile.startingPoint}"]`).checked=true;form.querySelector(`[name=hoursBand][value="${profile.hoursBand}"]`).checked=true;updateCompanyCount();window.scrollTo(0,0);
  }
  function updateCompanyCount(){ const count=companiesFrom($('diagnostic-form').querySelector('[name=companies]').value).length;$('company-count').textContent=`${count} added, ${Math.max(0,30-count)} to go`; }
  function submitDiagnostic(event){
    event.preventDefault();const data=new FormData(event.currentTarget),profile={startingPoint:data.get('startingPoint'),targetRole:String(data.get('targetRole')||'').trim(),companies:companiesFrom(data.get('companies')),hoursBand:data.get('hoursBand'),liveProcesses:String(data.get('liveProcesses')||'').trim()};
    if(!profile.startingPoint||!profile.targetRole||!profile.hoursBand){$('diagnostic-error').textContent='Complete the required questions to build your roadmap.';return;}
    state=buildState(profile);save();render();window.scrollTo(0,0);
  }

  $('diagnostic-form').addEventListener('submit',submitDiagnostic);$('diagnostic-form').querySelector('[name=companies]').addEventListener('input',updateCompanyCount);
  $('evidence-form').addEventListener('submit',saveEvidence);$('review-form').addEventListener('submit',completeReview);$('adjust-form').addEventListener('submit',adjustPlan);
  $('adjust-plan').addEventListener('click',showAdjust);$('regenerate-plan').addEventListener('click',regenerate);
  document.querySelectorAll('.dj-dialog-close').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();closeDialog(event.currentTarget.closest('dialog').id);}));
  state=load();if(state){state.customTasks=state.customTasks||{};render();}else updateCompanyCount();
})();
