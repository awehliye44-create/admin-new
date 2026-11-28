/** Offline test/audit-only helpers; not part of Edge uploads. */
import { OnecabAccessRole, sessionRoleAllowsAccess } from "../../../functions/_shared/sessionAccessRoleSSOT.ts";


/** Two sessions of the same Auth user never overwrite each other. */
export function sessionRolesAreIndependent(args: {
  sessionA: { sessionId: string; role: OnecabAccessRole };
  sessionB: { sessionId: string; role: OnecabAccessRole };
}): boolean {
  if (args.sessionA.sessionId === args.sessionB.sessionId) return false;
  return (
    sessionRoleAllowsAccess({
      boundRole: args.sessionA.role,
      requiredRole: "customer",
    }) !==
      sessionRoleAllowsAccess({
        boundRole: args.sessionB.role,
        requiredRole: "customer",
      }) ||
    args.sessionA.role !== args.sessionB.role
  );
}

export * from "../../../functions/_shared/sessionAccessRoleSSOT.ts";
