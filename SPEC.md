# PROJECT SPECIFICATION — T

1. PRODUCT IDENTITY AND PURPOSE

App name: T
Project directory and GitHub repository: tek-shape
Tagline: Know broadly. Explore deeply.
Underlying concept: Become Tek-shaped — a personal interpretation of T-shaped knowledge, combining broad understanding across disciplines (the horizontal bar of the T) with progressively deeper expertise in subjects of interest (the vertical stem).

Build a private, single-user, mobile-first personal knowledge-feed app that can replace my habitual use of X/Twitter and other social media. The interaction should feel as effortless as scrolling a social feed, but the outcome should be a progressively broader, deeper, more reliable understanding of the world.

This is initially a personal app and a public coding-portfolio project, NOT a social network or a product for multiple users.

2. USER EXPERIENCE

The primary device is my Android phone. Develop on my laptop, but design for phone-sized screens first. The app should eventually work as an installable progressive web app (PWA) with a home-screen icon and app-like display. It must also work on desktop.

Main feed:
- A continuous, responsive vertical feed of short but substantial, self-contained knowledge posts.
- Posts must teach a useful idea, not merely tease an external article.
- The next batch should already be prepared and load quickly, ideally automatically as the reader approaches the end. A “Keep scrolling” button revealing four more posts is acceptable for the first MVP.
- Keep the user's place in the feed when they leave and return. Avoid reshuffling previously assigned posts.
- The app should feel calm, readable, modern and minimal rather than gamified or engagement-maximising.

Each post contains:
- Stable unique ID.
- Topic and subtopic.
- Clear title.
- Concise but substantive explanation.
- Distinct “Key insight” takeaway.
- Optional deeper explanation, revealed in place.
- Direct, relevant source link(s), with publisher and publication date where applicable.
- Content type: current news or timeless/evergreen knowledge.
- Difficulty/depth and canonical concepts taught.
- Publication/event date for time-sensitive material where relevant.

Immediately BELOW EACH post, display exactly five compact icon-only controls in this order:
1. Thumbs up: more content like this at the SAME difficulty level.
2. Thumbs down: this post is not interesting. Do not interpret this as a permanent ban on its entire discipline.
3. Double check/tick: keep this topic, but go MORE ADVANCED; the current concept was too familiar.
4. Bookmark: save independently of the rating.
5. Book-open: expand/collapse the deeper explanation IN PLACE, within the post and above that post's controls. It must not open a new page or submit a new chat request.

The three ratings are mutually exclusive per post; clicking the selected rating again may clear it. All controls need accessible names, visible selected states and adequate touch targets. Feedback and bookmarks must persist across sessions. Do not require textual labels next to the icons.

Library:
- A private view of bookmarked posts and, later, reading history.
- Search and filtering can follow after the basic feed is reliable.

Knowledge map (later):
- Show the breadth of fields explored and depth reached within them.
- Avoid a single composite knowledge score or arbitrary gamification.

3. EDITORIAL AND PERSONALISATION REQUIREMENTS

The feed must develop broad intellectual foundations, not become a narrow stream of finance, AI, science or any other repeatedly popular category.

Aim for genuinely different disciplines and subdisciplines across adjacent posts and editions. Prevent near-duplicates at the level of the underlying idea, not merely identical titles. Revisiting a discipline is useful when teaching a genuinely new concept or moving to greater depth.

The content mix should include BOTH current news and timeless knowledge. Do not enforce a rigid 50/50 ratio if that reduces breadth, accuracy or source quality. News should provide useful context and teach durable ideas, not just recount headlines.

Posts should be accessible to an intelligent adult without assuming specialist training, but not condescending or repeatedly introductory. Each should have a meaningful takeaway and an optional deeper layer.

Personalisation must distinguish:
- “More”: maintain topic/angle and difficulty.
- “Uninteresting”: reduce similar content without excluding an entire discipline.
- “Advanced”: retain the field but avoid reteaching familiar concepts; progress to a genuinely harder or more specialised idea.
- Unrated: neutral.
- Bookmark: save for later, not necessarily a positive recommendation signal.

Initial feedback from the proof of concept:
More at the same level: food science, cell biology, neuroscience, transport engineering.
Keep but go more advanced: philosophy of language, computer science, planetary exploration, history of commerce, psychology of perception, scientific measurement, cartography, conservation biology.
Less of the particular material shown: disaster preparedness, education/international cooperation, literature.
Biomedical data: neutral/unrated.
Subsequent feedback also indicated that information theory, economic history, design/accessibility and demography were too introductory; neuroscience remained interesting at its current level. Do not overfit to this small sample or allow these preferences to crowd out new disciplines.

Store canonical concepts taught per post and the user's exposure/feedback. The future feed selector should consider concept novelty, topic diversity, appropriate difficulty, source quality and freshness. A stable prepared feed queue should preserve the user's reading order.

4. SOURCE QUALITY AND CONTENT GENERATION

Accuracy and verifiable sourcing are core product requirements.

Earlier chat-based proof-of-concept editions sometimes included overly specific news claims or links that did not establish those claims. Do NOT import those posts as verified content.

For the eventual automated pipeline, separate:
A. Source discovery: gather candidate news and evergreen reference material.
B. Verification: check that accessible sources directly support material factual claims, including dates and context.
C. Writing: turn supported material into original, concise explanations with a key insight and deeper layer.
D. Editorial checks: identify duplicate concepts, unsupported claims, misleading framing, low-quality sources and insufficient topic diversity.
E. Feed selection: prepare a varied, personalised queue before the user opens the app.

