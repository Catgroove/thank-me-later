// The interaction controller bridges the engine's responders to the TUI drawers. `ask` and
// `approveFindings` each return a Promise and publish an "active prompt" (carrying a `submit`
// callback) through `setPrompt`; the drawer component calls `submit` on a key action, which resolves
// the Promise and clears the prompt. Pure and OpenTUI-free, so the resolution path is unit-testable
// without a terminal: drive it with a `setPrompt` spy, then call the captured `submit`.

import type { ApprovalDecision, ApprovalFindingsInput } from "@tml/core";

export interface AskPrompt {
  readonly kind: "ask";
  readonly prompt: string;
  readonly submit: (text: string) => void;
}

export interface ApprovalPrompt {
  readonly kind: "approval";
  readonly input: ApprovalFindingsInput;
  readonly submit: (decision: ApprovalDecision) => void;
}

export type ActivePrompt = AskPrompt | ApprovalPrompt;

export interface Interactions {
  ask(prompt: string): Promise<string>;
  approveFindings(input: ApprovalFindingsInput): Promise<ApprovalDecision>;
}

export function createInteractions(
  setPrompt: (prompt: ActivePrompt | undefined) => void,
): Interactions {
  return {
    ask(prompt) {
      return new Promise<string>((resolve) => {
        setPrompt({
          kind: "ask",
          prompt,
          submit: (text) => {
            setPrompt(undefined);
            resolve(text);
          },
        });
      });
    },
    approveFindings(input) {
      return new Promise<ApprovalDecision>((resolve) => {
        setPrompt({
          kind: "approval",
          input,
          submit: (decision) => {
            setPrompt(undefined);
            resolve(decision);
          },
        });
      });
    },
  };
}
