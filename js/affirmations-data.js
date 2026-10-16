// Affirmation cards - 96 professional affirmations across 8 job-search blockers
const AFFIRMATIONS = [
  {
    "id": "not_qualified-1",
    "blocker": "not_qualified",
    "text": "My experience is broader than any single job description."
  },
  {
    "id": "not_qualified-2",
    "blocker": "not_qualified",
    "text": "I was invited to this conversation because I belong in it."
  },
  {
    "id": "not_qualified-3",
    "blocker": "not_qualified",
    "text": "Qualifications are a starting point; my judgment is the asset."
  },
  {
    "id": "not_qualified-4",
    "blocker": "not_qualified",
    "text": "I have solved hard problems before. I can solve these too."
  },
  {
    "id": "not_qualified-5",
    "blocker": "not_qualified",
    "text": "Every expert was once a beginner who refused to quit."
  },
  {
    "id": "not_qualified-6",
    "blocker": "not_qualified",
    "text": "I bring a perspective this team does not have yet."
  },
  {
    "id": "not_qualified-7",
    "blocker": "not_qualified",
    "text": "My track record speaks louder than a checklist of requirements."
  },
  {
    "id": "not_qualified-8",
    "blocker": "not_qualified",
    "text": "I learn fast, and I have the proof to back it up."
  },
  {
    "id": "not_qualified-9",
    "blocker": "not_qualified",
    "text": "Nobody meets one hundred percent of a job posting. Nobody."
  },
  {
    "id": "not_qualified-10",
    "blocker": "not_qualified",
    "text": "What I lack in years, I make up for in drive and adaptability."
  },
  {
    "id": "not_qualified-11",
    "blocker": "not_qualified",
    "text": "I am allowed to grow into a role. That is how careers work."
  },
  {
    "id": "not_qualified-12",
    "blocker": "not_qualified",
    "text": "My skills transfer. My work ethic compounds."
  },
  {
    "id": "fear_freeze-1",
    "blocker": "fear_freeze",
    "text": "I have prepared. My body knows what to do. I trust it."
  },
  {
    "id": "fear_freeze-2",
    "blocker": "fear_freeze",
    "text": "A pause is not a failure. It is me thinking clearly."
  },
  {
    "id": "fear_freeze-3",
    "blocker": "fear_freeze",
    "text": "I speak slowly, and that makes me sound confident."
  },
  {
    "id": "fear_freeze-4",
    "blocker": "fear_freeze",
    "text": "Nerves mean I care. I channel that energy into focus."
  },
  {
    "id": "fear_freeze-5",
    "blocker": "fear_freeze",
    "text": "I have answered harder questions than these."
  },
  {
    "id": "fear_freeze-6",
    "blocker": "fear_freeze",
    "text": "My breath is my anchor. Inhale, then speak."
  },
  {
    "id": "fear_freeze-7",
    "blocker": "fear_freeze",
    "text": "I don't need to be perfect. I need to be present."
  },
  {
    "id": "fear_freeze-8",
    "blocker": "fear_freeze",
    "text": "Freezing is a moment, not a verdict. I recover and continue."
  },
  {
    "id": "fear_freeze-9",
    "blocker": "fear_freeze",
    "text": "I rehearse so that pressure feels familiar."
  },
  {
    "id": "fear_freeze-10",
    "blocker": "fear_freeze",
    "text": "The interviewer wants me to succeed. We are on the same side."
  },
  {
    "id": "fear_freeze-11",
    "blocker": "fear_freeze",
    "text": "I answer one question at a time. That is all this is."
  },
  {
    "id": "fear_freeze-12",
    "blocker": "fear_freeze",
    "text": "Calm is a skill, and I practice it daily."
  },
  {
    "id": "imposter-1",
    "blocker": "imposter",
    "text": "I earned my seat. Doubt does not erase results."
  },
  {
    "id": "imposter-2",
    "blocker": "imposter",
    "text": "Feeling like an imposter is common among high achievers. I am in good company."
  },
  {
    "id": "imposter-3",
    "blocker": "imposter",
    "text": "My work has real impact, and I can point to it."
  },
  {
    "id": "imposter-4",
    "blocker": "imposter",
    "text": "I don't need to know everything to add value today."
  },
  {
    "id": "imposter-5",
    "blocker": "imposter",
    "text": "Competence is not the absence of doubt. It is action despite doubt."
  },
  {
    "id": "imposter-6",
    "blocker": "imposter",
    "text": "I was hired for my judgment, not for being flawless."
  },
  {
    "id": "imposter-7",
    "blocker": "imposter",
    "text": "Asking questions is a strength, not an exposure."
  },
  {
    "id": "imposter-8",
    "blocker": "imposter",
    "text": "I belong here as much as anyone who walked in confident."
  },
  {
    "id": "imposter-9",
    "blocker": "imposter",
    "text": "My imposter feeling is a sign I am stretching. Stretching is growth."
  },
  {
    "id": "imposter-10",
    "blocker": "imposter",
    "text": "I give myself the same credit I give others."
  },
  {
    "id": "imposter-11",
    "blocker": "imposter",
    "text": "Success did not happen to me by accident. I built it."
  },
  {
    "id": "imposter-12",
    "blocker": "imposter",
    "text": "I am allowed to be both learning and leading."
  },
  {
    "id": "rejection-1",
    "blocker": "rejection",
    "text": "Rejection is data, not a diagnosis of my worth."
  },
  {
    "id": "rejection-2",
    "blocker": "rejection",
    "text": "Every 'no' moves me closer to the right 'yes'."
  },
  {
    "id": "rejection-3",
    "blocker": "rejection",
    "text": "I can handle disappointment. I have before."
  },
  {
    "id": "rejection-4",
    "blocker": "rejection",
    "text": "A rejection of my application is not a rejection of me."
  },
  {
    "id": "rejection-5",
    "blocker": "rejection",
    "text": "I apply broadly because I respect my own potential."
  },
  {
    "id": "rejection-6",
    "blocker": "rejection",
    "text": "The cost of not trying is higher than the cost of hearing no."
  },
  {
    "id": "rejection-7",
    "blocker": "rejection",
    "text": "I separate the outcome from the effort. The effort is mine to control."
  },
  {
    "id": "rejection-8",
    "blocker": "rejection",
    "text": "Resilience is built one application at a time."
  },
  {
    "id": "rejection-9",
    "blocker": "rejection",
    "text": "I would rather be rejected for trying than regret never applying."
  },
  {
    "id": "rejection-10",
    "blocker": "rejection",
    "text": "Each interview makes the next one easier, whatever the result."
  },
  {
    "id": "rejection-11",
    "blocker": "rejection",
    "text": "I keep going. That is the whole strategy."
  },
  {
    "id": "rejection-12",
    "blocker": "rejection",
    "text": "My value does not fluctuate with any single decision."
  },
  {
    "id": "competition-1",
    "blocker": "competition",
    "text": "I don't need to beat everyone. I need to be right for one role."
  },
  {
    "id": "competition-2",
    "blocker": "competition",
    "text": "Competition filters out the casual. I am not casual."
  },
  {
    "id": "competition-3",
    "blocker": "competition",
    "text": "My combination of skills is unique. There is no exact substitute for me."
  },
  {
    "id": "competition-4",
    "blocker": "competition",
    "text": "A tough market rewards the prepared. I prepare."
  },
  {
    "id": "competition-5",
    "blocker": "competition",
    "text": "I focus on what I control: my craft, my story, my follow-through."
  },
  {
    "id": "competition-6",
    "blocker": "competition",
    "text": "Someone gets hired for every role. There is no reason it cannot be me."
  },
  {
    "id": "competition-7",
    "blocker": "competition",
    "text": "I stand out by being specific, not by being loud."
  },
  {
    "id": "competition-8",
    "blocker": "competition",
    "text": "The market is competitive for generic candidates. I am not generic."
  },
  {
    "id": "competition-9",
    "blocker": "competition",
    "text": "I turn competition into fuel for sharper preparation."
  },
  {
    "id": "competition-10",
    "blocker": "competition",
    "text": "Scarcity thinking shrinks me. I play to win, not to survive."
  },
  {
    "id": "competition-11",
    "blocker": "competition",
    "text": "My network, my experience, my voice — that is my moat."
  },
  {
    "id": "competition-12",
    "blocker": "competition",
    "text": "I have competed before and won. This is familiar territory."
  },
  {
    "id": "networking-1",
    "blocker": "networking",
    "text": "Networking is just being genuinely curious about people."
  },
  {
    "id": "networking-2",
    "blocker": "networking",
    "text": "One real conversation beats fifty shallow connections."
  },
  {
    "id": "networking-3",
    "blocker": "networking",
    "text": "I have something to offer in every conversation, even as a listener."
  },
  {
    "id": "networking-4",
    "blocker": "networking",
    "text": "People remember warmth more than credentials."
  },
  {
    "id": "networking-5",
    "blocker": "networking",
    "text": "I follow up. That alone puts me ahead of most."
  },
  {
    "id": "networking-6",
    "blocker": "networking",
    "text": "Asking for advice is a compliment, not an imposition."
  },
  {
    "id": "networking-7",
    "blocker": "networking",
    "text": "I build relationships before I need them."
  },
  {
    "id": "networking-8",
    "blocker": "networking",
    "text": "My story is interesting when I tell it with conviction."
  },
  {
    "id": "networking-9",
    "blocker": "networking",
    "text": "I belong in rooms where my future is being discussed."
  },
  {
    "id": "networking-10",
    "blocker": "networking",
    "text": "A short, honest message outperforms a polished pitch."
  },
  {
    "id": "networking-11",
    "blocker": "networking",
    "text": "I treat every interaction as the start of something, not a transaction."
  },
  {
    "id": "networking-12",
    "blocker": "networking",
    "text": "Confidence in networking is a muscle. I am training it."
  },
  {
    "id": "confidence-1",
    "blocker": "confidence",
    "text": "Confidence is built by keeping promises to myself."
  },
  {
    "id": "confidence-2",
    "blocker": "confidence",
    "text": "I walk in prepared, and preparation looks like confidence."
  },
  {
    "id": "confidence-3",
    "blocker": "confidence",
    "text": "My voice deserves the same airtime as anyone else's."
  },
  {
    "id": "confidence-4",
    "blocker": "confidence",
    "text": "I stop shrinking to make others comfortable."
  },
  {
    "id": "confidence-5",
    "blocker": "confidence",
    "text": "I have handled hard things. I can handle this room."
  },
  {
    "id": "confidence-6",
    "blocker": "confidence",
    "text": "Confidence is not arrogance. It is clarity about my value."
  },
  {
    "id": "confidence-7",
    "blocker": "confidence",
    "text": "I speak about my work with pride, not apology."
  },
  {
    "id": "confidence-8",
    "blocker": "confidence",
    "text": "I trust my preparation and my instincts equally."
  },
  {
    "id": "confidence-9",
    "blocker": "confidence",
    "text": "Every small win today compounds into tomorrow's confidence."
  },
  {
    "id": "confidence-10",
    "blocker": "confidence",
    "text": "I am the expert on my own experience."
  },
  {
    "id": "confidence-11",
    "blocker": "confidence",
    "text": "I choose to be visible. Visibility creates opportunity."
  },
  {
    "id": "confidence-12",
    "blocker": "confidence",
    "text": "I carry myself like someone who expects good outcomes."
  },
  {
    "id": "direction-1",
    "blocker": "direction",
    "text": "Clarity comes from action, not from waiting."
  },
  {
    "id": "direction-2",
    "blocker": "direction",
    "text": "I start with the smallest next step. Momentum does the rest."
  },
  {
    "id": "direction-3",
    "blocker": "direction",
    "text": "Not knowing the whole path is normal. I only need the next move."
  },
  {
    "id": "direction-4",
    "blocker": "direction",
    "text": "I explore broadly, then commit deeply."
  },
  {
    "id": "direction-5",
    "blocker": "direction",
    "text": "Every experiment teaches me something, even the ones that fail."
  },
  {
    "id": "direction-6",
    "blocker": "direction",
    "text": "I give myself permission to change direction with new information."
  },
  {
    "id": "direction-7",
    "blocker": "direction",
    "text": "A messy start beats a perfect plan that never launches."
  },
  {
    "id": "direction-8",
    "blocker": "direction",
    "text": "I talk to people doing the work I want to do. That is research."
  },
  {
    "id": "direction-9",
    "blocker": "direction",
    "text": "My career is a portfolio of bets, not a single straight line."
  },
  {
    "id": "direction-10",
    "blocker": "direction",
    "text": "I define progress weekly, not yearly."
  },
  {
    "id": "direction-11",
    "blocker": "direction",
    "text": "Uncertainty is not a stop sign. It is an invitation to explore."
  },
  {
    "id": "direction-12",
    "blocker": "direction",
    "text": "I will figure it out the way I always have: one step at a time."
  }
];

if (typeof window !== "undefined") { window.AFFIRMATIONS = AFFIRMATIONS; }
