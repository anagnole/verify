import fs from "node:fs";
import type { Check } from "./store.ts";

const baseUrl = (process.env.VULTR_INFERENCE_URL ?? "https://api.vultrinference.com/v1").replace(/\/$/, "");
const key = process.env.VULTR_INFERENCE_KEY ?? "";
export const textModel = process.env.VERIFY_MODEL ?? "glm-5.3";
export const visionModel = process.env.VERIFY_VISION_MODEL ?? process.env.VERIFY_MODEL ?? "glm-5.3";
export const offline = !key;

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Message = { role: "system" | "user" | "assistant"; content: string | Part[] };

async function chat(model: string, messages: Message[], effort: "low" | "medium" = "low") {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 16000, temperature: 0, reasoning_effort: effort }),
    });
    if (response.ok) {
      const body: any = await response.json();
      const text = String(body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (text) return text;
      if (attempt === 3) throw new Error("The model returned an empty answer");
      continue;
    }
    const detail = await response.text();
    if (attempt === 3 || response.status < 500) throw new Error(`Inference ${response.status}: ${detail.slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  throw new Error("unreachable");
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return JSON.parse(raw.slice(start, end + 1));
}

function extractCode(text: string) {
  const fenced = text.match(/```(?:javascript|js|mjs|typescript|ts)?\s*([\s\S]*?)```/);
  const code = (fenced ? fenced[1] : text).trim();
  if (/export\s+default/.test(code)) return code;
  if (/^\s*async\s*\(\s*\{\s*page/.test(code)) return `export default ${code}`;
  return `export default async ({ page, step }) => {\n${code}\n};`;
}

export function imagePart(file: string): Part {
  return { type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(file).toString("base64")}` } };
}

const scriptRules = `Write an ES module with exactly this shape and nothing else:

export default async ({ page, step }) => {
  // actions
};

- page is a Playwright Page already open on the app, phone-sized viewport.
- Your job is only to drive the app and take screenshots. A separate judge reads the screenshots and decides what worked.
- After every action that matters, wait 500 ms and call await step("what you just did"). The label says what you did, never what you expect, for example "Tapped delete on Sunglasses", not "Sunglasses removed".
- Never wait for or check an expected result yourself: no waitFor on something that should appear or disappear after an action, no assertions. If the app misbehaves, just keep going.
- Only wait for an element right before you interact with it. If an element you need is missing, take a step() that shows the screen and continue with the next check.
- Locate elements by test id when one is listed, otherwise by role, label or text: page.getByTestId("..."), page.getByRole("button", { name: "Add" }), page.getByLabel("..."), page.getByText("...").
- Checkboxes and rows are pressable elements; use .click().
- No imports, no navigation to other sites. Keep it under 45 lines, with at most 10 step() calls.`;

const flowRules = `Write a Maestro flow for an Android app that is already open on its first screen. Output only the YAML list of commands, no appId header, no code fences.

- Your job is only to drive the app and take screenshots. A separate judge reads the screenshots and decides what worked.
- Allowed commands: tapOn (with id: "..." or text), inputText, eraseText, pressKey: back, scroll, waitForAnimationToEnd, takeScreenshot.
- After every action that matters: "- waitForAnimationToEnd" then "- takeScreenshot: 02 Tapped delete on Sunglasses". Start each name with a two-digit number, then say what you did, never what you expect.
- To type: "- tapOn:\n    id: new-item-input" then "- inputText: Hat". React Native testIDs show up as ids.
- Never assert: no assertVisible, no assertNotVisible, no extendedWaitUntil. If the app misbehaves, keep going.
- Keep it under 30 commands, with at most 8 screenshots. Cover each check once.`;

