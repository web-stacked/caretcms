import { getRequestContext } from "../../../../../packages/core/dist/runtime/request-context.js";

export const prerender = false;
export function GET(context: { cookies: { get(name: string): { value: string } | undefined } }) {
  const active = getRequestContext();
  return Response.json({ previewCookie: context.cookies.get("caret_preview")?.value,
    editor: active?.editor, overlayActive: active?.overlayActive });
}
