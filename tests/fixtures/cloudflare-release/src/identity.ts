/**
 * Gate identity: the Worker rejects every request without the gate token
 * (worker.ts), so the editor named in `x-gate-editor` can be trusted here.
 * Granting every action makes the policy active, so each editor's writes are
 * private drafts until published, which the gate exercises on real storage.
 */
export function identity() {
  return {
    async authenticate(request: Request) {
      const id = request.headers.get("x-gate-editor");
      return id ? { id, name: id } : null;
    },
    loginUrl() {
      return "/";
    },
    async authorize() {
      return true;
    },
  };
}
