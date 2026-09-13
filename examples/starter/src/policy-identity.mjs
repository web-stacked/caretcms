/** Browser-test identity provider. Activated only by CARET_E2E_POLICY=true. */
export function policyIdentityProvider() {
  return {
    async authenticate(request) {
      const role = request.headers.get("x-caret-test-role");
      if (!role || !["writer", "reviewer", "admin"].includes(role)) return null;
      return { id: `${role}_01`, name: `${role[0].toUpperCase()}${role.slice(1)}`, roles: [role] };
    },
    loginUrl() {
      return "/";
    },
    async authorize({ identity, action, collection, id }) {
      const role = identity.roles?.[0];
      if (role === "admin") return true;
      if (role === "reviewer") {
        return action === "edit" || action === "publish" || action === "upload";
      }
      return role === "writer" && action === "edit" &&
        (collection === undefined || collection === "pages") &&
        (id === undefined || id === "home");
    },
  };
}
