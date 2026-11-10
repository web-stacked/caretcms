import { getRequestContext } from "../../../../../packages/core/dist/runtime/request-context.js";

export const prerender = false;
export function GET() {
  const active = getRequestContext();
  return Response.json({ editor: active?.editor, overlayActive: active?.overlayActive });
}
