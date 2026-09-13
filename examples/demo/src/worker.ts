import { handle } from "@astrojs/cloudflare/handler";
export { CaretCmsContent } from "@caretcms/cloudflare/durable-object";

export default {
  fetch(request: Request, env: unknown, context: ExecutionContext) {
    return handle(request, env, context);
  },
};
