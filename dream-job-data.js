(() => {
  'use strict';
  const phaseMeta = {
    1: { name: 'Pipeline', verb: 'Get in the game', outcome: 'Phase 1 ends with: 30–50 target companies + a weekly application rhythm.' },
    2: { name: 'Interviews', verb: 'Convert', outcome: 'Phase 2 ends with: an interview system, practiced stories, and completed loops.' },
    3: { name: 'Offers', verb: 'Close', outcome: 'Phase 3 ends with: a compared, negotiated, signed offer.' },
    4: { name: 'Land', verb: 'Start strong', outcome: 'Phase 4 ends with: a 30/60/90 plan and a continuation ritual.' },
  };
  const base = [
    { week:1, phase:1, weekTitle:'Define your target', outcome:'A one-line positioning statement, a comp floor, and a target-company list started.', actions:[
      {id:'one-liner',text:'Write your one-liner: “{role} with [X yrs] in [domain], targeting {role} at [$ floor]+.”'},
      {id:'floor',text:'Set your walk-away compensation number and write it down.'},
      {id:'companies',text:'Review your {companyCount} listed target companies and add {companyAddCount} more this week. Aim for 30–50 by the end of Phase 1.'}], mindsetSupport:{canonical:'Target Acquisition',displayTitle:'Define the offer you’ll sign',oneLiner:'Describe the signed {role} offer in one vivid paragraph.'},metrics:[{key:'targetCompanies',label:'Target companies listed',unit:'#'}]},
    { week:2, phase:1, weekTitle:'Build your ammunition', outcome:'A tailored resume, refreshed LinkedIn profile, and five STAR stories.', actions:[
      {id:'resume',text:'Tailor your resume to {role}: update the headline, summary, and keywords; keep experience chronological.'},
      {id:'linkedin',text:'Rewrite your LinkedIn headline and About section to match your {role} one-liner.'},
      {id:'stories',text:'Write 5 STAR stories: 2 wins, 1 conflict, 1 failure or learning, and 1 leadership story.'}], mindsetSupport:{canonical:'Identity Engineering',displayTitle:'Become someone who ships applications',oneLiner:'Choose 3 beliefs held by someone who applies consistently.'},metrics:[{key:'resumeDone',label:'Resume done',unit:'y/n',type:'boolean'},{key:'starStories',label:'STAR stories written',unit:'#'}]},
    { week:3, phase:1, weekTitle:'Launch the pipeline', outcome:'Applications flowing at a weekly cadence.', actions:[
      {id:'tracker',text:'Set up one tracker with company, role, date, stage, and contact columns.'},
      {id:'applications',text:'Send {applicationCount} quality {role} applications this week{companyContext}.'},
      {id:'referrals',text:'Request {referralCount} warm referral introductions from your network map.'}], mindsetSupport:{canonical:'Threat Modeling',displayTitle:'Rejection is data, not a verdict',oneLiner:'Write two futures: applying consistently versus waiting.'},metrics:[{key:'applications',label:'Applications sent',unit:'#'},{key:'referrals',label:'Referral requests sent',unit:'#'}]},
    { week:4, phase:2, weekTitle:'Pass the screen', outcome:'A recruiter-screen script you can deliver confidently.', actions:[
      {id:'script',text:'Write and rehearse your 2-minute {role} introduction plus a compensation-expectation answer anchored at or above your floor.'},
      {id:'followups',text:'Follow up on {followupCount} applications from prior weeks.'},
      {id:'screen',text:'Complete 1 live recruiter screen or 1 recorded self-run{processContext}.'}], mindsetSupport:{canonical:'Environmental Sabotage',displayTitle:'Build an interview-ready setup',oneLiner:'Prepare a quiet space, notes layout, water, and protected calendar blocks.'},metrics:[{key:'screens',label:'Screens completed',unit:'#'}]},
    { week:5, phase:2, weekTitle:'Go deep', outcome:'Research dossiers on your top five live companies.', actions:[
      {id:'dossiers',text:'Build {dossierCount} one-page company dossiers: product, metrics, recent news, and likely interviewers.'},
      {id:'teardowns',text:'Record yourself delivering {teardownCount} product teardowns out loud.'},
      {id:'questions',text:'Prepare 5 questions to ask a {role} hiring manager.'}], mindsetSupport:{canonical:'Mammalian Brain Reprogramming (FATE)',displayTitle:'Borrow credibility',oneLiner:'Study one great interview answer and borrow its structure.'},metrics:[{key:'dossiers',label:'Dossiers completed',unit:'#'},{key:'teardowns',label:'Teardowns practiced',unit:'#'}]},
    { week:6, phase:2, weekTitle:'Mock week', outcome:'Two to three mock interviews completed, with written fixes.', actions:[
      {id:'mocks',text:'Complete {mockCount} mock interviews with a peer, coach, or recorded self-mock.'},
      {id:'stories',text:'Rewrite your 2 weakest STAR stories using the feedback.'},
      {id:'drills',text:'Drill your 3 hardest questions 5 times each out loud.'}], mindsetSupport:{canonical:'FEAR Protocol',displayTitle:'Reps until interviews feel familiar',oneLiner:'Build familiarity through repetitions instead of forcing confidence.'},metrics:[{key:'mocks',label:'Mocks completed',unit:'#'}]},
    { week:7, phase:2, weekTitle:'Run the loop', outcome:'Onsites executed and every follow-up sent within 24 hours.', actions:[
      {id:'checklist',text:'Run a 4-item onsite checklist the night before: logistics, stories, questions, and interviewer notes.'},
      {id:'thanks',text:'Send a thank-you or follow-up note within 24 hours of every loop.'},
      {id:'retro',text:'Retro every loop with 1 thing to keep and 1 thing to fix.'}], mindsetSupport:{canonical:'Identity Integration',displayTitle:'Notice when you start feeling like the hire',oneLiner:'Log one moment when interviewing for {role} felt natural.'},metrics:[{key:'onsites',label:'Onsites completed',unit:'#'}]},
    { week:8, phase:3, weekTitle:'Evaluate', outcome:'A ranked offer comparison grounded in four-year value.', actions:[
      {id:'comparison',text:'Build a 4-year total-comp comparison: base, equity, and sign-on—not only year-one cash.'},
      {id:'questions',text:'Write 5 due-diligence questions for the manager and team.'},
      {id:'backchannel',text:'Backchannel {backchannelCount} people about the team, if possible.'}], mindsetSupport:{canonical:'Threat Modeling',displayTitle:'Two futures: sign vs. keep searching',oneLiner:'Compare both futures without fear or sunk-cost thinking.'},metrics:[{key:'offers',label:'Offers in hand',unit:'#'}]},
    { week:9, phase:3, weekTitle:'Negotiate', outcome:'A ranked ask list and a delivered counter.', actions:[
      {id:'levers',text:'Rank 5 levers: competing offers, sign-on, equity refresh, level or title, and start date.'},
      {id:'counter',text:'Write 1 complete counter using the Negotiation Module scripts and objection handling below.'},
      {id:'ask',text:'Make the ask once; do not accept on the call, and get the final offer in writing.'}], mindsetSupport:{canonical:'Identity Engineering',displayTitle:'Become someone who negotiates',oneLiner:'Treat negotiation as expected and collaborative.'},metrics:[{key:'negotiatedUplift',label:'Negotiated uplift',unit:'$'}],module:'negotiation'},
    { week:10, phase:3, weekTitle:'Decide & sign', outcome:'A signed offer and other loops closed gracefully.', actions:[
      {id:'score',text:'Score each final option on 4 dimensions—comp, team, manager, and growth—then decide within 48 hours.'},
      {id:'sign',text:'Sign 1 written offer.'},
      {id:'decline',text:'Decline every other active process with 1 warm relationship-preserving note.'}], mindsetSupport:{canonical:'Identity Integration',displayTitle:'Own the decision',oneLiner:'Write one paragraph on why this is the right next chapter.'},metrics:[{key:'signed',label:'Signed',unit:'y/n',type:'boolean'}]},
    { week:11, phase:4, weekTitle:'Pre-board', outcome:'A draft 30/60/90-day plan.', actions:[
      {id:'plan',text:'Draft 1 complete 30/60/90-day plan for your new {role} role.'},
      {id:'manager',text:'Send 1 message to your future manager asking what to read or learn before day one.'},
      {id:'people',text:'List 10 people to meet in your first month.'}], mindsetSupport:{canonical:'Target Acquisition',displayTitle:'Acquire the next identity: the new hire',oneLiner:'Picture your first month as the new {role}, including the learning curve.'},metrics:[{key:'onboardingPlan',label:'30/60/90 drafted',unit:'y/n',type:'boolean'}]},
    { week:12, phase:4, weekTitle:'Integrate', outcome:'First-week intentions and a written 90-day retro.', actions:[
      {id:'intentions',text:'Write 3 intentions for week one in the new role.'},
      {id:'ritual',text:'Schedule a 15-minute weekly continuation review.'},
      {id:'retro',text:'Write a 90-day retro naming 3 actions that moved the needle.'}], mindsetSupport:{canonical:'FEAR Protocol',displayTitle:'Continuation ritual',oneLiner:'Fold the useful practices into one ongoing weekly habit.'},metrics:[{key:'retroDone',label:'Retro completed',unit:'y/n',type:'boolean'}]},
  ];
  const replace = (text, vars) => text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
  function scaled(profile) {
    const low=profile.hoursBand==='under5', high=profile.hoursBand==='over10';
    return {
      applicationCount: low ? '3' : '5–8', referralCount: low ? '2' : '3', followupCount: low ? '2' : '3',
      dossierCount: low ? '3' : '5', teardownCount: low ? '1' : '2', mockCount: low ? '1–2' : '2–3', backchannelCount: low ? '1' : '1–2',
      stretch: high ? ' Stretch: add 2 more after completing the core count.' : '',
    };
  }
  function buildWeeks(profile) {
    const scale=scaled(profile), companies=profile.companies||[], companyNames=companies.slice(0,3).join(', ');
    const vars={
      ...scale, role:profile.targetRole||'your target role', companyCount:String(companies.length),
      companyAddCount:String(Math.max(0,10-companies.length)), companyContext:companyNames?`—start with ${companyNames}`:'',
      processContext:profile.liveProcesses?` using this live-process context: ${profile.liveProcesses}`:'',
    };
    return base.map(week=>({
      ...week,
      weekTitle: week.week===1 ? `Define your ${vars.role} target` : week.week===4 ? `Pass the ${vars.role} screen` : week.week===11 ? `Pre-board for ${vars.role}` : week.weekTitle,
      actions:week.actions.map((action,index)=>({id:`w${week.week}-${action.id}`,text:replace(action.text,vars)+(profile.hoursBand==='over10'&&index===1&&[3,4,5,6].includes(week.week)?scale.stretch:'')})),
      mindsetSupport:{...week.mindsetSupport,oneLiner:replace(week.mindsetSupport.oneLiner,vars)},
      paidGate:false,
    }));
  }
  window.DreamJobTrack={id:'dream-job',headline:'90 days from first application to signed offer.',subline:'Luck = pipeline × preparation. Every application is a lottery ticket you control.',startWeekByEntry:{'not-started':1,applying:2,interviewing:4,offers:8},phaseMeta,base,buildWeeks};
})();