Require matching source URLs for factual news posts, record publication and access dates, and distinguish event date from article date. Never fabricate citations, links, research papers, quotes or recent developments. Discard or hold candidates that fail verification. Do not treat a model-generated citation as proof. Do not automatically present a draft as verified.

Content generation should happen server-side, ahead of reading, not as a blocking request every time the user scrolls. Maintain a buffer of unread verified posts. AI/API credentials must remain server-side.

For the initial local MVP, use clearly labelled, hand-written SAMPLE evergreen posts across eight genuinely different disciplines. Do not invent current news or claim that sample content has undergone independent verification.

5. TECHNICAL ARCHITECTURE

Project folder: tek-shape. Do not create a nested project folder.
Display name: T.
Use Next.js with TypeScript, App Router, Tailwind CSS and lucide-react, provided the chosen setup remains compatible with the intended Cloudflare deployment.

Build reusable components such as Feed, PostCard and FeedbackBar, with typed post data and stable IDs.

Development: local laptop with Codex.
Version control: PUBLIC GitHub repository named tek-shape, to provide a transparent coding portfolio and development history.
Hosting: Cloudflare, preferably a Cloudflare Workers-compatible full-stack setup, following current official guidance at implementation time.
Phone delivery: mobile-first PWA, accessible from a home-screen icon.
Future database/authentication: PostgreSQL via Supabase is the current preferred option, subject to checking deployment compatibility and costs.

The public repository and public deployment must NOT expose personal reading data, API keys, database credentials or server-side secrets. A public GitHub repository does not imply a publicly accessible personal feed. Once personal data is stored on the server, require private authentication and appropriate database row-level security.

A browser-local prototype is acceptable initially, but localStorage does not sync between phone and laptop. Add authenticated server-side persistence before daily cross-device use.

Use a conventional, maintainable project structure. Keep UI, data access, feed selection and content verification separate. Add clear README documentation and appropriate tests.

6. PERSISTENT DATA MODEL — TARGET DESIGN

Posts:
id, title, summary/body, key insight, deeper body, content type (news/evergreen), topic, subtopic, difficulty, publication/event dates, verification status, created_at and version/correction metadata as needed.

Post sources:
post_id, direct URL, title, publisher, source publication date, access date, and the claim(s) the source supports.

Concepts:
canonical concept ID/name, optional parent concept and relationships to posts.

User post state:
user_id, post_id, first_seen_at, read_at, rating (more/uninteresting/advanced/null), bookmarked, deeper_opened_at and updated_at.

Feed queue:
user_id, post_id, stable queue order and queued_at. Do not reshuffle already assigned posts.

Add appropriate constraints, indexes, migrations and row-level security when implementing the hosted database. Keep rating separate from bookmarking. Do not store private user state in the public source repository.

7. DEVELOPMENT PHASES AND ACCEPTANCE CRITERIA

PHASE 1 — LOCAL, WORKING FEED (BUILD THIS FIRST)
- Inspect the existing tek-shape directory and Node.js environment.
- Initialise the project IN THIS DIRECTORY if not already initialised.
- Build eight labelled sample evergreen posts spanning distinct disciplines.
- Show four initially; reveal four more with Keep scrolling.
- Implement all five controls immediately beneath EACH post.
- Make ratings mutually exclusive, bookmarks independent and deeper explanations expand in place.
- Persist ratings, bookmarks and feed position in browser localStorage, keyed by stable post ID.
- Make the interface polished, readable and responsive at Android phone widths.
- Add a simple bookmarked-posts view if straightforward.
- Add README, .gitignore and basic checks.
- Run lint and production build; fix errors and report what was actually tested.
- Do not add AI generation, Supabase or deployment during this phase.

PHASE 2 — PUBLIC CODE AND PHONE PREVIEW
- Review the first version and make focused, meaningful Git commits.
- Push to the public GitHub repository tek-shape, after checking for secrets and personal data.
- Configure a Cloudflare-compatible build using current official guidance.
- Deploy the sample-content app and test it on the phone.
- Make clear that this sample deployment is not yet a private authenticated personal feed.

PHASE 3 — PRIVATE, SYNCED DAILY APP
- Add sign-in and secure persistent storage.
- Sync ratings, bookmarks, read state and stable feed position across phone and laptop.
- Add the private library and installable PWA experience.
- Test authentication and database access restrictions before storing real personal data.

PHASE 4 — VERIFIED CONTENT ENGINE
- Implement source discovery, verification, generation, editorial checks and ahead-of-time queue preparation.
- Mix current news with timeless knowledge.
- Add concept-level deduplication, topic diversity and difficulty progression based on feedback.
- Maintain an unread buffer for fast scrolling.
- Introduce monitoring and cost controls for API usage.

PHASE 5 — REFINEMENT
- Improve search, library, knowledge map and personalisation based on actual use.
- Optimise for learning, novelty, source quality and voluntary return—not maximising screen time.

8. WORKING AGREEMENT FOR CODEX

Work incrementally. Inspect existing files before changing them. Do not overwrite working code without understanding it. Explain important architectural choices and trade-offs in plain language so I can learn and demonstrate my own coding understanding.

Prefer small, reviewable changes and meaningful commits. Run relevant checks and report failures honestly. Do not claim tests passed unless they ran. Do not commit, push, deploy, connect accounts, purchase services or introduce paid dependencies without asking me first.

START NOW WITH PHASE 1 ONLY. After completing it, provide exact local run instructions, a concise account of the files changed, test results, known limitations and the recommended next step.
