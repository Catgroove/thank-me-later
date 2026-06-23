// Register the `<spinner>` intrinsic element on the catalogue the reconciler actually reads.
//
// `opentui-spinner/solid` registers via `extend` imported from `@opentui/solid/components`, but that
// subpath module carries its *own* component catalogue, separate from the one the reconciler reads
// (the main `@opentui/solid` entry). So the library's own registration never takes effect. We import
// it for the `<spinner>` JSX type augmentation, then re-register `SpinnerRenderable` on the main
// catalogue ourselves so the element resolves at render time.

import "opentui-spinner/solid"; // type augmentation for the <spinner> intrinsic element
import { extend } from "@opentui/solid";
import { SpinnerRenderable } from "opentui-spinner";

let registered = false;

export function ensureSpinner(): void {
  if (registered) return;
  registered = true;
  extend({ spinner: SpinnerRenderable });
}
