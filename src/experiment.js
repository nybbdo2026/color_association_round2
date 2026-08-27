import { initJsPsych } from "jspsych";
import htmlButtonResponse from "https://unpkg.com/@jspsych/plugin-html-button-response@1.1.3/dist/index.js";
import preload from "https://unpkg.com/@jspsych/plugin-preload@1.1.3/dist/index.js";

import { ATTRIBUTES, PALETTES, MIN_RESPONSE_TIME_MS, NEXT_SURVEY_URL } from "../config.js";
import { createSessionId, startSession, logTrial, completeSession } from "./firebase.js";

const sessionId = createSessionId();

// This survey is part 2 of 3. `rdud` and `state` arrive as query params on
// our own inbound URL and must be captured, saved, and passed through
// unchanged to part 3 (Decipher) when this survey finishes.
const inboundParams = new URLSearchParams(window.location.search);
const rdud = inboundParams.get("rdud") || "";
const state = inboundParams.get("state") || "";
const inboundCode = inboundParams.get("inbound_code") || "";

function buildNextSurveyUrl() {
  const params = new URLSearchParams({ list: "1" });
  params.set("state", state);
  params.set("rdud", rdud);
  return `${NEXT_SURVEY_URL}?${params.toString()}`;
}

const jsPsych = initJsPsych({
  display_element: "jspsych-target",
  on_finish: () => {
    let redirected = false;
    const redirectOnce = () => {
      if (redirected) return;
      redirected = true;
      window.location.href = buildNextSurveyUrl();
    };

    // Some ad blockers and mobile networks treat *.firebaseio.com as a
    // tracker and silently hang the request instead of rejecting it, which
    // would leave completeSession's promise unsettled forever. This hard
    // timeout guarantees the respondent moves on regardless.
    setTimeout(redirectOnce, 2000);

    completeSession(sessionId)
      .catch((error) => console.error("Failed to complete session:", error))
      .finally(redirectOnce);
  },
});

function shuffledCopy(array) {
  return jsPsych.randomization.shuffle(array.slice());
}