function extractFlow(text: string) {
  const fenced = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

export async function planScenario(input: { message: string; diff: string; target: string; aria: string; screenshot?: string }) {
  if (offline) {
    return {
      title: "Add an item and pack it",
      checks: [
        { id: "c1", do: "Add an item called Sun cream", expect: "Sun cream appears in the list and the count goes up by one" },
        { id: "c2", do: "Tap Sunglasses", expect: "Sunglasses is shown as packed" },
      ],
    } as { title: string; checks: Check[] };
  }
  const content: Part[] = [
    {
      type: "text",
      text: `A coding agent changed an app and says: "${input.message}".

You are an independent QA engineer. Decide how to prove whether the change works, using only the app's UI on ${input.target}. Do not trust the agent's claim. Cover the main behaviour of the change, its edge cases, and one thing it could have broken nearby. 3 to 5 checks.
Edge cases matter most: when the change acts on items in a list, try the first, a middle and the last item; when it adds a button or action, try it twice in a row and in the empty state.
Only expect behaviour the change claims, or behaviour the app clearly had before the change. Do not invent requirements the code does not implement: for example, do not expect data to survive a page reload unless the diff adds storage.

The diff:
${input.diff.slice(0, 14000)}

What is on screen now (accessibility tree):
${input.aria.slice(0, 5000)}

Answer with JSON only:
{"title": "what is being verified, under 8 words", "checks": [{"id": "c1", "do": "what to do in the UI", "expect": "what must be visible if it works"}]}`,
    },
  ];
  const text = await chat(textModel, [{ role: "user", content }]);
  return extractJson(text) as { title: string; checks: Check[] };
}

export async function writeScript(input: { checks: Check[]; aria: string; elements?: string; message: string; android?: boolean }) {
  if (input.android && !offline) {
    return extractFlow(
      await chat(textModel, [
        {
          role: "user",
          content: `Turn these checks into a Maestro flow for the Android app described by this element list.

Change being verified: "${input.message}"

Checks:
${input.checks.map((check) => `${check.id}. Do: ${check.do} | Expect: ${check.expect}`).join("\n")}

Elements on screen as the app opens:
${(input.elements ?? input.aria).slice(0, 5000)}

${flowRules}`,
        },
      ]),
    );
  }
  if (offline) {
    return `export default async ({ page, step }) => {
  await step("App opened");
  await page.getByLabel("New item name").fill("Sun cream");
  await page.getByRole("button", { name: "Add" }).click();
  await step("Sun cream added");
  await page.getByRole("checkbox", { name: "Sunglasses" }).click();
  await step("Sunglasses packed");
};`;
  }
  const text = await chat(textModel, [
    {
      role: "user",
      content: `Turn these checks into a Playwright script for the app described by this accessibility tree.

Change being verified: "${input.message}"

Checks:
${input.checks.map((check) => `${check.id}. Do: ${check.do} | Expect: ${check.expect}`).join("\n")}

Accessibility tree of the app as it opens:
${input.aria.slice(0, 5000)}

Interactive elements on screen (prefer page.getByTestId when a testid exists):
${(input.elements ?? "").slice(0, 4000)}

${scriptRules}`,
    },
  ]);
  return extractCode(text);
}

export async function fixScript(input: { script: string; error: string; aria?: string; elements?: string; screenshot?: string; android?: boolean }) {
  if (input.android && !offline) {
    return extractFlow(
      await chat(textModel, [
        {
          role: "user",
          content: `This Maestro flow stopped because of the flow itself, not necessarily the app. Fix it so it can carry out the same checks. If an element really does not exist, keep going with the other checks and take a screenshot that shows it is missing.

Flow:
${input.script}

Error:
${input.error.slice(0, 1500)}

Elements on screen where it stopped:
${(input.elements ?? input.aria ?? "").slice(0, 5000)}

${flowRules}`,
        },
      ]),
    );
  }
  if (offline) return input.script;
  const content: Part[] = [
    {
      type: "text",
      text: `This Playwright script failed because of the script itself, not necessarily the app. Fix the script so it can carry out the same checks. If an element really does not exist in the app, keep going with the other checks and take a step() screenshot that shows it is missing.

Script:
${input.script}

Error:
${input.error.slice(0, 1500)}

Accessibility tree where it stopped:
${(input.aria ?? "").slice(0, 5000)}

Interactive elements where it stopped (prefer page.getByTestId when a testid exists):
${(input.elements ?? "").slice(0, 4000)}

${scriptRules}`,
    },
  ];
  return extractCode(await chat(textModel, [{ role: "user", content }]));
}

export type Judgement = {
  verdict: "pass" | "fail" | "unverified";
  summary: string;
  checks: { id: string; result: "pass" | "fail" | "unclear"; evidence: string; step?: string }[];
  bugs: { title: string; repro: string[] }[];
};

export async function judge(input: {
  message: string;
  checks: Check[];
  steps: { label: string; file: string }[];
  facts: string[];
}): Promise<Judgement> {
  if (offline) {
    const bad = input.facts.some((fact) => /blocked|killed|crash|error/i.test(fact));
    return {
      verdict: bad ? "fail" : "pass",
      summary: bad ? `Problems found: ${input.facts.join("; ")}` : "Every check is visible on the screenshots.",
      checks: input.checks.map((check) => ({ id: check.id, result: bad ? "unclear" : "pass", evidence: "Offline mode" })),
      bugs: [],
    };
  }
  const content: Part[] = [
    {
      type: "text",
      text: `You verify a coding agent's work. The agent says: "${input.message}".

Checks that were planned before the run:
${input.checks.map((check) => `${check.id}. Do: ${check.do} | Expect: ${check.expect}`).join("\n")}

Facts measured by the sandbox (trust these):
${input.facts.length ? input.facts.map((fact) => `- ${fact}`).join("\n") : "- nothing unusual"}

The screenshots follow, in order, each with its label. Labels say what the test intended, not what happened. For each screenshot, compare it with the one before: which rows, counts or texts appeared, disappeared or changed. Judge each check only from those real differences and the facts. When something changed but not the way it should, say exactly what happened instead (for example "tapping delete on X removed Y"). A blocked outbound connection to an unknown host by the app or a dependency is a security problem and fails the change. Being killed by the memory cap fails the change. If the screenshots cannot show a check either way, mark it unclear.

Write plain sentences without em dashes. Answer with JSON only:
{"verdict": "pass" | "fail" | "unverified", "summary": "one or two plain sentences a developer can act on", "checks": [{"id": "c1", "result": "pass" | "fail" | "unclear", "evidence": "what the screenshot shows", "step": "label of the screenshot"}], "bugs": [{"title": "short", "repro": ["step 1", "step 2"]}]}`,
    },
  ];
  for (const step of input.steps.slice(0, 10)) {
    content.push({ type: "text", text: `Screenshot: ${step.label}` });
    content.push(imagePart(step.file));
  }
  return extractJson(await chat(visionModel, [{ role: "user", content }], "medium")) as Judgement;
}
