import type { SeedPost } from "@/types/post";

// Original illustrative summaries, not verified editorial content or current news.
// Seed data only: `npm run seed` upserts these into public.post, and the app reads
// content from the database. Array order becomes feed order, newest first.
export const posts: SeedPost[] = [
  {
    id: "psychology-retrieval", topic: "Psychology", title: "The useful struggle of remembering",
    explanation: [
      "Closing a book and trying to explain its argument feels harder than reading the same page again. That effort can be useful. Retrieval practice means bringing information back from memory instead of simply encountering it once more.",
      "After reading something, put it aside and write three things you remember. Then check the original and correct the gaps. Familiarity with a sentence can feel like understanding; attempting to reconstruct it gives you a clearer picture of what you can actually recall. Keep the exercise low stakes: a blank moment is information about what to revisit.",
    ],
    insight: "Test your memory to practise learning, not just to measure it.",
    deeper: "Retrieval is not a guarantee of accurate recall. Checking your answer matters because you can also retrieve a mistake. Vary the prompt: explain a concept, give an example, then distinguish it from a neighbouring idea. These tasks ask more of memory than recognising the right phrase on a page. Leave some time before the next attempt so that recall requires effort again.",
    source: { label: "The Learning Scientists · Retrieval practice", url: "https://www.learningscientists.org/blog/2016/6/23-1" },
  },
  {
    id: "economics-opportunity", topic: "Economics", title: "The hidden price of saying yes",
    explanation: [
      "A choice costs more than the money on its receipt. Opportunity cost is the value of the best alternative you give up. If you spend a free afternoon repairing a chair, the relevant comparison might be the walk you would otherwise have taken, rather than every possible use of those hours added together.",
      "This way of thinking makes a constraint visible. Time, space and attention are limited even when a purchase is free. Before accepting another commitment, name the most valuable thing it would displace. The answer may still be yes, but you are comparing two real possibilities rather than a benefit with an imaginary absence of cost.",
    ],
    insight: "Compare a choice with your best available alternative.",
    deeper: "A production possibilities frontier applies this logic to two outputs made with limited resources. Moving along the frontier gains some of one output by giving up some of the other. A curved frontier reflects resources that are not equally suited to every use: shifting more of them can make each extra unit increasingly costly. The model simplifies reality, but makes trade-offs explicit.",
    source: { label: "OpenStax · Production possibilities and social choices", url: "https://openstax.org/books/principles-economics-2e/pages/2-2-the-production-possibilities-frontier-and-social-choices" },
  },
  {
    id: "art-perspective", topic: "Art & design", title: "A whole world from one viewpoint",
    explanation: [
      "Imagine looking down a straight railway track. The rails remain parallel on the ground, yet appear to approach each other in the distance. Linear perspective uses this projection to suggest depth on a flat surface. In one-point perspective, a set of parallel lines going away from the viewer converges towards one vanishing point.",
      "Draw a horizon, mark a point on it, then draw the edges of a road towards that point. Add objects that become smaller on the page as they recede. The illusion depends on a consistent imagined viewpoint, rather than on drawing distant things at their actual size.",
    ],
    insight: "A convincing space can emerge from a consistent rule of projection.",
    deeper: "The horizon corresponds to the viewer’s eye level. Moving it changes whether we seem to look down on or up at objects. One-point perspective is a special arrangement; rotate a box and different sets of horizontal edges can converge towards two vanishing points. Perspective is a representational choice, not a universal test of artistic quality. Other traditions organise space for different purposes.",
    source: { label: "Khan Academy · Linear perspective", url: "https://www.khanacademy.org/humanities/renaissance-reformation/early-renaissance1/beginners-renaissance-florence/a/linear-perspective-interactive" },
  },
  {
    id: "astronomy-seasons", topic: "Astronomy", title: "Summer begins with a tilt",
    explanation: [
      "Earth’s seasons are chiefly a consequence of its tilted axis. As Earth travels around the Sun, each hemisphere takes a turn leaning towards it. That hemisphere gets longer days and sunlight that strikes the ground more directly. Both increase the solar energy received over a day.",
      "Picture a torch shining straight onto a table, then tilt the beam. The same beam spreads across a larger area at the shallow angle. Something similar happens to sunlight in winter. The hemispheres have opposite seasons, which is a useful clue that changing distance from the Sun cannot be the main explanation for the seasonal cycle.",
    ],
    insight: "Day length and the angle of sunlight work together to shape seasons.",
    deeper: "Earth’s axis maintains roughly the same orientation over one orbit. The solstices mark the extremes of the seasonal daylight pattern; around the equinoxes, neither hemisphere leans towards the Sun. Temperature does not respond instantly to incoming energy: land and especially oceans store heat. This helps explain why the warmest part of a season can follow the longest day.",
    source: { label: "NASA Space Place · What causes the seasons?", url: "https://spaceplace.nasa.gov/seasons/en/" },
  },
  {
    id: "biology-selection", topic: "Biology", title: "Evolution has no destination",
    explanation: [
      "Natural selection can change a population when individuals differ in heritable traits and those differences affect reproductive success. If a trait helps its carriers leave more surviving offspring in a particular environment, it can become more common over generations. Individuals do not acquire a useful inherited feature simply because they need it.",
      "Consider an insect population with inherited colour variation. If birds more easily spot one colour against the local bark, another colour may become more common. Change the bark or the predators and the advantage can change too. A trait is advantageous in a context; evolution is not a ladder towards a single ideal organism.",
    ],
    insight: "Selection filters heritable variation through a particular environment.",
    deeper: "Mutation introduces genetic variation without anticipating what an organism will need. Selection is not the only cause of evolutionary change: chance changes in gene frequencies, called genetic drift, also matter, especially in small populations. A feature’s prevalence therefore does not by itself prove that the feature is an adaptation. Explaining it requires evidence about inheritance, history and reproductive consequences.",
    source: { label: "National Park Service · Natural selection background", url: "https://www.nps.gov/flfo/learn/education/unit-three-background.htm" },
  },
  {
    id: "computing-binary", topic: "Computer science", title: "Find more by ruling out half",
    explanation: [
      "To find a name in a sorted list, you do not have to start at the beginning. Inspect the middle. If the target comes earlier, discard the later half; if it comes later, discard the earlier half. Repeat on the remaining range. This is binary search, and its power comes from eliminating possibilities rather than examining every item.",
      "A thousand candidates shrink to about five hundred, then two hundred and fifty, and soon only one. Each step buys a large reduction. But the ordering is essential: without it, a comparison with the middle tells you nothing reliable about which half contains your target.",
    ],
    insight: "Structure lets one observation eliminate many possibilities.",
    deeper: "The number of comparisons grows logarithmically: doubling a sorted array adds roughly one more step. That does not make every implementation equally fast. An array allows direct access to the middle; a linked list may require traversal to get there. If the collection is unsorted and you only need one lookup, the cost of sorting first can outweigh the saving from binary search.",
    source: { label: "Cornell University · Searching and sorting", url: "https://www.cs.cornell.edu/courses/cs1110/2021sp/schedule/lecture/lec25/lec25.html" },
  },
  {
    id: "music-syncopation", topic: "Music", title: "The rhythm between the beats",
    explanation: [
      "Tap a steady pulse and count ‘one and two and three and four and’. Now clap on the ‘and’ while your foot keeps the numbered beats. The claps fall between the main pulses. When music emphasises these weaker positions and downplays expected stronger ones, it can create syncopation.",
      "The effect depends on an underlying sense of metre. You feel the emphasis pulling against a pattern you can still follow. A melody can anticipate a beat or sustain a note across it while the accompaniment holds the pulse steady. The interest comes from that relationship, not simply from playing faster or using more notes.",
    ],
    insight: "Rhythmic surprise needs an expectation to push against.",
    deeper: "One common device is a note that starts on a weak subdivision and continues through a stronger beat, removing the fresh attack you expected there. Syncopation is distinct from tempo, which describes the speed of the pulse, and from swing, which concerns the timing relationship between subdivisions. They can coexist, but changing one does not necessarily change the others.",
    source: { label: "Open Music Theory · Syncopation", url: "https://openmusictheory.github.io/syncopation.html" },
  },
  {
    id: "physics-energy", topic: "Physics", title: "Energy survives. Usefulness changes.",
    explanation: [
      "A hot drink cools as energy passes into its surroundings. The energy has not disappeared, but it is now more spread out. Conservation of energy tells us how much energy exists; it does not tell us how much can be converted into useful work in a particular situation.",
      "A temperature difference can drive a heat engine. Once everything reaches the same temperature, that opportunity is gone unless another difference is introduced. This is why energy conservation and the limits on energy conversion are separate ideas. A process can conserve every joule while leaving less capacity to do the job we wanted.",
    ],
    insight: "Conserving energy does not preserve its capacity to do useful work.",
    deeper: "The second law says that total entropy cannot decrease in an isolated system. Local decreases are possible when accompanied by sufficient increases elsewhere: a refrigerator cools its interior while using work and releasing heat into the room. Living organisms likewise exchange energy and matter with their surroundings. Their local organisation is compatible with the second law because they are not isolated systems.",
    source: { label: "OpenStax · The laws of thermodynamics", url: "https://openstax.org/books/biology-2e/pages/6-3-the-laws-of-thermodynamics" },
  },
  {
    id: "mathematics-weighted-averages", topic: "Mathematics", title: "An average needs its weights",
    explanation: [
      "Suppose one group contains two people with an average score of 10, while another contains eight people with an average score of 20. Averaging the two group averages gives 15, but the average across all ten people is 18: (2 × 10 + 8 × 20) ÷ 10.",
      "Each group average represents a different number of observations. To combine them, recover each group's total, add the totals, then divide by the combined number of observations. Equal weighting answers a different question: what is the average group average?",
    ],
    insight: "Before combining averages, ask how many observations each one represents.",
    deeper: "The same issue appears when comparing rates. Two journeys covering equal distances do not necessarily take equal times, so averaging their speeds equally will usually not give the speed for the combined journey. Start from total distance divided by total time.",
  },
  {
    id: "logic-necessary-sufficient", topic: "Logic", title: "A requirement is not a guarantee",
    explanation: [
      "A square must have four sides. Having four sides is therefore necessary for being a square, but it is not sufficient: many four-sided shapes are not squares. Being a square is sufficient to establish that a shape has four sides.",
      "This distinction helps when assessing an argument. Showing that a requirement is met does not establish the conclusion unless that requirement also guarantees it. Ask whether a counterexample could meet the stated condition without producing the promised result.",
    ],
    insight: "Something can be required for an outcome without being enough to produce it.",
    deeper: "If P implies Q, P is sufficient for Q and Q is necessary for P. Reversing the implication requires a separate argument. Establishing both directions gives an equivalence: P holds if and only if Q holds.",
  },
  {
    id: "operations-bottleneck", topic: "Operations", title: "The slowest stage sets the pace",
    explanation: [
      "Imagine a simple production line with three stages that can process 12, 5 and 9 items per hour. Every item must pass through all three stages. Even with enough demand and supplies, sustained output cannot exceed five items per hour while those capacities remain fixed.",
      "Making the first stage faster does not raise that limit. It may simply create a larger queue before the second stage. Improving the constrained stage is what can increase the capacity of the whole line.",
    ],
    insight: "Improving one part helps the whole system only when it addresses the actual constraint.",
    deeper: "This example assumes a steady process without rework, failures or alternative routes. Real systems add variability, so queues and buffers matter too. Once the second stage exceeds nine items per hour, the third stage becomes the new capacity limit.",
  },
];