// Lets desktop respondents answer with the classic IAT keys (E = left
// button, I = right button) in addition to clicking/tapping. Returns a
// cleanup function to remove the listener once the trial ends.
function bindKeyboardChoice() {
  const handler = (event) => {
    const key = event.key.toLowerCase();
    if (key === "e") {
      document.querySelector("#jspsych-html-button-response-button-0")?.click();
    } else if (key === "i") {
      document.querySelector("#jspsych-html-button-response-button-1")?.click();
    }
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

const TOO_FAST_WARNING = `<p class="too-fast-warning">That was too fast — please take a moment to consider each word before responding.</p>`;
const DEFAULT_BUTTON_HTML = '<button class="jspsych-btn">%choice%</button>';

// Builds a single trial that alternates between two phases: the actual
// question, and (if answered too fast) a standalone warning screen shown on
// its own before the question repeats. Looping on ONE trial like this, with
// its own content chosen dynamically per phase, avoids relying on jsPsych's
// per-pass evaluation of a second sibling trial's conditional_function,
// which does not reliably see the value the *current* pass just set.
function buildRepeatingTrial({ data, buildStimulus, buildChoices, buildButtonHtml, onLoad, onValidResponse }) {
  const state = { phase: "question", done: false };
  let cleanupKeyboard = () => {};

  const trial = {
    type: htmlButtonResponse,
    stimulus: () => (state.phase === "warning" ? TOO_FAST_WARNING : buildStimulus()),
    choices: () => (state.phase === "warning" ? ["Continue"] : buildChoices()),
    button_html: () =>
      state.phase === "warning" ? DEFAULT_BUTTON_HTML : buildButtonHtml ? buildButtonHtml() : DEFAULT_BUTTON_HTML,
    data,
    on_load: () => {
      if (state.phase === "question" && onLoad) {
        cleanupKeyboard = onLoad();
      }
    },
    on_finish: (data) => {
      if (state.phase === "warning") {
        state.phase = "question";
        return;
      }
      cleanupKeyboard();
      cleanupKeyboard = () => {};
      const tooFast = data.rt !== null && data.rt < MIN_RESPONSE_TIME_MS;
      if (tooFast) {
        state.phase = "warning";
        return;
      }
      state.done = true;
      onValidResponse(data);
    },
  };

  return { timeline: [trial], loop_function: () => !state.done };
}

function buildIntroScreen() {
  return {
    type: htmlButtonResponse,
    stimulus: `
      <h2>Welcome</h2>
      <p>In this survey, you'll be shown two color palettes, one at a time.
      For each palette, you'll see a series of words and quickly decide
      whether each one <strong>Fits</strong> or <strong>Does Not Fit</strong>
      your personal impression of that palette.</p>
      <p>There are no right or wrong answers — please go with your first
      instinct and respond as quickly as you comfortably can.</p>
    `,
    choices: ["Continue"],
  };
}

function buildPaletteFamiliarizationScreen(paletteOrder) {
  return {
    type: htmlButtonResponse,
    stimulus: `
      <h2>The Color Palettes</h2>
      <p>Take a moment to look at both color palettes below. You'll be asked
      to respond to a series of words for each one, separately.</p>
      <div class="palette-preview">
        ${paletteOrder
          .map((p) => `<img src="${p.image}" alt="${p.label}" class="palette-preview-img" />`)
          .join("")}
      </div>
    `,
    choices: ["Continue"],
  };
}

function buildBreakerScreen() {
  return {
    type: htmlButtonResponse,
    stimulus: `
      <h2>Nice work!</h2>
      <p>You've completed the first set of questions. Next, you'll answer
      the same kind of questions for the second color palette.</p>
    `,
    choices: ["Continue"],
  };
}

function buildFitBlock(palette) {
  const instructions = {
    type: htmlButtonResponse,
    stimulus: `
      <h2>${palette.label}</h2>
      <img src="${palette.image}" alt="${palette.label}" class="palette-preview-img" />
      <p>You'll see a series of words. For each one, choose as quickly as you
      can whether it <strong>Fits</strong> or <strong>Does Not Fit</strong>
      with your personal impressions of this color palette.</p>
      <p>On a computer, you can also press <strong>E</strong> for Fits or
      <strong>I</strong> for Does Not Fit.</p>
    `,
    choices: ["Start"],
  };

  const choices = ["Fits", "Does Not Fit"];

  const trials = shuffledCopy(ATTRIBUTES).map((attribute) =>
    buildRepeatingTrial({
      data: {
        task: "fit_judgment",
        palette_id: palette.id,
        palette_label: palette.label,
        attribute,
      },
      buildStimulus: () => `
        <img src="${palette.image}" alt="${palette.label}" class="trial-palette-img" />
        <div class="attribute-word">${attribute}</div>
      `,
      buildChoices: () => choices,
      buildButtonHtml: () => [
        '<button class="jspsych-btn fits-btn">%choice%</button>',
        '<button class="jspsych-btn does-not-fit-btn">%choice%</button>',
      ],
      onLoad: () => bindKeyboardChoice(),
      onValidResponse: (data) => {
        data.response_label = choices[data.response];
        logTrial(sessionId, {
          task: data.task,
          palette_id: data.palette_id,
          palette_label: data.palette_label,
          attribute: data.attribute,
          response_label: data.response_label,
          rt_ms: data.rt,
        }).catch((error) => console.error("Failed to log trial:", error));
      },
    })
  );

  return [instructions, ...trials];
}

async function run() {
  // Randomized across respondents to counterbalance order effects, but each
  // respondent still completes both palette blocks in full.
  const paletteOrder = shuffledCopy(PALETTES);

  // Fire-and-forget: a Firebase hiccup (or, right now, the placeholder
  // credentials in firebase-config.js) should never block the survey
  // from rendering for the respondent.
  startSession(sessionId, {
    user_agent: navigator.userAgent,
    palette_order: paletteOrder.map((p) => p.id),
    rdud,
    state,
    inbound_code: inboundCode,
  }).catch((error) => console.error("Failed to start Firebase session:", error));

  const timeline = [
    {
      type: preload,
      images: PALETTES.map((p) => p.image),
    },
    buildIntroScreen(),
    buildPaletteFamiliarizationScreen(paletteOrder),
  ];

  paletteOrder.forEach((palette, index) => {
    timeline.push(...buildFitBlock(palette));
    if (index < paletteOrder.length - 1) {
      timeline.push(buildBreakerScreen());
    }
  });

  timeline.push({
    type: htmlButtonResponse,
    stimulus: "<h2>Thank you!</h2><p>Your responses have been recorded. Please click the continue button to proceed to the final portion of the study. Do not close your browser window.</p>",
    choices: ["Continue"],
  });

  jsPsych.run(timeline);
}

run();
