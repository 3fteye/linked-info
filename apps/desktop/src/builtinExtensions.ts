import { BuiltInExtensionHost } from "./builtinExtensionHost";
import { builtInJsonInspectorExtension } from "./builtinJsonInspector";

export const builtInExtensionHost = new BuiltInExtensionHost([
  builtInJsonInspectorExtension,
]);
